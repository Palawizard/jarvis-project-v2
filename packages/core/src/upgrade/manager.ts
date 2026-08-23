import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CandidateApplicationService } from '../application/service.js';
import type { JarvisConfig } from '../config.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { GitWorkspace, repoStatus } from '../git/workspace.js';
import { newId, nowIso } from '../ids.js';
import type { JobService } from '../jobs/service.js';
import type { ProjectService } from '../projects/service.js';
import { startCandidateRuntime } from '../runtime/candidate.js';

const exec = promisify(execFile);

export type UpgradeStatus =
  | 'planned'
  | 'preflight_running'
  | 'preflight_passed'
  | 'activation_requested'
  | 'activation_succeeded'
  | 'activation_failed'
  | 'rollback_completed'
  | 'inspection_required';

export interface UpgradeTransaction {
  id: string;
  jobId: string;
  applicationId: string;
  status: UpgradeStatus;
  repository: string;
  branch: string;
  previousSha: string;
  candidateSha: string;
  rollbackRef: string | null;
  activationAt: string | null;
  healthcheckResult: Record<string, unknown> | null;
  rollbackSha: string | null;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

type Row = Record<string, unknown>;

/** Persists self-upgrade intent; the external supervisor performs activation. */
export class UpgradeManager {
  private readonly git: GitWorkspace;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly jobs: JobService,
    private readonly projects: ProjectService,
    private readonly applications: CandidateApplicationService,
    private readonly config: JarvisConfig,
  ) {
    this.git = new GitWorkspace(config.worktreesDir);
  }

  getForJob(jobId: string): UpgradeTransaction | null {
    const row = this.db
      .prepare('SELECT * FROM upgrade_transactions WHERE job_id=? ORDER BY created_at DESC LIMIT 1')
      .get(jobId) as Row | undefined;
    if (!row) return null;
    const transaction = rowToUpgrade(row);
    return this.reconcile(transaction);
  }

