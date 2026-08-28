import { createHash } from 'node:crypto';
import { GitObjectError, readCommittedBlob } from '../git/object-store.js';
import type { Job } from '../jobs/service.js';
import type { Project, VisualInteraction, VisualQaScenario } from '../projects/service.js';
import { confinedCandidateUrl } from './engine.js';
import { planFixtures, resolveVisualPlan, type VisualQaPlan } from './surfaces.js';

/** Fixed authority path, read from the exact candidate commit rather than its worktree. */
export const VISUAL_QA_CATALOG_PATH = 'packages/core/visualqa.catalog.json';

/** Planning failures are infrastructure/insufficient evidence, never product defects. */
export class VisualQaPlanningError extends Error {}

const BOUNDS = {
  catalogBytes: 256 * 1024,
  changedFiles: 2_000,
  path: 400,
  scenarios: 32,
  matchers: 128,
  matchersPerScenario: 16,
  globalSmoke: 16,
  smokeScenarios: 16,
  interactionsPerScenario: 32,
  selector: 240,
  route: 200,
  value: 400,
  waitMs: 30_000,
  /** Whole-catalog declared wait budget: bounded counts alone still allow hours. */
  declaredMs: 30 * 60_000,
  reasons: 200,
} as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SELECTOR = /^[A-Za-z0-9 _.#:,>+~*^$|=()[\]'"-]{1,240}$/;
const HEAD = /^[0-9a-f]{40}$/;
/** VisualQaEngine's own per-step and selector defaults. */
const ENGINE_DEFAULT_MS = 15_000;
const ENGINE_IDLE_MS = 250;
/** Fixed per-capture navigation and settle cost the engine pays every viewport. */
const ENGINE_CAPTURE_MS = 30_000 + 5_000 + 400;
/**
 * Self UI is "anything under the web app, plus any rendered source file wherever
 * it lives". Scoping to `apps/web/` alone would let a candidate relocate a view
 * -- or a stylesheet the views import -- and shed its evidence duty on the way.
 */
const SELF_WEB_FILE = /^apps\/web\/|\.(?:tsx|jsx|css|scss|html|vue|svelte)$/i;
/**
 * Test-only sources are exempt, but only where "test-only" is unambiguous.
 * Bare `stories/`, `fixtures/` and `mocks/` directory segments are deliberately
 * absent: a real rendered component under `apps/web/src/fixtures/` would
 * otherwise escape mapping entirely. The filename suffixes below still exempt
 * the story/fixture/mock files themselves.
 */
const NOT_RENDERED =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?)(?:\/|$)|\.(?:test|spec|stories?|fixtures?|mocks?|d)\.(?:tsx|jsx|ts|js|mts|cts|mjs|cjs|css|html)$/i;

type MatcherKind = 'exact' | 'prefix' | 'suffix';
type CatalogMatcher = { kind: MatcherKind; value: string };

interface CatalogScenario extends VisualQaScenario {
  matchers: CatalogMatcher[];
}

interface CatalogSmoke {
  matchers: CatalogMatcher[];
  scenarios: string[];
}

interface CandidateCatalog {
  version: 1;
  scenarios: CatalogScenario[];
  globalSmoke: CatalogSmoke[];
}

interface CatalogBlob {
  bytes: Buffer;
  blobSha: string;
  digest: string;
}

const normalise = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
/**
 * Anything shipped in the web app can change what the UI renders, not just
 * the four rendered extensions: hooks.ts and vite.config.ts shape every
 * screen. The catalog must account for each of them or planning fails closed.
 */
const needsMapping = (file: string) => SELF_WEB_FILE.test(file) && !NOT_RENDERED.test(file);

/**
 * The single answer to "is this file self UI?". The pipeline's Visual-QA gate
 * and this planner must agree: a planner that resolves a scenario for a file the
 * pipeline does not consider UI would have its plan silently dropped.
 */
