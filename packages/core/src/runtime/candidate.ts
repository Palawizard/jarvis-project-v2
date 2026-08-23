import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { JarvisConfig } from '../config.js';
import { killTree } from '../agents/spawn.js';
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
  const baseUrl = `http://127.0.0.1:${web}`;
  const healthUrl = `http://127.0.0.1:${api ?? web}${runtime.healthPath ?? '/'}`;
  const env = {
    ...process.env,
    JARVIS_HOME: home,
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
  const stop = () => killTree(child);

  try {
    await waitForHealth(child, healthUrl, logs, opts.signal, opts.timeoutMs ?? 90_000);
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

async function waitForHealth(
  child: ChildProcess,
  url: string,
  logs: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('candidate runtime start cancelled');
    if (exitCode !== null) {
      throw new Error(`candidate runtime exited (${exitCode}):\n${logs.join('').slice(-2000)}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { status?: string; ok?: boolean };
        if (body?.status === 'ok' || body?.ok === true) return;
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `candidate runtime did not pass healthcheck at ${url}:\n${logs.join('').slice(-2000)}`,
  );
}

function validateRuntimeConfig(executable: string, args: string[]): void {
  if (!executable.trim() || /[\r\n\0]/.test(executable))
    throw new Error('invalid runtime executable');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) {
    throw new Error('invalid runtime arguments');
  }
}
