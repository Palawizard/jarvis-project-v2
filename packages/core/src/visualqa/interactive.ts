import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { newId } from '../ids.js';
import {
  confineNavigation,
  confinedCandidateUrl,
  isCandidateDevServerNoise,
  isCandidateStreamAbort,
  sealScreenshot,
  type VisualQaShot,
} from './engine.js';

/**
 * Interactive Visual QA: the browser is a Jarvis-owned tool.
 *
 * A model proposes a small batch of actions in this strict versioned DSL; this
 * trusted controller validates every one of them, performs it against the exact
 * candidate runtime, and returns a bounded observation. The model never reaches
 * Playwright, a shell, the filesystem, or any origin but the candidate's.
 */
export const VISUAL_ACTION_SCHEMA_VERSION = 1;

/**
 * The whole cost ceiling for one interactive Visual QA run, and the only place
 * these numbers exist. Every one is finite: a run that exhausts any of them
 * ends as `qa_inconclusive`, never as a silent pass and never as another loop.
 */
export const VISUAL_QA_BUDGET = {
  /**
   * Model decisions per QA attempt.
   *
   * Five, not four, because four was measured to bind. A real desktop+mobile
   * journey on the chat surface -- hover the message, open Edit, cancel it,
   * switch viewport -- spends four turns exploring and then has none left to
   * judge with, so a run that reached every state it needed still ended
   * `qa_inconclusive`. The last turn is now also announced as final.
   */
  modelTurns: 5,
  /** Browser actions across the whole attempt. */
  actions: 20,
  /** Browser actions one model decision may request. */
  actionsPerTurn: 6,
  /** Persisted evidence images per attempt. */
  evidence: 6,
  /** Distinct viewports one attempt may use. */
  viewports: 2,
  /** Fresh QA attempts for an inconclusive/infrastructure result, total. */
  attempts: 2,
  /** Source-repair cycles a product defect may trigger, total. */
  visualFixCycles: 1,
  /** Wall clock for one attempt, browser included. */
  runMs: 6 * 60_000,
} as const;

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export type Viewport = keyof typeof VIEWPORTS;

/**
 * Keyboard keys the model may press. An allowlist rather than a pattern: the
 * useful set for reaching UI state is small, and Playwright's key syntax
 * otherwise accepts chords that belong to the host rather than the page.
 */
export const KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Shift+Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const;

/**
 * Bounded CSS, matching the selector rule the capture engine and the candidate
 * catalog already enforce. Semantic locators are preferred and documented; this
 * exists for the cases where no role or test id reaches the element.
 */
