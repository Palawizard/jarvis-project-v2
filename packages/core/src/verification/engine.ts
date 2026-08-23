import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import type { ProjectCommands } from '../projects/service.js';
import { redactSecrets } from '../memory/secrets.js';

export interface VerificationResult {
  id: string;
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  exitCode: number | null;
  output: string;
  outputPath: string | null;
  durationMs: number;
  cycle: number;
}

export interface VerificationReport {
  results: VerificationResult[];
  passed: boolean;
  ran: number;
  /** Compact failure text suitable for a fixer prompt — NOT the whole log. */
  failureSummary: string;
}

/** Order matters: cheap checks first, so a syntax error fails in seconds not minutes. */
const STEP_ORDER: (keyof ProjectCommands)[] = ['format', 'lint', 'typecheck', 'test', 'build'];

const MAX_STORED_OUTPUT = 8000;
const STEP_TIMEOUT_MS = 15 * 60_000;
/** Dependency installs are slower than any single check and worth their own budget. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/**
 * Deterministic verification.
 *
 * The point of this subsystem is that an agent claiming "tests pass" is not
 * evidence. Jarvis runs the commands itself, in the worktree, and records the
 * exit codes. Nothing here consults a model.
 */
export class VerificationEngine {
  constructor(
    private readonly db: Db,
    private readonly artifactsDir: string,
    private readonly bus?: EventBus,
  ) {}