  async prepare(jobId: string): Promise<UpgradeTransaction> {
    const existing = this.getForJob(jobId);
    if (
      existing &&
      ['preflight_passed', 'activation_requested', 'activation_succeeded'].includes(existing.status)
    ) {
      return existing;
    }
    const application = this.applications.getForJob(jobId);
    if (!application || application.status !== 'approved') {
      throw new Error(
        'an approved candidate application is required before self-upgrade preflight',
      );
    }
    const job = this.jobs.get(jobId);
    const project = job ? this.projects.get(job.projectId) : null;
    if (!job || !project?.isSelf || !job.worktreePath) {
      throw new Error('self-upgrade is only available for the registered Jarvis project');
    }
    await this.git.validateCandidate(
      job.worktreePath,
      application.candidateBase,
      application.candidateHead,
    );
    const target = await repoStatus(project.rootPath);
    if (!target.isRepo || !target.head || !target.branch || target.branch === 'HEAD') {
      throw new Error('Jarvis target repository or branch identity is unavailable');
    }
    if (target.dirty) throw new Error('Jarvis source checkout is dirty; self-upgrade aborted');
    if (target.head !== application.candidateBase) {
      throw new Error('Jarvis target HEAD changed since candidate creation');
    }

    const id = newId('upgrade');
    const rollbackRef = `refs/jarvis/rollback/${id}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO upgrade_transactions (id, job_id, application_id, status, repository, branch,
          previous_sha, candidate_sha, rollback_ref, created_at, updated_at)
         VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        jobId,
        application.id,
        project.rootPath,
        target.branch,
        target.head,
        application.candidateHead,
        rollbackRef,
        now,
        now,
      );
    await git(project.rootPath, ['update-ref', rollbackRef, target.head, ZERO_SHA]);
    this.setStatus(id, 'preflight_running');
    this.bus.emit({
      type: 'upgrade.preflight.started',
      jobId,
      payload: { transactionId: id, candidateSha: application.candidateHead },
    });

    let runtime: Awaited<ReturnType<typeof startCandidateRuntime>> | undefined;
    try {
      runtime = await startCandidateRuntime({
        project,
        cwd: job.worktreePath,
        jobId: `${jobId}-upgrade-preflight`,
        config: this.config,
      });
      await this.git.validateCandidate(
        job.worktreePath,
        application.candidateBase,
        application.candidateHead,
      );
      const healthcheck = { status: 'ok', url: runtime.healthUrl, ports: runtime.ports };
      await runtime.stop();
      runtime = undefined;
      await this.git.validateCandidate(
        job.worktreePath,
        application.candidateBase,
        application.candidateHead,
      );
      this.setStatus(id, 'preflight_passed', {
        healthcheckResult: healthcheck,
      });
      this.bus.emit({
        type: 'upgrade.preflight.completed',
        jobId,
        payload: { transactionId: id, health: 'ok' },
      });
      return this.getForJob(jobId) as UpgradeTransaction;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(id, 'activation_failed', { failure: message });
      this.bus.emit({
        type: 'upgrade.preflight.completed',
        jobId,
        payload: { transactionId: id, health: 'failed', error: message },
      });
      throw error;
    } finally {
      await runtime?.stop();
    }
  }

  async requestActivation(jobId: string): Promise<UpgradeTransaction> {
    const transaction = this.getForJob(jobId);
    if (!transaction || transaction.status !== 'preflight_passed') {
      throw new Error('self-upgrade preflight must pass before activation');
    }
    const requestPath = process.env.JARVIS_UPGRADE_REQUEST_PATH;
    if (process.env.JARVIS_SUPERVISED !== '1' || !requestPath) {
      throw new Error('Jarvis is not running under the upgrade supervisor');
    }
    const job = this.jobs.get(jobId);
    if (!job?.worktreePath) throw new Error('candidate worktree is unavailable');
    await this.git.validateCandidate(
      job.worktreePath,
      transaction.previousSha,
      transaction.candidateSha,
    );
    const target = await repoStatus(transaction.repository);
    if (
      target.dirty ||
      target.head !== transaction.previousSha ||
      target.branch !== transaction.branch
    ) {
      throw new Error('Jarvis checkout changed after preflight; activation aborted');
    }
    const rollbackSha = await git(transaction.repository, [
      'rev-parse',
      transaction.rollbackRef as string,
    ]);
    if (rollbackSha !== transaction.previousSha) throw new Error('rollback reference is invalid');

    const resultPath = path.join(this.config.home, 'upgrades', `${transaction.id}-result.json`);
    fs.mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    const request = {
      transactionId: transaction.id,
      approved: true,
      approvedBy: 'user',
      repository: transaction.repository,
      branch: transaction.branch,
      previousSha: transaction.previousSha,
      candidateSha: transaction.candidateSha,
      rollbackRef: transaction.rollbackRef,
      healthUrl: `http://127.0.0.1:${this.config.port}/health`,
      buildCommand: { executable: 'pnpm', args: ['build'] },
      startCommand: { executable: 'pnpm', args: ['--filter', '@jarvis/orchestrator', 'start'] },
      resultPath,
    };
    const temporary = `${requestPath}.${transaction.id}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    this.setStatus(transaction.id, 'activation_requested', { activationAt: nowIso() });
    try {
      fs.renameSync(temporary, requestPath);
    } catch (error) {
      this.setStatus(transaction.id, 'inspection_required', {
        failure: `activation request publication failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    this.bus.emit({
      type: 'upgrade.activation.started',
      jobId,
      payload: { transactionId: transaction.id, candidateSha: transaction.candidateSha },
    });
    return this.getForJob(jobId) as UpgradeTransaction;
  }

  private reconcile(transaction: UpgradeTransaction): UpgradeTransaction {
    if (transaction.status !== 'activation_requested') return transaction;
    const resultPath = path.join(this.config.home, 'upgrades', `${transaction.id}-result.json`);
    if (!fs.existsSync(resultPath)) return transaction;
    let result: {
      status?: string;
      healthcheck?: Record<string, unknown>;
      rollbackHealthcheck?: Record<string, unknown>;
      rollbackSha?: string;
      error?: string;
      activationError?: string;
    };
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as typeof result;
    } catch {
      this.setStatus(transaction.id, 'inspection_required', {
        failure: 'invalid supervisor result',
      });
      return rowToUpgrade(
        this.db.prepare('SELECT * FROM upgrade_transactions WHERE id=?').get(transaction.id) as Row,
      );
    }
    if (result.status === 'activated') {
      this.setStatus(transaction.id, 'activation_succeeded', {
        healthcheckResult: result.healthcheck ?? { status: 'ok' },
        completedAt: nowIso(),
      });
      this.db
        .prepare(
          `UPDATE candidate_applications SET status='applied', target_head_before=?,
            target_head_after=?, completed_at=?, updated_at=? WHERE id=?`,
        )
        .run(
          transaction.previousSha,
          transaction.candidateSha,
          nowIso(),
          nowIso(),
          transaction.applicationId,
        );
      const job = this.jobs.get(transaction.jobId);
      if (job?.stage === 'awaiting_user') this.jobs.transition(job.id, 'completed');
      this.bus.emit({
        type: 'upgrade.healthcheck.passed',
        jobId: transaction.jobId,
        payload: { transactionId: transaction.id },
      });
    } else if (result.status === 'rolled_back') {
      this.setStatus(transaction.id, 'rollback_completed', {
        healthcheckResult: result.rollbackHealthcheck ?? result.healthcheck ?? null,
        rollbackSha: result.rollbackSha ?? transaction.previousSha,
        failure: result.activationError ?? result.error ?? 'new version failed healthcheck',
        completedAt: nowIso(),
      });
      this.bus.emit({
        type: 'upgrade.healthcheck.failed',
        jobId: transaction.jobId,
        payload: { transactionId: transaction.id, error: result.activationError ?? result.error },
      });
      this.bus.emit({
        type: 'upgrade.rollback.started',
        jobId: transaction.jobId,
        payload: { transactionId: transaction.id },
      });
      this.bus.emit({
        type: 'upgrade.rollback.completed',
        jobId: transaction.jobId,
        payload: { transactionId: transaction.id, rollbackSha: result.rollbackSha },
      });
    } else {
      this.setStatus(transaction.id, 'inspection_required', {
        failure:
          result.error ??
          result.activationError ??
          `supervisor reported ${result.status ?? 'an ambiguous activation result'}`,
      });
    }
    return rowToUpgrade(
      this.db.prepare('SELECT * FROM upgrade_transactions WHERE id=?').get(transaction.id) as Row,
    );
  }

  private setStatus(
    id: string,
    status: UpgradeStatus,
    patch: {
      healthcheckResult?: Record<string, unknown> | null;
      rollbackSha?: string | null;
      failure?: string | null;
      activationAt?: string | null;
      completedAt?: string | null;
    } = {},
  ): void {
    const current = this.db.prepare('SELECT * FROM upgrade_transactions WHERE id=?').get(id) as Row;
    this.db
      .prepare(
        `UPDATE upgrade_transactions SET status=?, healthcheck_result=?, rollback_sha=?, failure=?,
          activation_at=?, completed_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        status,
        patch.healthcheckResult === undefined
          ? ((current.healthcheck_result as string | null) ?? null)
          : patch.healthcheckResult === null
            ? null
            : JSON.stringify(patch.healthcheckResult),
        patch.rollbackSha === undefined
          ? ((current.rollback_sha as string | null) ?? null)
          : patch.rollbackSha,
        patch.failure === undefined ? ((current.failure as string | null) ?? null) : patch.failure,
        patch.activationAt === undefined
          ? ((current.activation_at as string | null) ?? null)
          : patch.activationAt,
        patch.completedAt === undefined
          ? ((current.completed_at as string | null) ?? null)
          : patch.completedAt,
        nowIso(),
        id,
      );
  }
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function rowToUpgrade(row: Row): UpgradeTransaction {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    applicationId: row.application_id as string,
    status: row.status as UpgradeStatus,
    repository: row.repository as string,
    branch: row.branch as string,
    previousSha: row.previous_sha as string,
    candidateSha: row.candidate_sha as string,
    rollbackRef: (row.rollback_ref as string) ?? null,
    activationAt: (row.activation_at as string) ?? null,
    healthcheckResult: row.healthcheck_result
      ? (JSON.parse(row.healthcheck_result as string) as Record<string, unknown>)
      : null,
    rollbackSha: (row.rollback_sha as string) ?? null,
    failure: (row.failure as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: (row.completed_at as string) ?? null,
  };
}
