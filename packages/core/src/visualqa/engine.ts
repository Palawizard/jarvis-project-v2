import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import { killTree } from '../agents/spawn.js';
import type { VisualInteraction } from '../projects/service.js';

const log = createLogger('visual-qa');

export interface VisualQaShot {
  id: string;
  route: string;
  viewport: 'desktop' | 'mobile';
  screenshotPath: string | null;
  consoleErrors: string[];
  networkFailures: string[];
  status: 'captured' | 'failed';
  error: string | null;
  /** null means "evidence only" — no AI review happened. Never fake this. */
  reviewedBy: string | null;
  reviewVerdict: 'pass' | 'needs_fix' | null;
  reviewFindings: VisualReviewFinding[];
  createdAt: string;
}

export interface VisualReviewFinding {
  severity: 'high' | 'medium' | 'low' | 'info';
  route: string;
  viewport: 'desktop' | 'mobile';
  category: string;
  description: string;
  recommendation: string;
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

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
  ) {}

  async capture(opts: {
    jobId?: string | null;
    projectId?: string | null;
    baseUrl: string;
    routes: string[];
    viewports?: ('desktop' | 'mobile')[];
    interactions?: VisualInteraction[];
    signal?: AbortSignal;
  }): Promise<VisualQaShot[]> {
    const viewports = opts.viewports ?? ['desktop', 'mobile'];
    this.bus?.emit({
      type: 'visual_qa.started',
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      payload: { baseUrl: opts.baseUrl, routes: opts.routes, viewports },
    });

    const outDir = path.join(
      this.artifactsDir,
      opts.jobId ?? opts.projectId ?? 'adhoc',
      'visual-qa',
    );
    fs.mkdirSync(outDir, { recursive: true });

    const shots: VisualQaShot[] = [];
    let browser: import('playwright').Browser | undefined;

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });

      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport: VIEWPORTS[viewport] });
        for (const route of opts.routes) {
          if (opts.signal?.aborted) break;
          shots.push(await this.captureRoute(context, opts, route, viewport, outDir));
        }
        await context.close();
      }
    } catch (error) {
      // Playwright missing/broken is an explicit failed state, not a crash.
      const message = error instanceof Error ? error.message : String(error);
      log.warn('visual QA could not start a browser', { error: message });
      const shot = this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route: '(browser launch)',
        viewport: 'desktop',
        screenshotPath: null,
        consoleErrors: [],
        networkFailures: [],
        status: 'failed',
        error: `Playwright unavailable: ${message}. Run \`pnpm exec playwright install chromium\`.`,
        reviewedBy: null,
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

  private async captureRoute(
    context: import('playwright').BrowserContext,
    opts: {
      jobId?: string | null;
      projectId?: string | null;
      baseUrl: string;
      interactions?: VisualInteraction[];
    },
    route: string,
    viewport: 'desktop' | 'mobile',
    outDir: string,
  ): Promise<VisualQaShot> {
    const consoleErrors: string[] = [];
    const networkFailures: string[] = [];
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`.slice(0, 500)));
    page.on('requestfailed', (request) => {
      networkFailures.push(
        `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`.slice(
          0,
          500,
        ),
      );
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.url()}`.slice(0, 500));
    });

    const url = new URL(route, opts.baseUrl).toString();
    const safeName = `${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}-${viewport}-${newId('shot')}.png`;
    const screenshotPath = path.join(outDir, safeName);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      await runInteractions(page, opts.baseUrl, opts.interactions ?? [], outDir, viewport);
      // Let entry animations settle so screenshots are comparable run to run.
      await page.waitForTimeout(400);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await page.close();
      const shot = this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route,
        viewport,
        screenshotPath,
        consoleErrors,
        networkFailures,
        status: 'captured',
        error: null,
        reviewedBy: null,
      });
      this.bus?.emit({
        type: 'visual_qa.captured',
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
        payload: {
          route,
          viewport,
          consoleErrors: consoleErrors.length,
          networkFailures: networkFailures.length,
        },
      });
      return shot;
    } catch (error) {
      await page.close().catch(() => undefined);
      return this.persist({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        route,
        viewport,
        screenshotPath: null,
        consoleErrors,
        networkFailures,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        reviewedBy: null,
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
    error: string;
  }): VisualQaShot {
    return this.persist({
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      route: input.route,
      viewport: 'desktop',
      screenshotPath: null,
      consoleErrors: [],
      networkFailures: [],
      status: 'failed',
      error: input.error,
      reviewedBy: null,
    });
  }

  private persist(
    input: Omit<VisualQaShot, 'id' | 'createdAt' | 'reviewVerdict' | 'reviewFindings'> & {
      jobId: string | null;
      projectId: string | null;
    },
  ): VisualQaShot {
    const shot: VisualQaShot = {
      id: newId('vqa'),
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
    };
    this.db
      .prepare(
        `INSERT INTO visual_qa (id, job_id, project_id, route, viewport, screenshot_path, console_errors,
          network_failures, status, error, reviewed_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        shot.id,
        input.jobId,
        input.projectId,
        shot.route,
        shot.viewport,
        shot.screenshotPath,
        JSON.stringify(shot.consoleErrors),
        JSON.stringify(shot.networkFailures),
        shot.status,
        shot.error,
        shot.reviewedBy,
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
      verdict: value.verdict === 'pass' || value.verdict === 'needs_fix' ? value.verdict : null,
      findings: Array.isArray(value.findings) ? value.findings : [],
    };
  } catch {
    return { verdict: null, findings: [] };
  }
}

async function runInteractions(
  page: import('playwright').Page,
  baseUrl: string,
  interactions: VisualInteraction[],
  outDir: string,
  viewport: 'desktop' | 'mobile',
): Promise<void> {
  if (interactions.length > 50) throw new Error('visual interaction script exceeds 50 actions');
  let screenshotIndex = 0;
  for (const step of interactions) {
    switch (step.action) {
      case 'goto':
        await page.goto(new URL(step.route, baseUrl).toString(), {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        break;
      case 'click':
        await page.locator(step.selector).click({ timeout: 15_000 });
        break;
      case 'fill':
        await page.locator(step.selector).fill(step.value, { timeout: 15_000 });
        break;
      case 'wait':
        if (step.selector) {
          await page.locator(step.selector).waitFor({
            timeout: Math.min(Math.max(step.timeoutMs ?? 15_000, 0), 30_000),
          });
        } else {
          await page.waitForTimeout(Math.min(Math.max(step.timeoutMs ?? 250, 0), 30_000));
        }
        break;
      case 'screenshot': {
        const safeName = (step.name ?? `step-${++screenshotIndex}`).replace(/[^a-z0-9_-]+/gi, '_');
        await page.screenshot({
          path: path.join(outDir, `${safeName}-${viewport}.png`),
          fullPage: true,
        });
        break;
      }
    }
  }
}

/**
 * Start a project's dev server and wait until it actually answers.
 *
 * Returns a stop() that kills the whole process tree — a leaked dev server would
 * hold the port and silently break every later visual QA run.
 */
export async function startDevServer(opts: {
  command: string;
  cwd: string;
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ stop: () => Promise<void>; url: string; logs: string[] }> {
  if (opts.signal?.aborted) throw new Error('dev server start cancelled');
  try {
    await fetch(opts.url, { signal: AbortSignal.timeout(1000) });
    throw new Error(
      `dev URL ${opts.url} was already reachable before candidate startup; refusing to capture the wrong application`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('already reachable')) throw error;
    // Expected: the candidate URL must be free before its process starts.
  }

  const logs: string[] = [];
  const child: ChildProcess = spawn(opts.command, {
    cwd: opts.cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const capture = (chunk: Buffer) => {
    logs.push(chunk.toString());
    if (logs.length > 200) logs.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const stop = async () => {
    await killTree(child);
  };

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      await stop();
      throw new Error('dev server start cancelled');
    }
    if (exited) {
      throw new Error(
        `dev server exited before becoming reachable:\n${logs.join('').slice(-2000)}`,
      );
    }
    try {
      const response = await fetch(opts.url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return { stop, url: opts.url, logs };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(
    `dev server did not become reachable at ${opts.url}:\n${logs.join('').slice(-2000)}`,
  );
}