export const isSelfUiFile = (file: string) => SELF_WEB_FILE.test(file);

/**
 * Resolve self-development Visual QA from versioned declarative data committed
 * at the exact candidate HEAD. Jarvis never imports, loads or invokes candidate
 * code to build the plan, and it never reads the candidate worktree: the bytes
 * come out of the repository's content-addressed object store through a
 * parent-built throwaway bare Git directory (see `readCommittedBlob`). No
 * candidate repository or worktree configuration, index, attribute, exclude,
 * hook, filter or replacement ref is an input, because none of them exists in
 * the repository that read runs against.
 */
export async function resolveVisualPlanForCandidate(opts: {
  job: Job;
  project: Project;
  changedFiles: string[];
  /** Paths the candidate removed; a deleted view can never still be mapped. */
  deletedFiles?: string[];
  head: string;
  signal?: AbortSignal;
}): Promise<VisualQaPlan | null> {
  const { job, project, head } = opts;
  if (job.visualQaConfig || !project.config.visualQa || !project.isSelf) {
    return resolveVisualPlan(job, project, opts.changedFiles);
  }
  // Past this point the project is Jarvis itself, so the running parent's own
  // concrete self catalog is stale by construction and must never be reused.
  // Nothing rendered changed means no self evidence, not parent evidence.
  const noSelfEvidence = null;

  if (opts.changedFiles.length > BOUNDS.changedFiles) {
    throw new VisualQaPlanningError('candidate diff exceeds the changed-file bound');
  }
  const files = opts.changedFiles.map(validateChangedFile);
  const webFiles = files.filter((file) => SELF_WEB_FILE.test(file));
  if (webFiles.length === 0 || webFiles.every((file) => NOT_RENDERED.test(file)))
    return noSelfEvidence;
  if (opts.signal?.aborted)
    throw new VisualQaPlanningError('candidate catalog planning was cancelled');

  if (!HEAD.test(head)) throw new VisualQaPlanningError('candidate HEAD is not an exact SHA');
  const blob = readCatalogBlob(project.rootPath, head);
  const catalog = validateCatalog(blob.bytes);
  const deletions = opts.deletedFiles ?? [];
  if (deletions.length > BOUNDS.changedFiles) {
    throw new VisualQaPlanningError('candidate diff exceeds the deleted-file bound');
  }
  const deleted = new Set(deletions.map(validateChangedFile));
  // A removed view must not select its own scenario: the capture would click a
  // surface the candidate no longer has and read as a product defect. It must
  // still select surviving evidence through an explicit global-smoke mapping.
  const mapped = mapCatalog(catalog, files, deleted);
  // Fail closed per file, not per plan: mapping one harmless view while leaving
  // another changed surface unmatched would hide that surface from the evidence.
  const unmapped = files.filter((file) => needsMapping(file) && !mapped.matched.has(file));
  if (unmapped.length > 0) {
    throw new VisualQaPlanningError(
      `the candidate catalog left changed rendered UI unmapped: ${unmapped.slice(0, 10).join(', ')}`,
    );
  }
  if (mapped.scenarios.length === 0) return noSelfEvidence;

  return {
    source: 'changed_surface',
    plannerSource: 'candidate_catalog',
    plannerHead: head,
    catalogVersion: catalog.version,
    catalogBlobSha: blob.blobSha,
    catalogDigest: blob.digest,
    ...(project.config.visualQa.required === undefined
      ? {}
      : { required: project.config.visualQa.required }),
    scenarios: mapped.scenarios,
    reasons: mapped.reasons,
    fixtures: planFixtures(mapped.scenarios),
  };
}