const CSS = /^[A-Za-z0-9 _.#:,>+~*^$|=()[\]'"-]{1,240}$/;
/**
 * Playwright's `locator()` accepts more than CSS: a leading `engine=` prefix
 * selects another selector engine (`xpath=`, `text=`, and the `internal:*`
 * engines), and `>>` chains them. Both are refused, so a "bounded CSS selector"
 * is a CSS selector and not an escape hatch into Playwright's own syntax.
 */
const CSS_ENGINE_ESCAPE = /(?:>>)|^\s*[A-Za-z_:][A-Za-z0-9_:-]*\s*=/;
const boundedCss = (value: string) => CSS.test(value) && !CSS_ENGINE_ESCAPE.test(value);
const TEST_ID = /^[A-Za-z0-9 _.:-]{1,120}$/;
const ROLE = /^[a-z]{1,32}$/;
/** Same-origin absolute path, matching the engine's route rule. */
const ROUTE = /^\/(?!\/)[^\\]{0,199}$/;

const LOCATOR = z.union([
  z.object({ testId: z.string().regex(TEST_ID) }).strict(),
  z.object({ role: z.string().regex(ROLE), name: z.string().min(1).max(200) }).strict(),
  z.object({ text: z.string().min(1).max(200) }).strict(),
  z.object({ css: z.string().refine(boundedCss, 'unbounded CSS selector') }).strict(),
]);

export type Locator = z.infer<typeof LOCATOR>;

export const BROWSER_ACTION = z.union([
  z.object({ action: z.literal('goto'), route: z.string().regex(ROUTE) }).strict(),
  z.object({ action: z.literal('click'), locator: LOCATOR }).strict(),
  z.object({ action: z.literal('hover'), locator: LOCATOR }).strict(),
  z.object({ action: z.literal('fill'), locator: LOCATOR, value: z.string().max(400) }).strict(),
  z.object({ action: z.literal('press'), key: z.enum(KEYS), locator: LOCATOR.optional() }).strict(),
  z
    .object({
      action: z.literal('scroll'),
      direction: z.enum(['up', 'down']),
      amount: z.number().int().min(1).max(4000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      locator: LOCATOR.optional(),
      timeoutMs: z.number().int().min(1).max(15_000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('inspect'), locator: LOCATOR.optional() }).strict(),
  z.object({ action: z.literal('set_viewport'), viewport: z.enum(['desktop', 'mobile']) }).strict(),
  z
    .object({
      action: z.literal('checkpoint'),
      name: z.string().trim().min(1).max(80),
      note: z.string().max(400).optional(),
    })
    .strict(),
  z.object({ action: z.literal('finish') }).strict(),
]);

export type BrowserAction = z.infer<typeof BROWSER_ACTION>;

export const BROWSER_ACTION_BATCH = z.array(BROWSER_ACTION).max(VISUAL_QA_BUDGET.actionsPerTurn);

export interface ActionResult {
  action: BrowserAction['action'];
  detail: string;
  status: 'ok' | 'failed';
  error?: string;
  /** Set for a `checkpoint` that produced persisted evidence. */
  evidenceId?: string;
}

export interface Observation {
  route: string;
  viewport: Viewport;
  /** Sealed image of the CURRENT state, handed to the model for this turn only. */
  screenshotPath: string | null;
  /** Bounded ARIA tree of the visible page. Never the raw DOM. */
  ariaSnapshot: string;
  consoleErrors: string[];
  networkFailures: string[];
  results: ActionResult[];
  /** True once the model asked to finish or a hard budget was reached. */
  done: boolean;
  budget: {
    turnsRemaining: number;
    actionsRemaining: number;
    evidenceRemaining: number;
  };
}

export type PersistEvidence = (input: {
  scenarioName: string;
  route: string;
  viewport: Viewport;
  screenshotPath: string;
  consoleErrors: string[];
  networkFailures: string[];
}) => VisualQaShot;

const ARIA_LIMIT = 6_000;
const LOG_LIMIT = 10;

function locate(page: import('playwright').Page, locator: Locator): import('playwright').Locator {
  if ('testId' in locator) return page.locator(`[data-testid="${locator.testId}"]`).first();
  if ('role' in locator) {
    return page
      .getByRole(locator.role as Parameters<import('playwright').Page['getByRole']>[0], {
        name: locator.name,
      })
      .first();
  }
  if ('text' in locator) return page.getByText(locator.text).first();
  return page.locator(locator.css).first();
}

export function describeLocator(locator: Locator | undefined): string {
  if (!locator) return '';
  if ('testId' in locator) return `testId=${locator.testId}`;
  if ('role' in locator) return `role=${locator.role} name=${locator.name}`;
  if ('text' in locator) return `text=${locator.text}`;
  return `css=${locator.css}`;
}

/**
 * A browser confined to one candidate origin, driven by validated actions.
 *
 * Everything the capture engine enforced still applies: the navigation guard,
 * the candidate control header, screenshot sealing and artifact-root
 * confinement are shared code, not a second implementation.
 */
export class InteractiveVisualQaController {
  private page!: import('playwright').Page;
  private context!: import('playwright').BrowserContext;
  private navigation!: Awaited<ReturnType<typeof confineNavigation>>;
  private browser?: import('playwright').Browser;
  private readonly consoleErrors: string[] = [];
  private readonly networkFailures: string[] = [];
  private recording = true;
  private viewport: Viewport = 'desktop';
  private readonly viewportsUsed = new Set<Viewport>(['desktop']);
  private readonly transient = new Set<string>();
  private readonly now: () => number;

  actionsUsed = 0;
  evidenceUsed = 0;
  readonly evidence: VisualQaShot[] = [];
  /** Checkpoint identities, so a verdict can only cite evidence that exists. */
  readonly checkpoints: Array<{ id: string; name: string; route: string; viewport: Viewport }> = [];

  private constructor(
    private readonly baseUrl: string,
    private readonly outDir: string,
    private readonly persistEvidence: PersistEvidence,
    private readonly deadline: number,
    now: () => number,
  ) {
    this.now = now;
  }

  static async open(opts: {
    baseUrl: string;
    outDir: string;
    persistEvidence: PersistEvidence;
    controlCredential?: string | null;
    /** Candidate dev-server noise is expected only for an isolated runtime. */
    expectedDevServerNoise?: boolean;
    launch?: () => Promise<import('playwright').Browser>;
    now?: () => number;
  }): Promise<InteractiveVisualQaController> {
    const artifactRoot = path.resolve(opts.outDir);
    fs.mkdirSync(artifactRoot, { recursive: true });
    const now = opts.now ?? Date.now;
    const controller = new InteractiveVisualQaController(
      opts.baseUrl,
      artifactRoot,
      opts.persistEvidence,
      now() + VISUAL_QA_BUDGET.runMs,
      now,
    );
    const launch =
      opts.launch ?? (async () => (await import('playwright')).chromium.launch({ headless: true }));
    controller.browser = await launch();
    controller.context = await controller.browser.newContext({
      viewport: VIEWPORTS.desktop,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    controller.page = await controller.context.newPage();
    controller.navigation = await confineNavigation(
      controller.context,
      controller.page,
      new URL(opts.baseUrl).origin,
      opts.controlCredential ?? null,
    );
    controller.instrument(new URL(opts.baseUrl).origin, opts.expectedDevServerNoise === true);
    return controller;
  }

  private instrument(candidateOrigin: string, expectedDevServerNoise: boolean): void {
    this.page.on('console', (msg) => {
      if (!this.recording || msg.type() !== 'error') return;
      const text = msg.text().slice(0, 500);
      if (expectedDevServerNoise && isCandidateDevServerNoise(text, candidateOrigin)) return;
      this.consoleErrors.push(text);
    });
    this.page.on('pageerror', (error) => {
      if (this.recording) this.consoleErrors.push(`uncaught: ${error.message}`.slice(0, 500));
    });
    this.page.on('requestfailed', (request) => {
      if (!this.recording) return;
      const errorText = request.failure()?.errorText ?? 'failed';
      if (
        expectedDevServerNoise &&
        isCandidateStreamAbort(request.url(), errorText, candidateOrigin)
      ) {
        return;
      }
      this.networkFailures.push(
        `${request.method()} ${request.url()} — ${errorText}`.slice(0, 500),
      );
    });
    this.page.on('response', (response) => {
      if (this.recording && response.status() >= 400)
        this.networkFailures.push(`${response.status()} ${response.url()}`.slice(0, 500));
    });
    // A download is never QA evidence and always lands outside the artifact
    // root, so it is refused rather than confined.
    this.page.on('download', (download) => {
      void download.cancel().catch(() => undefined);
      this.networkFailures.push(`download refused: ${download.url().slice(0, 200)}`);
    });
  }

  /** Land on the candidate's entry route before the model's first decision. */
  async start(route: string): Promise<Observation> {
    return this.run([{ action: 'goto', route }], VISUAL_QA_BUDGET.modelTurns);
  }

  /**
   * Execute one validated batch, stopping early on anything the model needs to
   * see before deciding again: a failure, a navigation, a fatal page error, a
   * checkpoint, or an exhausted budget.
   */
  async run(actions: BrowserAction[], turnsRemaining: number): Promise<Observation> {
    const results: ActionResult[] = [];
    const consoleBefore = this.consoleErrors.length;
    const networkBefore = this.networkFailures.length;
    let done = false;
    for (const action of actions) {
      if (this.actionsUsed >= VISUAL_QA_BUDGET.actions) {
        results.push({
          action: action.action,
          detail: '',
          status: 'failed',
          error: 'browser action budget exhausted',
        });
        done = true;
        break;
      }
      if (this.now() > this.deadline) {
        results.push({
          action: action.action,
          detail: '',
          status: 'failed',
          error: 'visual QA time budget exhausted',
        });
        done = true;
        break;
      }
      if (action.action === 'finish') {
        results.push({ action: 'finish', detail: '', status: 'ok' });
        done = true;
        break;
      }
      this.actionsUsed++;
      const routeBefore = this.currentRoute();
      const result = await this.perform(action);
      results.push(result);
      if (result.status === 'failed') break;
      // A navigation, a checkpoint or an uncaught page error changes what the
      // model has to reason about, so it gets a fresh observation before it
      // spends any more of the action budget.
      if (result.evidenceId || this.currentRoute() !== routeBefore) break;
      if (this.consoleErrors.length > consoleBefore && isFatal(this.consoleErrors)) break;
    }
    return this.observe(results, done, turnsRemaining, consoleBefore, networkBefore);
  }

  private async perform(action: BrowserAction): Promise<ActionResult> {
    const detail = 'locator' in action ? describeLocator(action.locator) : '';
    try {
      switch (action.action) {
        case 'goto': {
          const url = confinedCandidateUrl(this.baseUrl, action.route);
          await this.page.goto(url, { waitUntil: 'load', timeout: 30_000 });
          await this.page
            .waitForLoadState('networkidle', { timeout: 5_000 })
            .catch(() => undefined);
          this.navigation.assert();
          return { action: 'goto', detail: action.route, status: 'ok' };
        }
        case 'click':
          await locate(this.page, action.locator).click({ timeout: 10_000 });
          this.navigation.assert();
          return { action: 'click', detail, status: 'ok' };
        case 'hover':
          await locate(this.page, action.locator).hover({ timeout: 10_000 });
          this.navigation.assert();
          return { action: 'hover', detail, status: 'ok' };
        case 'fill':
          await locate(this.page, action.locator).fill(action.value, { timeout: 10_000 });
          this.navigation.assert();
          return { action: 'fill', detail, status: 'ok' };
        case 'press': {
          if (action.locator) {
            await locate(this.page, action.locator).press(action.key, { timeout: 10_000 });
          } else {
            await this.page.keyboard.press(action.key);
          }
          this.navigation.assert();
          return { action: 'press', detail: `${action.key} ${detail}`.trim(), status: 'ok' };
        }
        case 'scroll': {
          const amount = action.amount ?? 600;
          await this.page.mouse.wheel(0, action.direction === 'down' ? amount : -amount);
          await this.page.waitForTimeout(150);
          this.navigation.assert();
          return { action: 'scroll', detail: `${action.direction} ${amount}`, status: 'ok' };
        }
        case 'wait': {
          if (action.locator) {
            await locate(this.page, action.locator).waitFor({
              timeout: action.timeoutMs ?? 10_000,
            });
          } else {
            await this.page.waitForTimeout(Math.min(action.timeoutMs ?? 500, 15_000));
          }
          this.navigation.assert();
          return { action: 'wait', detail, status: 'ok' };
        }
        case 'inspect': {
          const target = action.locator
            ? locate(this.page, action.locator)
            : this.page.locator('body');
          const snapshot = await target.ariaSnapshot({ timeout: 10_000 });
          this.navigation.assert();
          return {
            action: 'inspect',
            detail: `${detail}\n${snapshot}`.slice(0, ARIA_LIMIT),
            status: 'ok',
          };
        }
        case 'set_viewport': {
          if (
            action.viewport !== this.viewport &&
            !this.viewportsUsed.has(action.viewport) &&
            this.viewportsUsed.size >= VISUAL_QA_BUDGET.viewports
          ) {
            return {
              action: 'set_viewport',
              detail: action.viewport,
              status: 'failed',
              error: 'viewport budget exhausted',
            };
          }
          await this.page.setViewportSize(VIEWPORTS[action.viewport]);
          this.viewport = action.viewport;
          this.viewportsUsed.add(action.viewport);
          await this.page.waitForTimeout(200);
          this.navigation.assert();
          return { action: 'set_viewport', detail: action.viewport, status: 'ok' };
        }
        case 'checkpoint':
          return await this.checkpoint(action.name, action.note);
        case 'finish':
          return { action: 'finish', detail: '', status: 'ok' };
      }
    } catch (error) {
      // A confinement violation is never a recoverable action failure: it
      // rethrows out of the run and ends the attempt as infrastructure.
      this.navigation.assert();
      return {
        action: action.action,
        detail,
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
      };
    }
  }

  /** Persist the current state as durable, sealed, exact-HEAD evidence. */
  private async checkpoint(name: string, note?: string): Promise<ActionResult> {
    if (this.evidenceUsed >= VISUAL_QA_BUDGET.evidence) {
      return {
        action: 'checkpoint',
        detail: name,
        status: 'failed',
        error: 'evidence image budget exhausted',
      };
    }
    this.navigation.assert();
    const safe = name.replace(/[^a-z0-9]+/gi, '_') || 'checkpoint';
    const raw = path.join(this.outDir, `${safe}-${this.viewport}-${newId('ckpt')}.png`);
    await this.page.screenshot({ path: raw, fullPage: false });
    this.navigation.assert();
    const sealed = sealScreenshot(raw);
    const route = this.currentRoute();
    const shot = this.persistEvidence({
      scenarioName: name,
      route,
      viewport: this.viewport,
      screenshotPath: sealed,
      consoleErrors: this.consoleErrors.slice(-LOG_LIMIT),
      networkFailures: this.networkFailures.slice(-LOG_LIMIT),
    });
    this.evidenceUsed++;
    this.evidence.push(shot);
    this.checkpoints.push({ id: shot.id, name, route, viewport: this.viewport });
    return {
      action: 'checkpoint',
      detail: note ? `${name}: ${note}` : name,
      status: 'ok',
      evidenceId: shot.id,
    };
  }

  /**
   * The bounded state one model turn sees: a transient screenshot of the
   * CURRENT page and a capped ARIA tree, never an accumulated transcript.
   */
  private async observe(
    results: ActionResult[],
    done: boolean,
    turnsRemaining: number,
    consoleBefore: number,
    networkBefore: number,
  ): Promise<Observation> {
    let ariaSnapshot = '';
    let screenshotPath: string | null = null;
    try {
      this.navigation.assert();
      ariaSnapshot = (await this.page.locator('body').ariaSnapshot({ timeout: 10_000 })).slice(
        0,
        ARIA_LIMIT,
      );
      const raw = path.join(this.outDir, `observation-${this.viewport}-${newId('obs')}.png`);
      await this.page.screenshot({ path: raw, fullPage: false });
      screenshotPath = sealScreenshot(raw);
      this.transient.add(screenshotPath);
    } catch (error) {
      ariaSnapshot = `page could not be observed: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 400);
    }
    return {
      route: this.currentRoute(),
      viewport: this.viewport,
      screenshotPath,
      ariaSnapshot,
      consoleErrors: this.consoleErrors.slice(consoleBefore).slice(0, LOG_LIMIT),
      networkFailures: this.networkFailures.slice(networkBefore).slice(0, LOG_LIMIT),
      results,
      done:
        done ||
        this.actionsUsed >= VISUAL_QA_BUDGET.actions ||
        turnsRemaining <= 0 ||
        this.now() > this.deadline,
      budget: {
        turnsRemaining,
        actionsRemaining: Math.max(0, VISUAL_QA_BUDGET.actions - this.actionsUsed),
        evidenceRemaining: Math.max(0, VISUAL_QA_BUDGET.evidence - this.evidenceUsed),
      },
    };
  }

  private currentRoute(): string {
    try {
      const url = new URL(this.page.url());
      return `${url.pathname}${url.search}`;
    } catch {
      return '(unknown)';
    }
  }

  /** Drop per-turn observation images; only checkpoints are durable evidence. */
  releaseTransient(keep?: string | null): void {
    for (const file of [...this.transient]) {
      if (file === keep) continue;
      fs.rmSync(file, { force: true });
      this.transient.delete(file);
    }
  }

  async close(): Promise<void> {
    this.recording = false;
    await this.context?.close().catch(() => undefined);
    await this.navigation?.settle().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.releaseTransient();
  }
}

/** A page error that makes further exploration this turn pointless. */
function isFatal(consoleErrors: string[]): boolean {
  return consoleErrors.slice(-1).some((entry) => entry.startsWith('uncaught: '));
}
