import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { JarvisConfig } from '../config.js';
import { killTree } from '../agents/spawn.js';
import { repoStatus } from '../git/workspace.js';
import type { Project } from '../projects/service.js';

export class CandidateRuntimeUnsupportedError extends Error {}

export interface CandidateRuntime {
  baseUrl: string;
  healthUrl: string;
  home: string;
  ports: { web: number; api?: number };
  logs: string[];
  stop(): Promise<void>;
}

/** Launch a candidate with isolated state and dynamically allocated ports. */
export async function startCandidateRuntime(opts: {
  project: Project;
  cwd: string;
  jobId: string;
  config: JarvisConfig;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CandidateRuntime> {
  const runtime = opts.project.config.candidateRuntime;
  if (!runtime) {
    throw new CandidateRuntimeUnsupportedError('candidate runtime isolation unsupported');
  }
  validateRuntimeConfig(runtime.command.executable, runtime.command.args);

  const webReservation = await reservePort();
  const apiReservation = runtime.apiPortEnvironment ? await reservePort() : undefined;
  const home = path.join(opts.config.home, 'candidate-runtimes', opts.jobId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const web = webReservation.port;
  const api = apiReservation?.port;
  const runtimeNonce = randomUUID();
  const baseUrl = `http://127.0.0.1:${web}`;
  const healthUrl = `http://127.0.0.1:${api ?? web}${runtime.healthPath ?? '/'}`;
  const env = {
    ...process.env,
    JARVIS_HOME: home,
    JARVIS_RUNTIME_NONCE: runtimeNonce,
    FORCE_COLOR: '0',
    BROWSER: 'none',
    [runtime.portEnvironment]: String(web),
    ...(runtime.apiPortEnvironment && api
      ? {
          [runtime.apiPortEnvironment]: String(api),
          JARVIS_API: `http://127.0.0.1:${api}`,
        }
      : {}),
  };
  for (const key of [
    'JARVIS_SUPERVISED',
    'JARVIS_UPGRADE_REQUEST_PATH',
    'JARVIS_COMMIT',
    'JARVIS_BOOTSTRAP_TOKEN',
    'JARVIS_CONTROL_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
  ]) {
    delete env[key];
  }

  // Generic frameworks cannot inherit our listening socket. Hold both ports
  // until the last moment, then launch and verify the exact health URL.
  await apiReservation?.release();
  await webReservation.release();

  const executable =
    process.platform === 'win32' && runtime.command.executable === 'pnpm'
      ? 'pnpm.cmd'
      : runtime.command.executable;
  const child = spawn(executable, runtime.command.args, {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    // Windows requires a shell for .cmd shims. The executable/argv are trusted,
    // persisted project configuration; dynamic ports are never interpolated.
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable),
  });
  const logs: string[] = [];
  const capture = (chunk: Buffer) => {
    logs.push(chunk.toString());
    if (logs.length > 200) logs.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      await killTree(child);
      const ownedPorts = [web, ...(api ? [api] : [])];
      if (!(await waitForPortsClosed(ownedPorts, 3_000))) {
        throw new Error(
          `candidate runtime ports remain reachable after stop: ${ownedPorts.join(', ')}`,
        );
      }
    })());
  const terminated = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
  );

  // One budget covers the whole startup: health identity first, then the web
  // listener Visual QA actually opens. The API can be healthy minutes before
  // the frontend binds, so returning on health alone hands out a dead baseUrl.
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const expectedCommit = opts.project.isSelf ? (await repoStatus(opts.cwd)).head : null;
    if (opts.project.isSelf && !expectedCommit) {
      throw new Error('candidate runtime commit identity is unavailable');
    }
    const waiting = {
      logs,
      deadline,
      exited: () =>
        child.exitCode !== null || child.signalCode !== null
          ? { code: child.exitCode, signal: child.signalCode }
          : null,
      terminated,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    await waitUntilReady({
      ...waiting,
      probe: () =>
        probeHealth(
          healthUrl,
          opts.project.isSelf ? { runtimeNonce, commit: expectedCommit as string } : undefined,
        ),
      failure: `candidate runtime did not pass healthcheck at ${healthUrl}`,
    });
    await waitUntilReady({
      ...waiting,
      probe: () => probeWeb(baseUrl),
      failure: `candidate API is healthy but web frontend did not become ready at ${baseUrl}`,
    });
    return {
      baseUrl,
      healthUrl,
      home,
      ports: { web, ...(api ? { api } : {}) },
      logs,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function reservePort(): Promise<{ port: number; release(): Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a local port');
  let released = false;
  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve, reject) => {
        if (released) return resolve();
        released = true;
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Poll a readiness probe until it passes, the child dies, or the budget ends. */
async function waitUntilReady(opts: {
  probe: () => Promise<boolean>;
  failure: string;
  logs: string[];
  deadline: number;
  exited: () => { code: number | null; signal: NodeJS.Signals | null } | null;
  terminated: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal?: AbortSignal;
}): Promise<void> {
  const tail = () => opts.logs.join('').slice(-2000);
  const exited = (exit: { code: number | null; signal: NodeJS.Signals | null }) =>
    new Error(`candidate runtime exited (${exit.code ?? exit.signal}):\n${tail()}`);
  const assertActive = () => {
    if (opts.signal?.aborted) throw new Error('candidate runtime start cancelled');
    const exit = opts.exited();
    if (exit) throw exited(exit);
  };
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<'cancelled'>((resolve) => {
    if (!opts.signal) return;
    onAbort = () => resolve('cancelled');
    opts.signal.addEventListener('abort', onAbort, { once: true });
  });
  const termination = opts.terminated.then((exit) => ({ type: 'exit' as const, exit }));
  const interruptible = async <T>(work: Promise<T>): Promise<T> => {
    const result = await Promise.race([
      termination,
      cancelled.then(() => ({ type: 'cancelled' as const })),
      work.then((value) => ({ type: 'value' as const, value })),
    ]);
    if (result.type === 'exit') throw exited(result.exit);
    if (result.type === 'cancelled') throw new Error('candidate runtime start cancelled');
    return result.value;
  };
  try {
    while (Date.now() < opts.deadline) {
      assertActive();
      if (await interruptible(opts.probe())) {
        // Let pending child-process events run before the final active check.
        await interruptible(new Promise<void>((resolve) => setImmediate(resolve)));
        assertActive();
        if (Date.now() < opts.deadline) return;
        break;
      }
      await interruptible(new Promise((resolve) => setTimeout(resolve, 250)));
    }
    assertActive();
    throw new Error(`${opts.failure}:\n${tail()}`);
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function probeHealth(
  url: string,
  identity?: { runtimeNonce: string; commit: string },
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as {
      status?: string;
      ok?: boolean;
      runtimeNonce?: string;
      commit?: string;
    };
    const healthy = body?.status === 'ok' || body?.ok === true;
    const identified =
      !identity ||
      (body?.runtimeNonce === identity.runtimeNonce && body?.commit === identity.commit);
    return healthy && identified;
  } catch {
    return false; // Still starting.
  }
}

/** Consume the complete response and accept only a successful final status. */
async function probeWeb(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false; // Still starting.
  }
}

function validateRuntimeConfig(executable: string, args: string[]): void {
  if (!executable.trim() || /[\r\n\0]/.test(executable))
    throw new Error('invalid runtime executable');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) {
    throw new Error('invalid runtime arguments');
  }
}

async function waitForPortsClosed(ports: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(portIsClosed))).every(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await Promise.all(ports.map(portIsClosed))).every(Boolean);
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(250, () => done(true));
    socket.once('connect', () => done(false));
    socket.once('error', () => done(true));
  });
}