/** Read both catalog identity and bytes solely from Git object storage. */
function readCatalogBlob(repoRoot: string, head: string): CatalogBlob {
  try {
    const { blobSha, bytes } = readCommittedBlob({
      repoRoot,
      commit: head,
      filePath: VISUAL_QA_CATALOG_PATH,
      maxBytes: BOUNDS.catalogBytes,
    });
    return { bytes, blobSha, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (!(error instanceof GitObjectError)) throw error;
    throw new VisualQaPlanningError(`candidate catalog ${error.message}`);
  }
}

export function validateCatalog(raw: Buffer | string): CandidateCatalog {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length > BOUNDS.catalogBytes) return reject('exceeds the byte limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return reject('is malformed JSON');
  }
  const body = object(parsed, 'must be an object');
  exactKeys(body, ['version', 'scenarios', 'globalSmoke'], 'contains unknown top-level fields');
  if (body.version !== 1) return reject(`declares unsupported version ${String(body.version)}`);
  if (!Array.isArray(body.scenarios) || body.scenarios.length > BOUNDS.scenarios) {
    return reject('has an invalid scenario count');
  }
  const names = new Set<string>();
  let matcherCount = 0;
  const scenarios = body.scenarios.map((rawScenario) => {
    const value = object(rawScenario, 'contains a non-object scenario');
    exactKeys(
      value,
      [
        'name',
        'matchers',
        'route',
        'expectedSelector',
        'expectedSelectorTimeoutMs',
        'viewports',
        'interactions',
        'viewportInteractions',
        'fixture',
      ],
      'contains unknown scenario fields',
    );
    if (typeof value.name !== 'string' || !IDENTIFIER.test(value.name) || names.has(value.name)) {
      return reject('contains an invalid or duplicate scenario name');
    }
    names.add(value.name);
    const matchers = validateMatchers(value.matchers);
    matcherCount += matchers.length;
    if (matcherCount > BOUNDS.matchers) return reject('declares too many matchers');
    if (!Array.isArray(value.viewports) || value.viewports.length === 0) {
      return reject('contains invalid viewports');
    }
    const viewports = value.viewports.map((viewport) => {
      if (viewport !== 'desktop' && viewport !== 'mobile')
        return reject('contains invalid viewports');
      return viewport;
    });
    if (new Set(viewports).size !== viewports.length) return reject('contains duplicate viewports');
    const scenario: CatalogScenario = {
      name: value.name,
      matchers,
      route: validateRoute(value.route),
      expectedSelector: validateSelector(value.expectedSelector),
      viewports,
    };
    let interactionCount = 0;
    if (value.interactions !== undefined) {
      scenario.interactions = validateInteractions(value.interactions);
      interactionCount += scenario.interactions.length;
    }
    if (value.viewportInteractions !== undefined) {
      const source = object(value.viewportInteractions, 'contains invalid viewportInteractions');
      exactKeys(source, ['desktop', 'mobile'], 'declares an unknown viewport interaction key');
      const result: Partial<Record<'desktop' | 'mobile', VisualInteraction[]>> = {};
      for (const viewport of ['desktop', 'mobile'] as const) {
        if (source[viewport] !== undefined) {
          result[viewport] = validateInteractions(source[viewport]);
          interactionCount += result[viewport]?.length ?? 0;
        }
      }
      scenario.viewportInteractions = result;
    }
    if (interactionCount > BOUNDS.interactionsPerScenario) {
      return reject('declares too many interactions for one scenario');
    }
    if (value.expectedSelectorTimeoutMs !== undefined) {
      scenario.expectedSelectorTimeoutMs = validateTimeout(value.expectedSelectorTimeoutMs);
    }
    if (value.fixture !== undefined) {
      if (typeof value.fixture !== 'string' || !IDENTIFIER.test(value.fixture)) {
        return reject('declares an invalid fixture identifier');
      }
      scenario.fixture = value.fixture;
    }
    return scenario;
  });

  // Bounded counts alone still allow hours of blocking waits, and every step
  // costs its engine default when the catalog simply omits a timeout.
  const worstCaseMs = scenarios.reduce((total, entry) => total + scenarioWorstCaseMs(entry), 0);
  if (worstCaseMs > BOUNDS.declaredMs) reject('exceeds the catalog waiting-time budget');

  const smokeRaw = body.globalSmoke ?? [];
  if (!Array.isArray(smokeRaw) || smokeRaw.length > BOUNDS.globalSmoke) {
    return reject('has an invalid global-smoke count');
  }
  const globalSmoke = smokeRaw.map((rawSmoke) => {
    const value = object(rawSmoke, 'contains a non-object global-smoke relationship');
    exactKeys(value, ['matchers', 'scenarios'], 'contains unknown global-smoke fields');
    const matchers = validateMatchers(value.matchers);
    matcherCount += matchers.length;
    if (matcherCount > BOUNDS.matchers) return reject('declares too many matchers');
    if (
      !Array.isArray(value.scenarios) ||
      value.scenarios.length === 0 ||
      value.scenarios.length > BOUNDS.smokeScenarios ||
      value.scenarios.some((name) => typeof name !== 'string' || !names.has(name))
    ) {
      return reject('contains an invalid global-smoke scenario reference');
    }
    return { matchers, scenarios: [...new Set(value.scenarios as string[])] };
  });
  return { version: 1, scenarios, globalSmoke };
}