  async run(opts: {
    jobId: string;
    cwd: string;
    commands: ProjectCommands;
    cycle?: number;
    signal?: AbortSignal;
  }): Promise<VerificationReport> {
    const cycle = opts.cycle ?? 0;
    const results: VerificationResult[] = [];
    this.bus?.emit({ type: 'verification.started', jobId: opts.jobId, payload: { cycle } });

    const logDir = path.join(this.artifactsDir, opts.jobId, `verify-${cycle}`);
    fs.mkdirSync(logDir, { recursive: true });

    // A git worktree is a fresh checkout with no node_modules, so every command
    // below would fail with "module not found" and look like a broken change.
    // Install once per worktree, and only when the deps are actually missing.
    const steps: Array<{ name: string; command: string; timeoutMs: number }> = [];
    if (opts.commands.install && needsInstall(opts.cwd)) {
      steps.push({
        name: 'install',
        command: opts.commands.install,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    }
    for (const name of STEP_ORDER) {
      const command = opts.commands[name];
      if (command) steps.push({ name, command, timeoutMs: STEP_TIMEOUT_MS });
    }

    for (const { name, command, timeoutMs } of steps) {
      if (opts.signal?.aborted) break;

      const started = Date.now();
      const outcome = await runCommand(command, opts.cwd, timeoutMs, opts.signal);
      const durationMs = Date.now() - started;

      const outputPath = path.join(logDir, `${name}.log`);
      const fullOutput = redactSecrets(outcome.output);
      fs.writeFileSync(outputPath, fullOutput, { encoding: 'utf8' });

      const result: VerificationResult = {
        id: newId('ver'),
        name,
        command,
        status: outcome.startFailed ? 'error' : outcome.exitCode === 0 ? 'passed' : 'failed',
        exitCode: outcome.exitCode,
        // Keep the tail: test runners put the failure summary at the end.
        output:
          fullOutput.length > MAX_STORED_OUTPUT
            ? `...\n${fullOutput.slice(-MAX_STORED_OUTPUT)}`
            : fullOutput,
        outputPath,
        durationMs,
        cycle,
      };
      results.push(result);

      this.db
        .prepare(
          `INSERT INTO verifications (id, job_id, cycle, name, command, cwd, exit_code, status, output,
            output_path, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          result.id,
          opts.jobId,
          cycle,
          result.name,
          result.command,
          opts.cwd,
          result.exitCode,
          result.status,
          result.output,
          result.outputPath,
          result.durationMs,
          nowIso(),
        );

      this.bus?.emit({
        type: 'verification.step',
        jobId: opts.jobId,
        payload: { name, status: result.status, exitCode: result.exitCode, durationMs },
      });

      // If dependencies could not be installed, every later check would fail for
      // the same reason. Stop and report the real cause instead of a cascade.
      if (name === 'install' && result.status !== 'passed') break;
    }

    // `install` is setup, not evidence: it must not make an unverified change
    // look verified, so it is excluded from the pass decision and the count.
    const checks = results.filter((r) => r.name !== 'install');
    const installFailed = results.some((r) => r.name === 'install' && r.status !== 'passed');
    const passed =
      !installFailed && checks.length > 0 && checks.every((r) => r.status === 'passed');
    const report: VerificationReport = {
      results,
      passed,
      ran: checks.length,
      failureSummary: summariseFailures(results),
    };
    this.bus?.emit({
      type: 'verification.completed',
      jobId: opts.jobId,
      payload: {
        cycle,
        passed,
        ran: checks.length,
        steps: results.map((r) => ({ name: r.name, status: r.status })),
      },
    });
    return report;
  }

  list(jobId: string): VerificationResult[] {
    const rows = this.db
      .prepare('SELECT * FROM verifications WHERE job_id = ? ORDER BY cycle ASC, created_at ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      command: row.command as string,
      status: row.status as VerificationResult['status'],
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      output: row.output as string,
      outputPath: (row.output_path as string) ?? null,
      durationMs: Number(row.duration_ms),
      cycle: Number(row.cycle),
    }));
  }

  /** Reconstruct the final deterministic gate from persisted evidence. */
  latestReport(jobId: string): VerificationReport {
    const all = this.list(jobId);
    const cycle = all.reduce((latest, result) => Math.max(latest, result.cycle), -1);
    const results = all.filter((result) => result.cycle === cycle);
    const checks = results.filter((result) => result.name !== 'install');
    const passed = checks.length > 0 && results.every((result) => result.status === 'passed');
    return { results, passed, ran: checks.length, failureSummary: summariseFailures(results) };
  }
}

/**
 * True when a JS project's dependencies are missing. Cheap existence check
 * rather than a full integrity check: pnpm/npm are themselves idempotent and
 * fast when everything is already present, but skipping the spawn entirely
 * keeps repeat verification cycles quick.
 */
function needsInstall(cwd: string): boolean {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return false;
  return !fs.existsSync(path.join(cwd, 'node_modules'));
}

interface CommandOutcome {
  exitCode: number | null;
  output: string;
  startFailed: boolean;
}

/**
 * Run one verification command.
 *
 * `shell: true` is required here: project commands are shell strings from
 * package.json ("pnpm run test"), not argv arrays. This is a deliberate,
 * bounded trust decision — the commands come from the project's own
 * configuration, which the user registered.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });

    const chunks: string[] = [];
    let size = 0;
    const MAX_CAPTURE = 2_000_000;
    const capture = (chunk: Buffer) => {
      if (size > MAX_CAPTURE) return;
      const text = chunk.toString();
      size += text.length;
      chunks.push(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    let settled = false;
    const done = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const kill = () => {
      if (child.pid && process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      kill();
      done({
        exitCode: null,
        output: `${chunks.join('')}\n[timed out after ${timeoutMs}ms]`,
        startFailed: false,
      });
    }, timeoutMs);

    const onAbort = () => {
      kill();
      done({ exitCode: null, output: `${chunks.join('')}\n[cancelled]`, startFailed: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      done({
        exitCode: null,
        output: `could not run command: ${error.message}`,
        startFailed: true,
      });
    });
    child.on('close', (code) => {
      done({ exitCode: code, output: chunks.join(''), startFailed: false });
    });
  });
}

/** Bounded failure digest: enough for a fixer to act, small enough for a prompt. */
function summariseFailures(results: VerificationResult[]): string {
  const failures = results.filter((r) => r.status !== 'passed');
  if (failures.length === 0) return '';
  return failures
    .map((f) => {
      const tail = f.output.split('\n').slice(-40).join('\n');
      return `### ${f.name} (${f.status}, exit ${f.exitCode ?? 'n/a'})\n$ ${f.command}\n\n${tail}`;
    })
    .join('\n\n');
}
