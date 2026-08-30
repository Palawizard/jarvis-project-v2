import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import type { VisualInteraction, VisualQaScenario } from '../projects/service.js';

const log = createLogger('visual-qa');

export interface VisualQaShot {
  id: string;
  scenarioName: string;
  route: string;
  viewport: 'desktop' | 'mobile';
  screenshotPath: string | null;
  consoleErrors: string[];
  networkFailures: string[];
  status: 'captured' | 'failed';
  error: string | null;
  /** null means "evidence only" — no AI review happened. Never fake this. */
  reviewedBy: string | null;
  reviewVerdict: 'pass' | 'needs_fix' | 'insufficient_evidence' | null;
  reviewFindings: VisualReviewFinding[];
  createdAt: string;
  headRef: string | null;
  cycle: number;
}

/** A captured image is evidence only while its content-addressed filename still matches its bytes. */
export function validateVisualEvidence(
  screenshotPath: string | null,
  artifactsDir?: string,
): boolean {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) return false;
  const resolved = path.resolve(screenshotPath);
  if (artifactsDir) {
    const root = path.resolve(artifactsDir);
    if (resolved === root || !resolved.startsWith(root + path.sep)) return false;
  }
  const expected = /-([0-9a-f]{64})\.png$/i.exec(path.basename(resolved))?.[1]?.toLowerCase();
  if (!expected) return false;
  return createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') === expected;
}

export interface VisualReviewFinding {
  severity: 'high' | 'medium' | 'low' | 'info';
  scenarioName: string;
  route: string;
  viewport: 'desktop' | 'mobile';
  category: string;
  description: string;
  recommendation: string;
}

/**
 * The single dev-server artifact accepted as candidate-runtime noise: the Vite
 * client's own HMR websocket.
 *
 * `server.hmr: false` does not stop it — the Vite 7 client always opens that
 * socket to detect server restarts — and inside the QA browser it is refused by
 * Chrome's local-network-access check. It says nothing about the product, and
 * it distracted the visual reviewer on every candidate capture.
 *
 * Deliberately narrow: it matches only that socket, on the candidate's own
 * origin. API 4xx/5xx, failed application requests, uncaught exceptions and
 * websocket failures to anywhere else are all still recorded.
 */
export function isCandidateDevServerNoise(text: string, candidateOrigin: string): boolean {
  if (/^\[vite\] failed to connect to websocket/.test(text)) return true;
  const socket = /^WebSocket connection to '(ws{1,2}:\/\/[^']+)' failed/.exec(text)?.[1];
  if (!socket) return false;
  try {
    const url = new URL(socket);
    const candidate = new URL(candidateOrigin);
    // Same host and port as the candidate web server, and Vite's token query.
    return url.host === candidate.host && url.searchParams.has('token');
  } catch {
    return false;
  }
}

/**
 * The SSE stream the candidate UI aborts on purpose.
 *
 * React StrictMode double-invokes the event-stream effect in dev, so the first
 * `/api/events` fetch is cancelled by the page's own AbortController; Chrome
 * reports the deliberate cancellation as a failed request. It is the app
 * working correctly, not a failure.
 *
 * Narrow on all four axes: candidate origin, that exact path, that exact error,
 * and candidate runtimes only. A 4xx/5xx on the same endpoint arrives through
 * the response handler and is still recorded.
 */
export function isCandidateStreamAbort(
  url: string,
  errorText: string,
  candidateOrigin: string,
): boolean {
  if (errorText !== 'net::ERR_ABORTED') return false;
  try {
    const target = new URL(url);
    return target.origin === new URL(candidateOrigin).origin && target.pathname === '/api/events';
  } catch {
    return false;
  }
}

/**
 * Marks a failed shot as "the declared surface was never reached" rather than
 * "the product looks wrong". Written only by this engine, never by a model.
 */
export const EVIDENCE_COVERAGE_PREFIX = 'evidence-coverage: ';