/** Mirrors the waits VisualQaEngine actually performs, defaults included. */
function scenarioWorstCaseMs(scenario: CatalogScenario): number {
  const clamp = (ms: number) => Math.min(Math.max(ms, 0), BOUNDS.waitMs);
  const stepMs = (step: VisualInteraction) =>
    step.action === 'wait'
      ? clamp(step.timeoutMs ?? (step.selector ? ENGINE_DEFAULT_MS : ENGINE_IDLE_MS))
      : ENGINE_DEFAULT_MS;
  return (scenario.viewports ?? ['desktop', 'mobile']).reduce((total, viewport) => {
    const steps = scenario.viewportInteractions?.[viewport] ?? scenario.interactions ?? [];
    return (
      total +
      ENGINE_CAPTURE_MS +
      clamp(scenario.expectedSelectorTimeoutMs ?? ENGINE_DEFAULT_MS) +
      steps.reduce((sum, step) => sum + stepMs(step), 0)
    );
  }, 0);
}

function mapCatalog(
  catalog: CandidateCatalog,
  files: string[],
  deleted = new Set<string>(),
): { scenarios: VisualQaScenario[]; reasons: string[]; matched: Set<string> } {
  const selected = new Map<string, string[]>();
  const matched = new Set<string>();
  let reasonCount = 0;
  // Reasons are audit metadata, not a trust boundary. A legitimately wide UI
  // diff must not fail planning closed just for explaining itself at length, so
  // the ceiling truncates the explanation and keeps the selection intact.
  const add = (name: string, reason: string) => {
    const reasons = selected.get(name) ?? [];
    if (!reasons.includes(reason) && reasonCount < BOUNDS.reasons) {
      reasonCount++;
      reasons.push(reason);
    }
    selected.set(name, reasons);
  };
  for (const file of files) {
    if (!deleted.has(file)) {
      for (const scenario of catalog.scenarios) {
        if (scenario.matchers.some((matcher) => matches(matcher, file))) {
          matched.add(file);
          add(scenario.name, `${file} -> ${scenario.name}`);
        }
      }
    }
    for (const smoke of catalog.globalSmoke) {
      if (!smoke.matchers.some((matcher) => matches(matcher, file))) continue;
      const surviving = deleted.has(file)
        ? smoke.scenarios.filter((name) => {
            const scenario = catalog.scenarios.find((entry) => entry.name === name);
            return !scenario?.matchers.some((matcher) => matches(matcher, file));
          })
        : smoke.scenarios;
      if (surviving.length === 0) continue;
      matched.add(file);
      for (const name of surviving) add(name, `${file} -> ${name} (global UI smoke)`);
    }
  }
  const scenarios = catalog.scenarios
    .filter((scenario) => selected.has(scenario.name))
    .map(({ matchers: _matchers, ...scenario }) => scenario);
  const reasons = scenarios.flatMap((scenario) => selected.get(scenario.name) ?? []);
  if (reasonCount >= BOUNDS.reasons) {
    reasons.push(`mapping reasons truncated at ${BOUNDS.reasons}`);
  }
  return { scenarios, reasons, matched };
}

