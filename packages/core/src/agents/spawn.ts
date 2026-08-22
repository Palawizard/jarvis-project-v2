import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { createLogger } from '../logger.js';
import type { ResolvedCli } from './resolve.js';

const log = createLogger('agent-spawn');

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
}

/** Kill a process tree. On Windows a plain kill() orphans grandchildren. */
export function killTree(child: ChildProcess): void {
  if (child.pid && process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
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
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
      windowsHide: true,
    });

    const stderrChunks: string[] = [];
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (outcome: JsonlRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, spec.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      finish({ code: null, timedOut, cancelled, startError: error.message, stderr: stderrChunks.join('') });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      if (stderrChunks.length > 200) stderrChunks.shift();
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        spec.onLine(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // A malformed line is a provider bug, not a job failure.
        log.debug('unparseable stream line', { scope: spec.scope, line: trimmed.slice(0, 200) });
      }
    });

    child.stdin.on('error', () => {
      /* the CLI may close stdin early; not fatal */
    });
    child.stdin.end(spec.stdin);

    child.on('close', (code) => {
      finish({ code, timedOut, cancelled, stderr: stderrChunks.join('').trim().slice(-3000) });
    });
  });
}
