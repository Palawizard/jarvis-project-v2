import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';

/**
 * One Jarvis orchestrator per test.
 *
 * Every test gets its own JARVIS_HOME, its own database and its own port, so
 * deterministic fixtures cannot accumulate across tests, `--repeat-each`
 * repetitions, retries or workers, and test order cannot matter. Isolation is
 * process-level rather than a reset endpoint: there is no test-only
 * data-deletion surface in the product, and start-server.mjs refuses any home
 * outside `.jarvis/e2e`, so a real Jarvis home can never be reached.
 */

const WORKSPACE = process.cwd();
const E2E_ROOT = path.resolve(WORKSPACE, '.jarvis/e2e');
const CONTROL_KEY = 'jarvis-human-control';

export interface JarvisRuntime {
  /** `http://127.0.0.1:<port>` — this test's orchestrator, and nothing else. */
  origin: string;
  /** The paired browser control credential for this runtime. */
  control: string;
  home: string;
  /** Non-null once the orchestrator process is gone, explaining how it died. */
  death(): string | null;
  /** Assert the API is reachable *and* is this test's own orchestrator. */
  assertAlive(): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    // The orchestrator may own job children (agents, verification); kill the tree.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
  return gone;
}

/**
 * Remove any git worktree this runtime created, so an E2E run leaves no
 * registration or branch behind in the real repository.
 */
function releaseWorktrees(home: string): void {
  const dir = path.join(home, 'worktrees');
  // Synchronous on purpose. These were fire-and-forget spawns, which raced the
  // rmSync below: on Windows the still-running `git worktree remove` holds
  // handles inside `home`, so teardown failed with EBUSY -- and, worse, the
  // suite could move on before a worktree and its branch were really gone.
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: WORKSPACE, stdio: 'ignore', windowsHide: true });
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    run(['worktree', 'remove', '--force', path.join(dir, entry)]);
    run(['branch', '-D', `jarvis/${entry}`]);
  }
  run(['worktree', 'prune']);
}

export async function bootRuntime(id: string): Promise<JarvisRuntime> {
  const home = path.join(E2E_ROOT, 'runtimes', id);
  const port = await freePort();
  const nonce = randomUUID();
  const origin = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['tests/e2e/start-server.mjs'], {
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      JARVIS_HOME: home,
      JARVIS_PORT: String(port),
      JARVIS_RUNTIME_NONCE: nonce,
      JARVIS_EMBEDDINGS: 'off',
      // Deterministic conversation without spending subscription quota: the
      // fake speaks the real stream-json protocol, and Codex is pointed at a
      // path that does not exist so it reports itself unavailable.
      JARVIS_CLAUDE_BIN: path.resolve(WORKSPACE, 'tests/e2e/fake-claude.js'),
      JARVIS_CODEX_BIN: path.resolve(E2E_ROOT, '__no_codex__/codex.exe'),
    },
  });

  let log = '';
  const collect = (chunk: Buffer) => {
    log = `${log}${chunk.toString()}`.slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let death: string | null = null;
  child.on('exit', (code, signal) => {
    death ??= `the Jarvis orchestrator exited (code ${code}, signal ${signal}).\n${log}`;
  });

  const probe = async (): Promise<string | null> => {
    const response = await fetch(`${origin}/health`).catch(() => null);
    if (!response?.ok) return 'the Jarvis API did not answer /health';
    const body = (await response.json()) as { status: string; runtimeNonce: string | null };
    if (body.runtimeNonce !== nonce) return `${origin} is served by a foreign Jarvis orchestrator`;
    return body.status === 'ok' ? null : `the Jarvis API reports status "${body.status}"`;
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (death) throw new Error(`Jarvis orchestrator failed to start: ${death}`);
    if ((await probe()) === null) break;
    if (Date.now() > deadline) {
      await terminate(child);
      throw new Error(`Jarvis orchestrator was not ready within 60s.\n${log}`);
    }
    await delay(100);
  }

  const { credential } = JSON.parse(
    fs.readFileSync(path.join(home, 'e2e-control.json'), 'utf8'),
  ) as { credential: string };

  return {
    origin,
    control: credential,
    home,
    death: () => death,
    async assertAlive() {
      const problem = death ?? (await probe());
      expect(problem, 'the Jarvis orchestrator must be reachable').toBeNull();
    },
    async stop() {
      // Terminate first: the exit handler records how the process actually
      // died, which is what a lifecycle failure needs to report.
      await terminate(child);
      death ??= 'the Jarvis orchestrator was stopped by the test harness';
      releaseWorktrees(home);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export interface App {
  origin: string;
  control: string;
  /** Check the API is really up, then open the SPA at `route`. */
  open(route?: string): Promise<void>;
}

export const test = base.extend<{ jarvis: JarvisRuntime; app: App }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the pattern.
  jarvis: async ({}, use, testInfo) => {
    const id = `${testInfo.workerIndex}-${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
    const runtime = await bootRuntime(id);
    try {
      await use(runtime);
      // A missing chat-view is a symptom; a dead API is the cause. Say which.
      expect(runtime.death(), 'the Jarvis orchestrator must survive the whole test').toBeNull();
      const jobs = (await fetch(`${runtime.origin}/api/jobs?archived=all`, {
        headers: { 'x-jarvis-control': runtime.control },
      }).then((response) => response.json())) as Array<{ id: string; status: string }>;
      expect(
        jobs.filter((job) => job.status === 'running').map((job) => job.id),
        'no Job may still be running when a test ends: it would keep building, verifying ' +
          'and spawning processes underneath the rest of the suite',
      ).toEqual([]);
    } finally {
      await runtime.stop();
    }
  },

  app: async ({ jarvis, page }, use) => {
    await use({
      origin: jarvis.origin,
      control: jarvis.control,
      async open(route = '/') {
        await jarvis.assertAlive();
        await page.goto(route);
      },
    });
  },

  baseURL: async ({ jarvis }, use) => {
    await use(jarvis.origin);
  },

  storageState: async ({ jarvis }, use) => {
    await use({
      cookies: [],
      origins: [
        { origin: jarvis.origin, localStorage: [{ name: CONTROL_KEY, value: jarvis.control }] },
      ],
    });
  },
});

export { expect } from '@playwright/test';

export const headers = (control: string) => ({ 'x-jarvis-control': control });
export const mutation = (app: App) => ({ ...headers(app.control), origin: app.origin });

/** The credential the browser actually holds, proving the pairing survived. */
export async function credential(page: Page): Promise<string> {
  const value = await page.evaluate((key) => localStorage.getItem(key), CONTROL_KEY);
  expect(value).toBeTruthy();
  if (!value) throw new Error('paired browser credential missing');
  return value;
}