function matches(matcher: CatalogMatcher, file: string): boolean {
  if (matcher.kind === 'exact') return file === matcher.value;
  if (matcher.kind === 'prefix') return file.startsWith(matcher.value);
  return file.endsWith(matcher.value);
}

function validateMatchers(value: unknown): CatalogMatcher[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BOUNDS.matchersPerScenario) {
    return reject('contains an invalid matcher count');
  }
  return value.map((raw) => {
    const matcher = object(raw, 'contains a non-object matcher');
    const keys = Object.keys(matcher);
    if (keys.length !== 1 || !['exact', 'prefix', 'suffix'].includes(keys[0] ?? '')) {
      return reject('contains an invalid matcher');
    }
    const kind = keys[0] as MatcherKind;
    return { kind, value: validateRelativePath(matcher[kind], 'matcher') };
  });
}

function validateChangedFile(value: string): string {
  return validateRelativePath(value, 'changed file');
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BOUNDS.path) {
    return reject(`contains an invalid ${label}`);
  }
  const result = normalise(value);
  const trimmed = result.endsWith('/') ? result.slice(0, -1) : result;
  if (
    !trimmed ||
    /^[A-Za-z]:/.test(result) ||
    result.startsWith('/') ||
    result.includes('//') ||
    [...result].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    trimmed.split('/').some((part) => part === '.' || part === '..')
  ) {
    return reject(`contains an unsafe ${label}`);
  }
  return result;
}

function validateRoute(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BOUNDS.route) {
    return reject('declares an invalid route');
  }
  try {
    confinedCandidateUrl('http://127.0.0.1:1', value);
  } catch {
    return reject('declares a route outside the candidate origin');
  }
  return value;
}

function validateSelector(value: unknown): string {
  if (typeof value !== 'string' || !SELECTOR.test(value)) {
    return reject('declares an invalid selector');
  }
  return value;
}

function validateTimeout(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > BOUNDS.waitMs) {
    return reject('declares an out-of-range timeout');
  }
  return value as number;
}

function validateInteractions(value: unknown): VisualInteraction[] {
  if (!Array.isArray(value)) return reject('contains a non-array interaction list');
  return value.map((raw) => {
    const step = object(raw, 'contains a non-object interaction');
    if (step.action === 'click') {
      exactKeys(step, ['action', 'selector'], 'contains unknown click fields');
      return { action: 'click', selector: validateSelector(step.selector) };
    }
    if (step.action === 'fill') {
      exactKeys(step, ['action', 'selector', 'value'], 'contains unknown fill fields');
      if (typeof step.value !== 'string' || step.value.length > BOUNDS.value) {
        return reject('declares an invalid fill value');
      }
      return { action: 'fill', selector: validateSelector(step.selector), value: step.value };
    }
    if (step.action === 'wait') {
      exactKeys(step, ['action', 'selector', 'timeoutMs'], 'contains unknown wait fields');
      if (step.selector === undefined && step.timeoutMs === undefined) {
        return reject('declares an empty wait');
      }
      return {
        action: 'wait',
        ...(step.selector === undefined ? {} : { selector: validateSelector(step.selector) }),
        ...(step.timeoutMs === undefined ? {} : { timeoutMs: validateTimeout(step.timeoutMs) }),
      };
    }
    return reject(`declares unknown interaction action ${String(step.action)}`);
  });
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject(message);
}

function reject(message: string): never {
  throw new VisualQaPlanningError(`candidate catalog ${message}`);
}
