import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createLogger } from '../logger.js';
import type { ResolvedCli } from './resolve.js';

const log = createLogger('agent-spawn');

const WINDOWS_JOB_RUNNER =
  process.platform === 'win32'
    ? Buffer.from(
        fs.readFileSync(
          path.resolve(import.meta.dirname, '../../../../scripts/windows-job-runner.ps1'),
          'utf8',
        ),
        'utf16le',
      ).toString('base64')
    : '';

/**
 * Jarvis's own control plane. An agent child has no business talking to the
 * orchestrator API — its privileged path is the in-process tool boundary, where
 * `actor: 'agent'` applies. Not handing it the address is defence in depth, not
 * a boundary: the authenticated browser capability and exact mutation Origin
 * remain the actual control-plane boundary. See docs/tool-permissions.md.
 */
const CONTROL_PLANE_ENV = [
  'JARVIS_HOME',
  'JARVIS_PORT',
  'JARVIS_WEB_PORT',
  'JARVIS_RUNTIME_NONCE',
  'JARVIS_CANDIDATE_RUNTIME',
  'JARVIS_SUPERVISED',
  'JARVIS_SUPERVISOR_CONFIG',
  'JARVIS_UPGRADE_REQUEST_PATH',
  'JARVIS_UPGRADE_SOCKET',
  'JARVIS_UPGRADE_TOKEN_HASH',
  'JARVIS_BOOTSTRAP_TOKEN',
  'JARVIS_CONTROL_TOKEN',
] as const;

const UNTRUSTED_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NPM_CONFIG_USERCONFIG',
] as const;

const SECRET_ENV_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_KEY|PRIVATE_KEY)(?:_|$)/i;

/** Minimal platform environment for candidate-controlled commands and runtimes. */
export function untrustedProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of UNTRUSTED_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/**
 * Start untrusted work in a Windows Job Object before its first instruction.
 * The wrapper remains alive until the leader exits and every descendant has
 * been terminated; on other platforms the detached process group is enough.
 */
export function spawnContained(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: StdioOptions;
    shell?: boolean;
  },
): ChildProcess {
  if (process.platform !== 'win32') {
    return spawn(executable, args, {
      ...options,
      shell: options.shell ?? false,
      windowsHide: true,
      detached: true,
    });
  }
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const stdio = Array.isArray(options.stdio)
    ? (['pipe', options.stdio[1] ?? 'inherit', options.stdio[2] ?? 'inherit'] as StdioOptions)
    : (['pipe', options.stdio, options.stdio] as StdioOptions);
  const child = spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      WINDOWS_JOB_RUNNER,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio,
      shell: false,
      windowsHide: true,
    },
  );
  child.stdin?.on('error', () => {
    /* spawn/early-exit errors are reported on the child itself */
  });
  child.stdin?.end(
    JSON.stringify({ executable, args, cwd: options.cwd, shell: options.shell === true }),
  );
  return child;
}

/** Provider runs must use the CLIs' subscription login, never inherited API billing. */
export function subscriptionProviderEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of Object.keys(env)) {
    if (SECRET_ENV_NAME.test(key) || CONTROL_PLANE_ENV.includes(key as never)) delete env[key];
  }
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
    const tree = await new Promise<{ killed: boolean; code: number | null; error?: string }>(
      (resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', (error) =>
          resolve({ killed: false, code: null, error: error.message }),
        );
        killer.once('close', (code) => resolve({ killed: code === 0, code }));
      },
    );
    if (!tree.killed) {
      log.warn('taskkill tree termination failed; falling back to the direct child', {
        pid: child.pid,
        code: tree.code,
        error: tree.error,
      });
      child.kill('SIGKILL');
    }
    if (!(await waitForExit(child, 1500))) {
      log.warn('child termination was not observed before cleanup deadline', { pid: child.pid });
    }
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
  if (!(await waitForExit(child, 500))) {
    log.warn('child termination was not observed after SIGKILL', { pid: child.pid });
  }
}

/**
 * Run a CLI that emits JSON-per-line on stdout, feeding the prompt via stdin.
 * Handles timeout, cancellation and process-tree cleanup uniformly for every
 * provider so no adapter reinvents it.
 */
export function runJsonlProcess(spec: JsonlRunSpec): Promise<JsonlRunOutcome> {
  return new Promise<JsonlRunOutcome>((resolve) => {
    const child = spawnContained(spec.cli.command, [...spec.cli.prefixArgs, ...spec.args], {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subscriptionProviderEnv(),
      shell: false,
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      void killTree(child);
      resolve({
        code: null,
        timedOut: false,
        cancelled: false,
        startError: 'provider containment did not create the required stdio pipes',
        stderr: '',
        malformedLines: 0,
      });
      return;
    }

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

    const terminate = () => {
      void killTree(child).finally(() =>
        finish({
          code: child.exitCode,
          timedOut,
          cancelled,
          stderr: stderrChunks.join('').trim().slice(-3000),
          ...protocolFields(),
        }),
      );
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, spec.timeoutMs);

    const onAbort = () => {
      cancelled = true;
      terminate();
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

    stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      if (stderrChunks.length > 200) stderrChunks.shift();
    });

    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
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

    stdin.on('error', () => {
      /* the CLI may close stdin early; not fatal */
    });
    stdin.end(spec.stdin);

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
