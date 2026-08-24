import { execFile, execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  timingSafeEqual,
  verify as verifyBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
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

  async requestActivation(jobId: string, activationToken: string): Promise<UpgradeTransaction> {
    const transaction = this.getForJob(jobId);
    if (!transaction || transaction.status !== 'preflight_passed') {
      throw new Error('self-upgrade preflight must pass before activation');
    }
    const requestPath = process.env.JARVIS_UPGRADE_REQUEST_PATH;
    const upgradeSocket = process.env.JARVIS_UPGRADE_SOCKET;
    if (process.env.JARVIS_SUPERVISED !== '1' || !requestPath || !upgradeSocket) {
      throw new Error('Jarvis is not running under the upgrade supervisor');
    }
    if (activationToken.length < 32 || activationToken.length > 4096) {
      throw new Error('the out-of-band supervisor activation token is required');
    }
    const tokenHash = process.env.JARVIS_UPGRADE_TOKEN_HASH;
    if (!/^[0-9a-f]{64}$/.test(tokenHash ?? '')) {
      throw new Error('the supervisor activation-token hash is unavailable');
    }
    if (
      !timingSafeEqual(
        createHash('sha256').update(activationToken, 'utf8').digest(),
        Buffer.from(tokenHash as string, 'hex'),
      )
    ) {
      throw new Error('the out-of-band supervisor activation token is invalid');
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
    fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    const evidenceKeys = generateKeyPairSync('ed25519');
    const evidencePublicKey = evidenceKeys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const evidencePrivateKey = evidenceKeys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const request = {
      transactionId: transaction.id,
      approved: true,
      approvedBy: 'user',
      activationToken,
      repository: transaction.repository,
      branch: transaction.branch,
      previousSha: transaction.previousSha,
      candidateSha: transaction.candidateSha,
      rollbackRef: transaction.rollbackRef,
      healthUrl: `http://127.0.0.1:${this.config.port}/health`,
      buildCommand: { executable: 'pnpm', args: ['build'] },
      startCommand: { executable: 'pnpm', args: ['--filter', '@jarvis/orchestrator', 'start'] },
      resultPath,
      evidencePrivateKey,
    };
    const activationAt = nowIso();
    const claimed = this.db
      .prepare(
        `UPDATE upgrade_transactions SET status='activation_requested', activation_at=?,
          healthcheck_result=?, failure=NULL, updated_at=?
          WHERE id=? AND status='preflight_passed'`,
      )
      .run(
        activationAt,
        JSON.stringify({ activationEvidencePublicKey: evidencePublicKey }),
        activationAt,
        transaction.id,
      );
    if (Number(claimed.changes) !== 1) {
      throw new Error('self-upgrade activation is already being processed');
    }
    try {
      await sendActivationRequest(upgradeSocket, request);
    } catch (error) {
      this.setStatus(transaction.id, 'inspection_required', {
        failure: `activation request delivery failed: ${error instanceof Error ? error.message : String(error)}`,
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
      transactionId?: string;
      repository?: string;
      branch?: string;
      previousSha?: string;
      candidateSha?: string;
      headAfter?: string;
      healthcheck?: Record<string, unknown>;
      rollbackHealthcheck?: Record<string, unknown>;
      rollbackSha?: string;
      error?: string;
      activationError?: string;
      evidenceSignature?: string;
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
    const publicKey = transaction.healthcheckResult?.activationEvidencePublicKey;
    if (
      !verifyEvidence(result as Record<string, unknown>, publicKey) ||
      result.transactionId !== transaction.id ||
      path.resolve(result.repository ?? '') !== path.resolve(transaction.repository) ||
      result.branch !== transaction.branch ||
      result.previousSha !== transaction.previousSha ||
      result.candidateSha !== transaction.candidateSha
    ) {
      this.setStatus(transaction.id, 'inspection_required', {
        failure: 'supervisor result signature or transaction identity is invalid',
      });
      return rowToUpgrade(
        this.db.prepare('SELECT * FROM upgrade_transactions WHERE id=?').get(transaction.id) as Row,
      );
    }
    if (result.status === 'activated') {
      if (
        result.headAfter !== transaction.candidateSha ||
        !exactRepositoryState(transaction.repository, transaction.branch, transaction.candidateSha)
      ) {
        this.setStatus(transaction.id, 'inspection_required', {
          failure: 'supervisor reported activation but the live checkout identity does not match',
        });
        return rowToUpgrade(
          this.db
            .prepare('SELECT * FROM upgrade_transactions WHERE id=?')
            .get(transaction.id) as Row,
        );
      }
      if (
        !this.setStatus(
          transaction.id,
          'activation_succeeded',
          {
            healthcheckResult: result.healthcheck ?? { status: 'ok' },
            completedAt: nowIso(),
          },
          'activation_requested',
        )
      ) {
        return rowToUpgrade(
          this.db
            .prepare('SELECT * FROM upgrade_transactions WHERE id=?')
            .get(transaction.id) as Row,
        );
      }
      this.db
        .prepare(
          `UPDATE candidate_applications SET status='applied', target_head_before=?,
            target_head_after=?, completed_at=?, updated_at=? WHERE id=? AND status='approved'`,
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
      if (
        result.rollbackSha !== transaction.previousSha ||
        result.headAfter !== transaction.previousSha ||
        !exactRepositoryState(transaction.repository, transaction.branch, transaction.previousSha)
      ) {
        this.setStatus(transaction.id, 'inspection_required', {
          failure: 'supervisor reported rollback but the live checkout identity does not match',
        });
        return rowToUpgrade(
          this.db
            .prepare('SELECT * FROM upgrade_transactions WHERE id=?')
            .get(transaction.id) as Row,
        );
      }
      if (
        !this.setStatus(
          transaction.id,
          'rollback_completed',
          {
            healthcheckResult: result.rollbackHealthcheck ?? result.healthcheck ?? null,
            rollbackSha: result.rollbackSha,
            failure: result.activationError ?? result.error ?? 'new version failed healthcheck',
            completedAt: nowIso(),
          },
          'activation_requested',
        )
      ) {
        return rowToUpgrade(
          this.db
            .prepare('SELECT * FROM upgrade_transactions WHERE id=?')
            .get(transaction.id) as Row,
        );
      }
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
    expectedStatus?: UpgradeStatus,
  ): boolean {
    const current = this.db.prepare('SELECT * FROM upgrade_transactions WHERE id=?').get(id) as Row;
    const changed = this.db
      .prepare(
        `UPDATE upgrade_transactions SET status=?, healthcheck_result=?, rollback_sha=?, failure=?,
          activation_at=?, completed_at=?, updated_at=? WHERE id=?${expectedStatus ? ' AND status=?' : ''}`,
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
        ...(expectedStatus ? [expectedStatus] : []),
      );
    return Number(changed.changes) === 1;
  }
}

function sendActivationRequest(endpoint: string, request: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    let pending = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('upgrade supervisor did not acknowledge the request')),
      10_000,
    );
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline)) as {
          accepted?: boolean;
          error?: string;
        };
        if (!response.accepted) return finish(new Error(response.error ?? 'activation rejected'));
        socket.end('ack\n', () => finish());
      } catch {
        finish(new Error('upgrade supervisor returned an invalid acknowledgement'));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('upgrade supervisor closed before acknowledgement'));
    });
  });
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

function canonicalEvidence(result: Record<string, unknown>): string {
  const value = { ...result };
  delete value.evidenceSignature;
  return stableJson(value);
}

function verifyEvidence(result: Record<string, unknown>, publicKey: unknown): boolean {
  if (typeof publicKey !== 'string' || typeof result.evidenceSignature !== 'string') return false;
  try {
    return verifyBytes(
      null,
      Buffer.from(canonicalEvidence(result), 'utf8'),
      publicKey,
      Buffer.from(result.evidenceSignature, 'base64'),
    );
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function exactRepositoryState(repository: string, branch: string, head: string): boolean {
  try {
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    const currentBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    return currentHead === head && currentBranch === branch && dirty === '';
  } catch {
    return false;
  }
}

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
