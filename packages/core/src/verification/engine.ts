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

    for (const name of STEP_ORDER) {
      const command = opts.commands[name];
      if (!command) continue;
      if (opts.signal?.aborted) break;

      const started = Date.now();
      const outcome = await runCommand(command, opts.cwd, STEP_TIMEOUT_MS, opts.signal);
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
        output: fullOutput.length > MAX_STORED_OUTPUT ? `...\n${fullOutput.slice(-MAX_STORED_OUTPUT)}` : fullOutput,
        outputPath,
        durationMs,
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
    }

    const passed = results.every((r) => r.status === 'passed');
    const report: VerificationReport = {
      results,
      passed,
      ran: results.length,
      failureSummary: summariseFailures(results),
    };
    this.bus?.emit({
      type: 'verification.completed',
      jobId: opts.jobId,
      payload: { cycle, passed, ran: results.length, steps: results.map((r) => ({ name: r.name, status: r.status })) },
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
    }));
  }
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
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      kill();
      done({ exitCode: null, output: `${chunks.join('')}\n[timed out after ${timeoutMs}ms]`, startFailed: false });
    }, timeoutMs);

    const onAbort = () => {
      kill();
      done({ exitCode: null, output: `${chunks.join('')}\n[cancelled]`, startFailed: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      done({ exitCode: null, output: `could not run command: ${error.message}`, startFailed: true });
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