export function isEvidenceCoverageFailure(shot: Pick<VisualQaShot, 'status' | 'error'>): boolean {
  return shot.status === 'failed' && (shot.error ?? '').startsWith(EVIDENCE_COVERAGE_PREFIX);
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

type ScreenshotCapture = (page: import('playwright').Page, screenshotPath: string) => Promise<void>;

/**
 * Visual QA evidence capture.
 *
 * Scope note: this captures real evidence (screenshots, console errors, failed
 * requests) and stores it. It does NOT perform AI visual review — `reviewedBy`
 * stays null until a reviewer actually looks at the images, so the UI can never
 * imply a review that did not happen.
 */
export class VisualQaEngine {
  constructor(
    private readonly db: Db,
    private readonly artifactsDir: string,
    private readonly bus?: EventBus,
    private readonly captureScreenshot: ScreenshotCapture = async (page, screenshotPath) => {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    },
  ) {}

  async capture(opts: {
    jobId?: string | null;
    projectId?: string | null;
    baseUrl: string;
    routes: string[];
    scenarios?: VisualQaScenario[];
    viewports?: ('desktop' | 'mobile')[];
    interactions?: VisualInteraction[];
    signal?: AbortSignal;
    headRef?: string | null;
    cycle?: number;
    /**
     * Ephemeral candidate-runtime control credential. Attached as
     * `X-Jarvis-Control` to same-origin candidate requests only.
     */
    controlCredential?: string | null;
    /**
     * True only for an isolated candidate runtime, where the Vite HMR socket is
     * known noise. Never set for a real dev URL.
     */
    expectedDevServerNoise?: boolean;
  }): Promise<VisualQaShot[]> {
    const viewports = opts.viewports ?? ['desktop', 'mobile'];
    const scenarios: VisualQaScenario[] = opts.scenarios?.length
      ? opts.scenarios
      : opts.routes.map((route) => ({ name: route, route, interactions: opts.interactions }));
    this.bus?.emit({
      type: 'visual_qa.started',
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      payload: { baseUrl: opts.baseUrl, scenarios: scenarios.map((scenario) => scenario.name) },
    });

    const artifactRoot = path.resolve(this.artifactsDir);
    const identity = this.artifactIdentity(opts.jobId, opts.projectId);
    const outDir = path.resolve(artifactRoot, identity, 'visual-qa');
    if (outDir !== artifactRoot && !outDir.startsWith(artifactRoot + path.sep)) {
      throw new Error('visual artifact destination escaped the artifact root');
    }
    fs.mkdirSync(outDir, { recursive: true });

    const shots: VisualQaShot[] = [];
    let browser: import('playwright').Browser | undefined;

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });

      for (const scenario of scenarios) {
        for (const viewport of scenario.viewports ?? viewports) {
          if (opts.signal?.aborted) break;
          let shot = await this.captureOnce(browser, opts, scenario, viewport, outDir);
          // A capture that failed because a request never reached the candidate
          // is infrastructure, not evidence about the UI. Every context is cold,
          // so a dev-server candidate re-fetches its whole module graph per
          // scenario; on a loaded machine that exhausts sockets and the app
          // simply never boots, which then surfaces as a selector timeout.
          // Retried exactly once, and only for a resource-level network failure:
          // a real defect fails the same way both times.
          if (shot.status !== 'captured' && isResourceExhaustion(shot) && !opts.signal?.aborted) {
            log.warn('visual QA capture hit a resource-level network failure; retrying once', {
              scenario: scenario.name,
              viewport,
              networkFailures: shot.networkFailures,
            });
            // Durable, because the abandoned row is about to be deleted: without
            // this the evidence trail would claim every capture worked first time.
            this.bus?.emit({
              type: 'visual_qa.retried',
              jobId: opts.jobId ?? null,
              payload: {
                scenario: scenario.name,
                viewport,
                networkFailures: shot.networkFailures,
                consoleErrors: shot.consoleErrors,
              },
            });
            this.remove(shot.id);
            shot = await this.captureOnce(browser, opts, scenario, viewport, outDir);
          }
          shots.push(shot);
        }
      }
    } catch (error) {
      // Playwright missing/broken is an explicit failed state, not a crash.
      const message = error instanceof Error ? error.message : String(error);
      log.warn('visual QA could not start a browser', { error: message });
      const shot = this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route: '(browser launch)',
        scenarioName: '(browser launch)',
        viewport: 'desktop',
        screenshotPath: null,
        consoleErrors: [],
        networkFailures: [],
        status: 'failed',
        error: `Playwright unavailable: ${message}. Run \`pnpm exec playwright install chromium\`.`,
        reviewedBy: null,
        headRef: opts.headRef ?? null,
        cycle: opts.cycle ?? 0,
      });
      shots.push(shot);
    } finally {
      await browser?.close().catch(() => undefined);
    }

    this.bus?.emit({
      type: 'visual_qa.completed',
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      payload: {
        captured: shots.filter((s) => s.status === 'captured').length,
        failed: shots.filter((s) => s.status === 'failed').length,
      },
    });
    return shots;
  }

  private artifactIdentity(jobId?: string | null, projectId?: string | null): string {
    if (jobId) {
      const job = this.db.prepare('SELECT id, project_id FROM jobs WHERE id=?').get(jobId) as
        { id: string; project_id: string } | undefined;
      if (!job) throw new Error('visual QA job does not exist');
      if (projectId && projectId !== job.project_id)
        throw new Error('visual QA job/project mismatch');
      return `job-${stableArtifactId(job.id)}`;
    }
    if (projectId) {
      const project = this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId) as
        { id: string } | undefined;
      if (!project) throw new Error('visual QA project does not exist');
      return `project-${stableArtifactId(project.id)}`;
    }
    return `run-${newId('visual')}`;
  }

  /** One scenario capture in its own fresh, isolated browser context. */
  private async captureOnce(
    browser: import('playwright').Browser,
    opts: Parameters<VisualQaEngine['captureRoute']>[1],
    scenario: Parameters<VisualQaEngine['captureRoute']>[2],
    viewport: Parameters<VisualQaEngine['captureRoute']>[3],
    outDir: string,
  ): Promise<VisualQaShot> {
    const context = await browser.newContext({
      viewport: VIEWPORTS[viewport],
      serviceWorkers: 'block',
    });
    return this.captureRoute(context, opts, scenario, viewport, outDir);
  }

  private async captureRoute(
    context: import('playwright').BrowserContext,
    opts: {
      jobId?: string | null;
      projectId?: string | null;
      baseUrl: string;
      interactions?: VisualInteraction[];
      headRef?: string | null;
      cycle?: number;
      controlCredential?: string | null;
      expectedDevServerNoise?: boolean;
    },
    scenario: VisualQaScenario,
    viewport: 'desktop' | 'mobile',
    outDir: string,
  ): Promise<VisualQaShot> {
    const consoleErrors: string[] = [];
    const networkFailures: string[] = [];
    const screenshotPaths = new Set<string>();
    const page = await context.newPage();
    const navigation = await confineNavigation(
      context,
      page,
      new URL(opts.baseUrl).origin,
      opts.controlCredential ?? null,
    );

    // Once we start tearing the context down, every in-flight request aborts.
    // Recording those would report our own teardown as a product failure.
    let recording = true;
    const candidateOrigin = new URL(opts.baseUrl).origin;
    page.on('console', (msg) => {
      if (!recording || msg.type() !== 'error') return;
      const text = msg.text().slice(0, 500);
      if (opts.expectedDevServerNoise && isCandidateDevServerNoise(text, candidateOrigin)) return;
      consoleErrors.push(text);
    });
    page.on('pageerror', (error) => {
      // An uncaught exception is always a real signal, never classified away.
      if (recording) consoleErrors.push(`uncaught: ${error.message}`.slice(0, 500));
    });
    page.on('requestfailed', (request) => {
      if (!recording) return;
      const errorText = request.failure()?.errorText ?? 'failed';
      if (
        opts.expectedDevServerNoise &&
        isCandidateStreamAbort(request.url(), errorText, candidateOrigin)
      ) {
        return;
      }
      networkFailures.push(`${request.method()} ${request.url()} — ${errorText}`.slice(0, 500));
    });
    page.on('response', (response) => {
      if (recording && response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.url()}`.slice(0, 500));
    });

    const route = scenario.route;
    const url = confinedCandidateUrl(opts.baseUrl, route);
    const safeName = `${scenario.name.replace(/[^a-z0-9]+/gi, '_') || 'scenario'}-${viewport}-${newId('shot')}.png`;
    const screenshotPath = path.join(outDir, safeName);

    try {
      await gotoAndSettle(page, url);
      navigation.assert();
      // Reaching the declared surface is an evidence question, not a product
      // question: tag those failures so no source fixer is ever invoked for one.
      try {
        await runInteractions(
          page,
          opts.baseUrl,
          scenario.viewportInteractions?.[viewport] ??
            scenario.interactions ??
            opts.interactions ??
            [],
          outDir,
          viewport,
          navigation.assert,
          screenshotPaths,
          this.captureScreenshot,
        );
        if (scenario.expectedSelector) {
          await page
            .locator(scenario.expectedSelector)
            .first()
            .waitFor({
              timeout: Math.min(Math.max(scenario.expectedSelectorTimeoutMs ?? 15_000, 1), 30_000),
            });
        }
      } catch (error) {
        navigation.assert();
        throw new Error(
          `${EVIDENCE_COVERAGE_PREFIX}scenario ${scenario.name} did not reach ` +
            `${scenario.expectedSelector ?? 'its declared state'}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      await navigation.settle();
      navigation.assert();
      // Let entry animations settle so screenshots are comparable run to run.
      await page.waitForTimeout(400);
      await navigation.settle();
      navigation.assert();
      screenshotPaths.add(screenshotPath);
      await this.captureScreenshot(page, screenshotPath);
      await navigation.settle();
      navigation.assert();
      recording = false;
      // Closing the whole context stops page timers and popup creation. The
      // route guard remains installed until close and every in-flight callback
      // has settled, so persistence has no navigation-capable race window.
      await context.close();
      await navigation.settle();
      navigation.assert();
      const sealedScreenshotPath = sealScreenshot(screenshotPath);
      screenshotPaths.add(sealedScreenshotPath);
      const shot = this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route,
        scenarioName: scenario.name,
        viewport,
        screenshotPath: sealedScreenshotPath,
        consoleErrors,
        networkFailures,
        status: 'captured',
        error: null,
        reviewedBy: null,
        headRef: opts.headRef ?? null,
        cycle: opts.cycle ?? 0,
      });
      this.bus?.emit({
        type: 'visual_qa.captured',
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
        payload: {
          route,
          scenarioName: scenario.name,
          viewport,
          consoleErrors: consoleErrors.length,
          networkFailures: networkFailures.length,
        },
      });
      return shot;
    } catch (error) {
      await context.close().catch(() => undefined);
      await navigation.settle().catch(() => undefined);
      for (const artifact of screenshotPaths) fs.rmSync(artifact, { force: true });
      return this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route,
        scenarioName: scenario.name,
        viewport,
        screenshotPath: null,
        consoleErrors,
        networkFailures,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        reviewedBy: null,
        headRef: opts.headRef ?? null,
        cycle: opts.cycle ?? 0,
      });
    }
  }

  /**
   * Record that visual QA could not run. An empty screenshot list with no
   * explanation reads as "nothing was wrong"; this makes the failure explicit.
   */
  recordFailure(input: {
    jobId?: string | null;
    projectId?: string | null;
    route: string;
    scenarioName?: string;
    error: string;
    headRef?: string | null;
    cycle?: number;
  }): VisualQaShot {
    return this.persist({
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      route: input.route,
      scenarioName: input.scenarioName ?? input.route,
      viewport: 'desktop',
      screenshotPath: null,
      consoleErrors: [],
      networkFailures: [],
      status: 'failed',
      error: input.error,
      reviewedBy: null,
      headRef: input.headRef ?? null,
      cycle: input.cycle ?? 0,
    });
  }

  /**
   * Drop a superseded capture row.
   *
   * Only ever used for a capture that is about to be retried for a resource-level
   * network failure: leaving it would mean two rows for one scenario/viewport,
   * and the coverage check would still see the failed one.
   */
  private remove(id: string): void {
    this.db.prepare('DELETE FROM visual_qa WHERE id = ?').run(id);
  }

  private persist(
    input: Omit<VisualQaShot, 'id' | 'createdAt' | 'reviewVerdict' | 'reviewFindings'> & {
      jobId: string | null;
      projectId: string | null;
    },
  ): VisualQaShot {
    const shot: VisualQaShot = {
      id: newId('vqa'),
      scenarioName: input.scenarioName,
      route: input.route,
      viewport: input.viewport,
      screenshotPath: input.screenshotPath,
      consoleErrors: input.consoleErrors,
      networkFailures: input.networkFailures,
      status: input.status,
      error: input.error,
      reviewedBy: input.reviewedBy,
      reviewVerdict: null,
      reviewFindings: [],
      createdAt: nowIso(),
      headRef: input.headRef,
      cycle: input.cycle,
    };
    this.db
      .prepare(
        `INSERT INTO visual_qa (id, job_id, project_id, scenario_name, route, viewport,
          screenshot_path, console_errors, network_failures, status, error, reviewed_by, head_ref,
          cycle, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        shot.id,
        input.jobId,
        input.projectId,
        shot.scenarioName,
        shot.route,
        shot.viewport,
        shot.screenshotPath,
        JSON.stringify(shot.consoleErrors),
        JSON.stringify(shot.networkFailures),
        shot.status,
        shot.error,
        shot.reviewedBy,
        shot.headRef,
        shot.cycle,
        shot.createdAt,
      );
    return shot;
  }

  list(jobId: string): VisualQaShot[] {
    const rows = this.db
      .prepare('SELECT * FROM visual_qa WHERE job_id = ? ORDER BY created_at ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      scenarioName: (row.scenario_name as string) ?? 'default',
      route: row.route as string,
      viewport: row.viewport as 'desktop' | 'mobile',
      screenshotPath: (row.screenshot_path as string) ?? null,
      consoleErrors: JSON.parse((row.console_errors as string) || '[]') as string[],
      networkFailures: JSON.parse((row.network_failures as string) || '[]') as string[],
      status: row.status as 'captured' | 'failed',
      error: (row.error as string) ?? null,
      reviewedBy: (row.reviewed_by as string) ?? null,
      reviewVerdict: parseReview(row.review_findings as string | null).verdict,
      reviewFindings: parseReview(row.review_findings as string | null).findings,
      createdAt: row.created_at as string,
      headRef: (row.head_ref as string) ?? null,
      cycle: Number(row.cycle ?? 0),
    }));
  }
}

function parseReview(raw: string | null): {
  verdict: VisualQaShot['reviewVerdict'];
  findings: VisualReviewFinding[];
} {
  if (!raw) return { verdict: null, findings: [] };
  try {
    const value = JSON.parse(raw) as {
      verdict?: VisualQaShot['reviewVerdict'];
      findings?: VisualReviewFinding[];
    };
    return {
      verdict:
        value.verdict === 'pass' ||
        value.verdict === 'needs_fix' ||
        value.verdict === 'insufficient_evidence'
          ? value.verdict
          : null,
      findings: Array.isArray(value.findings) ? value.findings : [],
    };
  } catch {
    return { verdict: null, findings: [] };
  }
}

/**
 * A failure caused by the machine running out of sockets or memory for a
 * request, rather than by anything the candidate rendered.
 *
 * Two properties keep this from ever retrying away a real defect:
 *
 * - The tokens are only ones where the request never left this machine. A reset
 *   connection is deliberately NOT here: the connection was established and then
 *   torn down, which a candidate that crashes mid-response or resets a stream
 *   produces itself, and that is evidence about the candidate.
 * - EVERY recorded entry must match, not merely one. A scenario that failed for
 *   a genuine UI reason and also happens to record one resource error must not
 *   be retried on the strength of the incidental entry, because a retry that
 *   passes would drop detection of an intermittent defect.
 *
 * With no entries at all there is nothing to attribute the failure to, so it is
 * treated as evidence about the candidate and not retried.
 */
const RESOURCE_ERRORS =
  /ERR_NO_BUFFER_SPACE|ERR_INSUFFICIENT_RESOURCES|ERR_NETWORK_CHANGED|ERR_OUT_OF_MEMORY|EMFILE|ENOBUFS|ENFILE/i;

export function isResourceExhaustion(shot: {
  networkFailures?: string[];
  consoleErrors?: string[];
}): boolean {
  const entries = [...(shot.networkFailures ?? []), ...(shot.consoleErrors ?? [])];
  return entries.length > 0 && entries.every((entry) => RESOURCE_ERRORS.test(entry));
}

/**
 * Navigate, then let the network go quiet — best-effort. An authenticated
 * candidate UI holds its SSE event stream open for as long as the page lives,
 * so `waitUntil: 'networkidle'` would time out on every healthy capture.
 */
async function gotoAndSettle(page: import('playwright').Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
}

async function runInteractions(
  page: import('playwright').Page,
  baseUrl: string,
  interactions: VisualInteraction[],
  outDir: string,
  viewport: 'desktop' | 'mobile',
  assertConfined: () => void,
  screenshotPaths: Set<string>,
  captureScreenshot: ScreenshotCapture,
): Promise<void> {
  if (interactions.length > 50) throw new Error('visual interaction script exceeds 50 actions');
  let screenshotIndex = 0;
  for (const step of interactions) {
    switch (step.action) {
      case 'goto':
        await gotoAndSettle(page, confinedCandidateUrl(baseUrl, step.route));
        assertConfined();
        break;
      case 'click':
        await page.locator(step.selector).click({ timeout: 15_000 });
        await page.waitForTimeout(0);
        assertConfined();
        break;
      case 'fill':
        await page.locator(step.selector).fill(step.value, { timeout: 15_000 });
        assertConfined();
        break;
      case 'wait':
        // Floor of 1, not 0: Playwright reads a zero timeout as "wait forever",
        // so the runtime boundary must match the catalog boundary. Job and
        // project configuration reach here too, and neither may hang a capture.
        if (step.selector) {
          await page.locator(step.selector).waitFor({
            timeout: Math.min(Math.max(step.timeoutMs ?? 15_000, 1), 30_000),
          });
        } else {
          await page.waitForTimeout(Math.min(Math.max(step.timeoutMs ?? 250, 1), 30_000));
        }
        assertConfined();
        break;
      case 'screenshot': {
        assertConfined();
        const safeName = (step.name ?? `step-${++screenshotIndex}`).replace(/[^a-z0-9_-]+/gi, '_');
        const screenshotPath = path.join(outDir, `${safeName}-${viewport}-${newId('step')}.png`);
        screenshotPaths.add(screenshotPath);
        await captureScreenshot(page, screenshotPath);
        assertConfined();
        break;
      }
    }
  }
}

/**
 * The candidate control header, for candidate-origin requests only. A
 * context-wide `extraHTTPHeaders` would hand the ephemeral credential to every
 * foreign subresource the page happens to request, so scope it here instead.
 */
export function candidateControlHeader(
  url: string,
  expectedOrigin: string,
  credential: string | null | undefined,
): Record<string, string> | undefined {
  if (!credential) return undefined;
  try {
    if (new URL(url).origin !== expectedOrigin) return undefined;
  } catch {
    return undefined;
  }
  return { 'x-jarvis-control': credential };
}

async function confineNavigation(
  context: import('playwright').BrowserContext,
  page: import('playwright').Page,
  expectedOrigin: string,
  controlCredential: string | null = null,
): Promise<{ assert(): void; settle(): Promise<void> }> {
  let violation: string | null = null;
  const pending = new Set<Promise<void>>();
  const reject = (url: string, kind: string) => {
    violation ??= `${kind} escaped candidate origin: ${url}`.slice(0, 500);
  };
  const controlHeaders = (request: import('playwright').Request) => {
    const control = candidateControlHeader(request.url(), expectedOrigin, controlCredential);
    return control ? { ...request.headers(), ...control } : undefined;
  };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const frameTree = (await cdp.send('Page.getFrameTree')) as {
    frameTree: { frame: { id: string } };
  };
  const mainFrameId = frameTree.frameTree.frame.id;
  cdp.on('Page.frameRequestedNavigation', (event) => {
    const requested = event as { frameId?: string; url?: string };
    if (requested.frameId !== mainFrameId || !requested.url) return;
    try {
      if (new URL(requested.url).origin !== expectedOrigin) {
        reject(requested.url, 'main-frame navigation attempt');
      }
    } catch {
      reject(requested.url, 'invalid main-frame navigation attempt');
    }
  });
  await context.route('**/*', (route) => {
    const task = (async () => {
      const request = route.request();
      let frame: import('playwright').Frame | null = null;
      if (request.isNavigationRequest()) {
        try {
          frame = request.frame();
        } catch {
          // Popup navigation can be routed before Playwright creates its Frame.
        }
      }
      if (request.isNavigationRequest() && (!frame || frame.parentFrame() === null)) {
        const primaryPage = frame?.page() === page;
        try {
          if (new URL(request.url()).origin !== expectedOrigin) {
            reject(request.url(), primaryPage ? 'main-frame navigation' : 'popup navigation');
            await route.abort('blockedbyclient');
            return;
          }
        } catch {
          reject(request.url(), 'invalid navigation');
          await route.abort('blockedbyclient');
          return;
        }
        const navigationHeaders = controlHeaders(request);
        const response = await route.fetch({
          maxRedirects: 0,
          ...(navigationHeaders ? { headers: navigationHeaders } : {}),
        });
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location) {
          let target: string;
          try {
            target = new URL(location, request.url()).toString();
          } catch {
            reject(location, 'invalid redirect');
            await route.abort('blockedbyclient');
            return;
          }
          if (new URL(target).origin !== expectedOrigin) {
            reject(target, primaryPage ? 'main-frame redirect' : 'popup redirect');
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.fulfill({ response });
        return;
      }
      const headers = controlHeaders(request);
      await route.continue(headers ? { headers } : undefined);
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
    try {
      if (new URL(frame.url()).origin !== expectedOrigin) reject(frame.url(), 'main frame');
    } catch {
      reject(frame.url(), 'invalid main frame');
    }
  });
  page.on('popup', (popup) => {
    const inspect = (url: string) => {
      if (url === 'about:blank') return;
      try {
        if (new URL(url).origin !== expectedOrigin) {
          reject(url, 'popup');
          void popup.close().catch(() => undefined);
        }
      } catch {
        reject(url, 'invalid popup');
        void popup.close().catch(() => undefined);
      }
    };
    inspect(popup.url());
    popup.on('framenavigated', (frame) => {
      if (frame === popup.mainFrame()) inspect(frame.url());
    });
  });
  return {
    assert() {
      if (violation) throw new Error(violation);
      const current = page.url();
      if (current !== 'about:blank' && new URL(current).origin !== expectedOrigin) {
        throw new Error(`page escaped candidate origin: ${current}`);
      }
    },
    async settle() {
      for (;;) {
        await Promise.allSettled([...pending]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (pending.size === 0) return;
      }
    },
  };
}

function stableArtifactId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
}

function sealScreenshot(screenshotPath: string): string {
  const digest = createHash('sha256').update(fs.readFileSync(screenshotPath)).digest('hex');
  const sealed = screenshotPath.replace(/\.png$/i, `-${digest}.png`);
  fs.renameSync(screenshotPath, sealed);
  return sealed;
}

export function confinedCandidateUrl(baseUrl: string, route: string): string {
  if (!/^\/(?!\/)/.test(route) || route.includes('\\')) {
    throw new Error(`visual QA route must be a same-origin absolute path: ${route}`);
  }
  const base = new URL(baseUrl);
  const url = new URL(route, base);
  if (url.origin !== base.origin) throw new Error('visual QA route escaped the candidate origin');
  return url.toString();
}
