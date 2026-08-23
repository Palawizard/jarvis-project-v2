import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { createLogger } from '../logger.js';
import type { ResolvedCli } from './resolve.js';

const log = createLogger('agent-spawn');

const API_KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/**
 * Jarvis's own control plane. An agent child has no business talking to the
 * orchestrator API — its privileged path is the in-process tool boundary, where
 * `actor: 'agent'` applies. Not handing it the address is defence in depth, not
 * a boundary: the port is guessable and the API is unauthenticated, so an agent
 * determined to reach it still can. See docs/tool-permissions.md.
 */
const CONTROL_PLANE_ENV = ['JARVIS_PORT', 'JARVIS_WEB_PORT', 'JARVIS_RUNTIME_NONCE'] as const;

/** Provider runs must use the CLIs' subscription login, never inherited API billing. */
export function subscriptionProviderEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of [...API_KEY_ENV, ...CONTROL_PLANE_ENV]) delete env[key];
  return env;
}

export interface JsonlRunSpec {
  cli: ResolvedCli;
  args: string[];
  cwd: string;
  /**
   * Prompt is written to stdin rather than passed as an argument.
   * Windows caps a command line at ~32k characters and a review prompt carrying
   * a diff blows straight past that, so argv is not a viable channel.
   */
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine: (event: Record<string, unknown>) => void;
  scope: string;
}

export interface JsonlRunOutcome {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  startError?: string;
  stderr: string;
  malformedLines: number;
  malformedPreview?: string;
}

export function jsonlProtocolError(
  provider: string,
  outcome: Pick<JsonlRunOutcome, 'malformedLines' | 'malformedPreview'>,
  sawTerminal: boolean,
): string | null {
  if (outcome.malformedLines > 0) {
    return `${provider} emitted ${outcome.malformedLines} malformed JSONL line(s)${
      outcome.malformedPreview ? `: ${outcome.malformedPreview}` : ''
    }`;
  }
  return sawTerminal ? null : `${provider} exited without a terminal structured event`;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('close', done);
      resolve(false);
    }, timeoutMs);
    child.once('close', done);
  });
}

/** Kill a detached process tree and wait for bounded TERM -> KILL cleanup. */
export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    await waitForExit(child, 1500);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  if (await waitForExit(child, 1500)) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await waitForExit(child, 500);
}

/**
 * Run a CLI that emits JSON-per-line on stdout, feeding the prompt via stdin.
 * Handles timeout, cancellation and process-tree cleanup uniformly for every
 * provider so no adapter reinvents it.
 */
export function runJsonlProcess(spec: JsonlRunSpec): Promise<JsonlRunOutcome> {
  return new Promise<JsonlRunOutcome>((resolve) => {
    const child = spawn(spec.cli.command, [...spec.cli.prefixArgs, ...spec.args], {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subscriptionProviderEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const stderrChunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let malformedLines = 0;
    let malformedPreview: string | undefined;

    const protocolFields = () => ({
      malformedLines,
      ...(malformedPreview ? { malformedPreview } : {}),
    });

    const finish = (outcome: JsonlRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, spec.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      void killTree(child);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      finish({
        code: null,
        timedOut,
        cancelled,
        startError: error.message,
        stderr: stderrChunks.join(''),
        ...protocolFields(),
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      if (stderrChunks.length > 200) stderrChunks.shift();
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        spec.onLine(parsed as Record<string, unknown>);
      } catch {
        malformedLines += 1;
        malformedPreview ??= trimmed.slice(0, 200);
        log.debug('unparseable stream line', { scope: spec.scope, line: trimmed.slice(0, 200) });
      }
    });

    child.stdin.on('error', () => {
      /* the CLI may close stdin early; not fatal */
    });
    child.stdin.end(spec.stdin);

    child.on('close', (code) => {
      finish({
        code,
        timedOut,
        cancelled,
        stderr: stderrChunks.join('').trim().slice(-3000),
        ...protocolFields(),
      });
    });
  });
}
