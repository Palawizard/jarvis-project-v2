import type { Db } from '../db/index.js';
import { likeTerm, parseJson, transaction } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import type { ProviderId } from '../agents/types.js';
import type { VisualQaScenario } from '../projects/service.js';
import type { VisualQaPlan } from '../visualqa/surfaces.js';
import type { ReviewFinding } from '../review/engine.js';
import type { VisualReviewFinding } from '../visualqa/engine.js';
import { redactSecrets } from '../memory/secrets.js';

export type RepairKind = 'verification' | 'code_review' | 'visual';
export interface RepairCheckpoint {
  kind: RepairKind;
  verification?: { resultIds: string[]; cycle: number; failureSummary: string };
  review?: { id: string; findings: ReviewFinding[] };
  visual?: { shotIds: string[]; findings: VisualReviewFinding[]; cycle: number };
}
import {
  assertTransition,
  isTerminal,
  statusForStage,
  type JobStage,
  type JobStatus,
} from './machine.js';

export interface Job {
  id: string;
  sessionId: string | null;
  projectId: string;
  request: string;
  goal: string;
  acceptance: string[];
  stage: JobStage;
  status: JobStatus;
  error: string | null;
  branch: string | null;
  worktreePath: string | null;
  baseRef: string | null;
  headRef: string | null;
  fixCycles: number;
  reviewFixCycles: number;
  visualFixCycles: number;
  resumeStage: JobStage | null;
  pauseReason: string | null;
  restartReason: string | null;
  repairKind: RepairKind | null;
  repairCheckpoint: RepairCheckpoint | null;
  lastProvider: ProviderId | null;
  resumeSessionId: string | null;
  reviewedHead: string | null;
  visualHead: string | null;
  candidateBaseSha: string | null;
  candidateSourceSha: string | null;
  validationOnly: boolean;
  visualQaConfig: { required?: boolean; scenarios: VisualQaScenario[] } | null;
  /** The scenario plan Visual QA actually resolved for this candidate diff. */
  visualQaPlan: VisualQaPlan | null;
  episodeId: string | null;
  /** Archived Jobs keep every artifact and simply leave the default History. */
  archivedAt: string | null;
  /** The Job this one was created from by "Run again". */
  predecessorJobId: string | null;
  /** The exact conversation message that asked for this Job. */
  originMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** What is left behind when a disposable Job is hard-deleted. */
export interface JobTombstone {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  goal: string;
  reason: string;
  deletedAt: string;
}

export interface AgentRun {
  id: string;
  jobId: string | null;
  provider: string;
  model: string | null;
  role: string;
  externalSessionId: string | null;
  cwd: string;
  status: string;
  result: string | null;
  error: string | null;
  usage: Record<string, unknown>;
  contextPackId: string | null;
  startedAt: string;
  endedAt: string | null;
}

type Row = Record<string, unknown>;

function rowToJob(row: Row): Job {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string) ?? null,
    projectId: row.project_id as string,
    request: row.request as string,
    goal: row.goal as string,
    acceptance: parseJson(row.acceptance as string, [] as string[]),
    stage: row.stage as JobStage,
    status: row.status as JobStatus,
    error: (row.error as string) ?? null,
    branch: (row.branch as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    baseRef: (row.base_ref as string) ?? null,
    headRef: (row.head_ref as string) ?? null,
    fixCycles: Number(row.fix_cycles ?? 0),
    reviewFixCycles: Number(row.review_fix_cycles ?? 0),
    visualFixCycles: Number(row.visual_fix_cycles ?? 0),
    resumeStage: (row.resume_stage as JobStage) ?? null,
    pauseReason: (row.pause_reason as string) ?? null,
    restartReason: (row.restart_reason as string) ?? null,
    repairKind: (row.repair_kind as RepairKind) ?? null,
    repairCheckpoint: parseJson(row.repair_checkpoint as string, null as RepairCheckpoint | null),
    lastProvider: (row.last_provider as ProviderId) ?? null,
    resumeSessionId: (row.resume_session_id as string) ?? null,
    reviewedHead: (row.reviewed_head as string) ?? null,
    visualHead: (row.visual_head as string) ?? null,
    candidateBaseSha: (row.candidate_base_sha as string) ?? null,
    candidateSourceSha: (row.candidate_source_sha as string) ?? null,
    validationOnly: Number(row.validation_only) === 1,
    visualQaConfig: parseJson(
      row.visual_qa_config as string,
      null as { required?: boolean; scenarios: VisualQaScenario[] } | null,
    ),
    visualQaPlan: parseJson(row.visual_qa_plan as string, null as VisualQaPlan | null),
    episodeId: (row.episode_id as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
    predecessorJobId: (row.predecessor_job_id as string) ?? null,
    originMessageId: (row.origin_message_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    finishedAt: (row.finished_at as string) ?? null,
  };
}

/**
 * Binds `visual_qa_plan=CASE WHEN ? THEN ? ELSE visual_qa_plan END`. Unrelated
 * writes leave the stored column untouched, so a malformed persisted plan keeps
 * failing closed at the application gate instead of being silently rewritten to
 * NULL by `rowToJob`'s lenient parse (which reads it back as "no plan").
 */
function visualPlanBinding(patch: Partial<Job>): [number, string | null] {
  if (!('visualQaPlan' in patch)) return [0, null];
  return [1, patch.visualQaPlan ? JSON.stringify(patch.visualQaPlan) : null];
}

function rowToRun(row: Row): AgentRun {
  return {
    id: row.id as string,
    jobId: (row.job_id as string) ?? null,
    provider: row.provider as string,
    model: (row.model as string) ?? null,
    role: row.role as string,
    externalSessionId: (row.external_session_id as string) ?? null,
    cwd: row.cwd as string,
    status: row.status as string,
    result: (row.result as string) ?? null,
    error: (row.error as string) ?? null,
    usage: parseJson(row.usage as string, {}),
    contextPackId: (row.context_pack_id as string) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
  };
}

export class JobService {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  create(input: {
    projectId: string;
    sessionId?: string | null;
    request: string;
    goal?: string;
    acceptance?: string[];
    candidateSource?: { baseSha: string; sourceSha: string };
    validationOnly?: boolean;
    visualQa?: { required?: boolean; scenarios: VisualQaScenario[] };
    predecessorJobId?: string | null;
    originMessageId?: string | null;
  }): Job {
    if (Boolean(input.candidateSource) !== Boolean(input.validationOnly)) {
      throw new Error('candidateSource and validationOnly must be supplied together');
    }
    if (input.visualQa && input.visualQa.scenarios.length === 0) {
      throw new Error('job visual QA override requires at least one scenario');
    }
    const now = nowIso();
    const job: Job = {
      id: newId('job'),
      sessionId: input.sessionId ?? null,
      projectId: input.projectId,
      request: input.request,
      // Deterministic normalization — no model call is spent turning a request
      // into a goal. The implementer plans as part of work we already pay for.
      goal: input.goal?.trim() || normaliseGoal(input.request),
      acceptance: input.acceptance ?? [],
      stage: 'queued',
      status: 'pending',
      error: null,
      branch: null,
      worktreePath: null,
      baseRef: null,
      headRef: null,
      fixCycles: 0,
      reviewFixCycles: 0,
      visualFixCycles: 0,
      resumeStage: null,
      pauseReason: null,
      restartReason: null,
      repairKind: null,
      repairCheckpoint: null,
      lastProvider: null,
      resumeSessionId: null,
      reviewedHead: null,
      visualHead: null,
      candidateBaseSha: input.candidateSource?.baseSha ?? null,
      candidateSourceSha: input.candidateSource?.sourceSha ?? null,
      validationOnly: input.validationOnly ?? false,
      visualQaConfig: input.visualQa ?? null,
      visualQaPlan: null,
      episodeId: null,
      archivedAt: null,
      predecessorJobId: input.predecessorJobId ?? null,
      originMessageId: input.originMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, session_id, project_id, request, goal, acceptance, stage, status,
          fix_cycles, review_fix_cycles, visual_fix_cycles, candidate_base_sha,
          candidate_source_sha, validation_only, visual_qa_config, predecessor_job_id,
          origin_message_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.id,
        job.sessionId,
        job.projectId,
        job.request,
        job.goal,
        JSON.stringify(job.acceptance),
        job.stage,
        job.status,
        0,
        0,
        0,
        job.candidateBaseSha,
        job.candidateSourceSha,
        job.validationOnly ? 1 : 0,
        job.visualQaConfig ? JSON.stringify(job.visualQaConfig) : null,
        job.predecessorJobId,
        job.originMessageId,
        now,
        now,
      );
    this.bus.emit({
      type: 'job.created',
      jobId: job.id,
      sessionId: job.sessionId,
      payload: { goal: job.goal, projectId: job.projectId },
    });
    return job;
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToJob(row) : null;
  }

  list(
    filter: {
      projectId?: string;
      sessionId?: string;
      status?: JobStatus;
      stage?: JobStage;
      /** Default `active`: archived Jobs leave the normal History. */
      archived?: 'active' | 'archived' | 'all';
      search?: string;
      /** ISO timestamps bounding `created_at`. */
      since?: string;
      until?: string;
      sort?: 'updated' | 'created';
      limit?: number;
    } = {},
  ): Job[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.stage) {
      where.push('stage = ?');
      params.push(filter.stage);
    }
    const archived = filter.archived ?? 'active';
    if (archived === 'active') where.push('archived_at IS NULL');
    if (archived === 'archived') where.push('archived_at IS NOT NULL');
    if (filter.search?.trim()) {
      where.push("(lower(goal) LIKE ? ESCAPE '~' OR lower(request) LIKE ? ESCAPE '~' OR id = ?)");
      const like = likeTerm(filter.search.trim().toLowerCase());
      params.push(like, like, filter.search.trim());
    }
    if (filter.since) {
      where.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('created_at <= ?');
      params.push(filter.until);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = filter.sort === 'updated' ? 'updated_at' : 'created_at';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY ${order} DESC LIMIT ?`)
      .all(...params, Math.min(Math.max(filter.limit ?? 50, 1), 500)) as Row[];
    return rows.map(rowToJob);
  }

  /** The only way a job changes stage. Validates against the state machine. */
  transition(id: string, to: JobStage, patch: Partial<Job> = {}): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.stage === to && Object.keys(patch).length === 0) return job;
    assertTransition(job.stage, to);

    const now = nowIso();
    const status = statusForStage(to);
    const next = { ...job, ...patch, stage: to, status, updatedAt: now };
    const finishedAt =
      isTerminal(to) && to !== 'awaiting_user' ? now : (patch.finishedAt ?? job.finishedAt);

    this.db
      .prepare(
        `UPDATE jobs SET stage=?, status=?, error=?, branch=?, worktree_path=?, base_ref=?, head_ref=?,
          fix_cycles=?, review_fix_cycles=?, visual_fix_cycles=?, resume_stage=?, pause_reason=?,
          restart_reason=?, repair_kind=?, repair_checkpoint=?, last_provider=?, resume_session_id=?,
          reviewed_head=?, visual_head=?, candidate_base_sha=?,
          candidate_source_sha=?, validation_only=?, visual_qa_config=?,
          visual_qa_plan=CASE WHEN ? THEN ? ELSE visual_qa_plan END,
          episode_id=?, goal=?,
          acceptance=?, updated_at=?, finished_at=? WHERE id=?`,
      )
      .run(
        next.stage,
        next.status,
        next.error,
        next.branch,
        next.worktreePath,
        next.baseRef,
        next.headRef,
        next.fixCycles,
        next.reviewFixCycles,
        next.visualFixCycles,
        next.resumeStage,
        next.pauseReason,
        next.restartReason,
        next.repairKind,
        next.repairCheckpoint ? JSON.stringify(next.repairCheckpoint) : null,
        next.lastProvider,
        next.resumeSessionId,
        next.reviewedHead,
        next.visualHead,
        next.candidateBaseSha,
        next.candidateSourceSha,
        next.validationOnly ? 1 : 0,
        next.visualQaConfig ? JSON.stringify(next.visualQaConfig) : null,
        ...visualPlanBinding(patch),
        next.episodeId,
        next.goal,
        JSON.stringify(next.acceptance),
        now,
        finishedAt,
        id,
      );

    this.bus.emit({
      type: 'job.stage.changed',
      jobId: id,
      sessionId: job.sessionId,
      payload: { from: job.stage, to, status },
    });
    if (to === 'completed') this.bus.emit({ type: 'job.completed', jobId: id, payload: {} });
    if (to === 'failed')
      this.bus.emit({ type: 'job.failed', jobId: id, payload: { error: next.error } });
    if (to === 'cancelled') this.bus.emit({ type: 'job.cancelled', jobId: id, payload: {} });

    return { ...next, finishedAt };
  }

  /** Patch fields without a stage change (branch/worktree bookkeeping). */
  patch(id: string, patch: Partial<Job>): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const next = { ...job, ...patch };
    this.db
      .prepare(
        `UPDATE jobs SET error=?, branch=?, worktree_path=?, base_ref=?, head_ref=?, fix_cycles=?,
          review_fix_cycles=?, visual_fix_cycles=?, resume_stage=?, pause_reason=?, last_provider=?,
          restart_reason=?, repair_kind=?, repair_checkpoint=?, resume_session_id=?, reviewed_head=?,
          visual_head=?, candidate_base_sha=?,
          candidate_source_sha=?, validation_only=?, visual_qa_config=?,
          visual_qa_plan=CASE WHEN ? THEN ? ELSE visual_qa_plan END,
          episode_id=?, goal=?,
          acceptance=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.error,
        next.branch,
        next.worktreePath,
        next.baseRef,
        next.headRef,
        next.fixCycles,
        next.reviewFixCycles,
        next.visualFixCycles,
        next.resumeStage,
        next.pauseReason,
        next.lastProvider,
        next.restartReason,
        next.repairKind,
        next.repairCheckpoint ? JSON.stringify(next.repairCheckpoint) : null,
        next.resumeSessionId,
        next.reviewedHead,
        next.visualHead,
        next.candidateBaseSha,
        next.candidateSourceSha,
        next.validationOnly ? 1 : 0,
        next.visualQaConfig ? JSON.stringify(next.visualQaConfig) : null,
        ...visualPlanBinding(patch),
        next.episodeId,
        next.goal,
        JSON.stringify(next.acceptance),
        nowIso(),
        id,
      );
    return next;
  }

  // --------------------------------------------------------------- lifecycle --

  /**
   * Archive a Job. Every pipeline artifact, verification, review and piece of
   * application evidence is preserved untouched — the Job just leaves History.
   */
  setArchived(id: string, archived: boolean): Job | null {
    const job = this.get(id);
    if (!job) return null;
    if (archived && !isFinished(job)) {
      throw new Error(`job is ${job.stage}; only a finished job can be archived`);
    }
    this.db
      .prepare('UPDATE jobs SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? nowIso() : null, nowIso(), id);
    this.bus.emit({
      type: 'job.archived',
      jobId: id,
      sessionId: job.sessionId,
      payload: { archived },
    });
    return this.get(id);
  }

  /**
   * Whether this Job may be hard-deleted, and what deleting it would destroy.
   *
   * The load-bearing rule: a Job that carries any candidate application or
   * self-upgrade transaction is immutable evidence -- of a change that really
   * happened, or of a human having authorised one. Never deletable; Archive is
   * the answer.
   */
  deleteEligibility(id: string): {
    eligible: boolean;
    reason: string;
    removes: string[];
    preserves: string[];
  } {
    const job = this.get(id);
    if (!job) return { eligible: false, reason: 'job not found', removes: [], preserves: [] };

    const has = (sql: string) => Boolean(this.db.prepare(sql).get(id));
    // ANY application row, not just the ones that reached a repository. An
    // `approved` row records that a human authorised this candidate and a
    // `failed` row records that the attempt happened; `candidate_applications`
    // cascades from `jobs`, so deleting the Job erased that decision outright.
    const applied = has('SELECT 1 FROM candidate_applications WHERE job_id = ?');
    const upgraded = has('SELECT 1 FROM upgrade_transactions WHERE job_id = ?');
    if (applied || upgraded) {
      return {
        eligible: false,
        reason:
          'this candidate carries application or self-upgrade evidence, which is immutable. ' +
          'Archive it instead.',
        removes: [],
        preserves: ['application record', 'upgrade transaction', 'verification and review history'],
      };
    }
    if (!isFinished(job)) {
      return {
        eligible: false,
        reason: `job is ${job.stage}; cancel it and let its worktree be released first`,
        removes: [],
        preserves: [],
      };
    }
    const removes = [
      ...(job.worktreePath ? ['disposable candidate worktree'] : []),
      ...(job.branch ? ['candidate branch'] : []),
      'screenshots and captured artifacts',
      'verification, review and agent-run records',
      'disposable context packs',
    ];
    return {
      eligible: true,
      reason:
        job.stage === 'awaiting_user' || job.stage === 'paused'
          ? 'the candidate was never applied; deleting abandons it'
          : 'this Job produced no applied change',
      removes,
      preserves: ['the repository itself', 'project and user memory', 'the deletion audit record'],
    };
  }

  /**
   * Erase a Job's disposable rows and leave a tombstone.
   *
   * Filesystem cleanup (worktree, artifacts) happens in JobLifecycle before this
   * is called: by the time the rows go, the paths they name are already gone.
   */
  hardDelete(id: string, reason = 'deleted by the user'): JobTombstone | null {
    const job = this.get(id);
    if (!job) return null;
    const eligibility = this.deleteEligibility(id);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const tombstone: JobTombstone = {
      id: job.id,
      sessionId: job.sessionId,
      projectId: job.projectId,
      goal: job.goal,
      reason: redactSecrets(reason).slice(0, 500),
      deletedAt: nowIso(),
    };
    transaction(this.db, () => {
      // The episode is a disposable Job episode: it exists only to summarise
      // this Job. Durable project knowledge learned during it is a separate row
      // and is deliberately left alone.
      if (job.episodeId) {
        this.db
          .prepare(`DELETE FROM memories WHERE id = ? AND kind = 'episode' AND subject = ?`)
          .run(job.episodeId, `job.${job.id}`);
      }
      this.db.prepare('DELETE FROM context_packs WHERE job_id = ?').run(id);
      // agent_runs / verifications / reviews / visual_qa all cascade from jobs.
      this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO job_tombstones (id, session_id, project_id, goal, reason, deleted_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          tombstone.id,
          tombstone.sessionId,
          tombstone.projectId,
          tombstone.goal,
          tombstone.reason,
          tombstone.deletedAt,
        );
    });
    // Emitted after the row is gone: the audit trail of a deletion is the event
    // log and the tombstone, never the Job that no longer exists.
    this.bus.emit({
      type: 'job.deleted',
      sessionId: tombstone.sessionId,
      payload: { jobId: id, goal: tombstone.goal, reason: tombstone.reason },
    });
    return tombstone;
  }

  tombstone(id: string): JobTombstone | null {
    const row = this.db.prepare('SELECT * FROM job_tombstones WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      sessionId: (row.session_id as string) ?? null,
      projectId: (row.project_id as string) ?? null,
      goal: row.goal as string,
      reason: (row.reason as string) ?? '',
      deletedAt: row.deleted_at as string,
    };
  }

  tombstonesForSession(sessionId: string): JobTombstone[] {
    const rows = this.db
      .prepare('SELECT id FROM job_tombstones WHERE session_id = ?')
      .all(sessionId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const tombstone = this.tombstone(row.id);
      return tombstone ? [tombstone] : [];
    });
  }

  /**
   * Create a fresh Job from a finished one.
   *
   * Deliberately a NEW Job against the project's current state: resurrecting a
   * stale candidate would re-use reviewed evidence that no longer describes the
   * target. The predecessor link is what keeps the history readable.
   */
  retryAsNew(id: string, overrides: { sessionId?: string | null } = {}): Job {
    const previous = this.get(id);
    if (!previous) throw new Error(`job not found: ${id}`);
    if (previous.validationOnly) {
      throw new Error('validation-only jobs pin an immutable candidate and cannot be re-run');
    }
    return this.create({
      projectId: previous.projectId,
      sessionId: overrides.sessionId ?? previous.sessionId,
      request: previous.request,
      goal: previous.goal,
      acceptance: previous.acceptance,
      ...(previous.visualQaConfig ? { visualQa: previous.visualQaConfig } : {}),
      predecessorJobId: previous.id,
      originMessageId: previous.originMessageId,
    });
  }

  // -------------------------------------------------------------- agent runs --

  startRun(input: {
    jobId: string;
    provider: string;
    model?: string | null;
    role: string;
    cwd: string;
    contextPackId?: string | null;
  }): AgentRun {
    const run: AgentRun = {
      id: newId('run'),
      jobId: input.jobId,
      provider: input.provider,
      model: input.model ?? null,
      role: input.role,
      externalSessionId: null,
      cwd: input.cwd,
      status: 'running',
      result: null,
      error: null,
      usage: {},
      contextPackId: input.contextPackId ?? null,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, job_id, provider, model, role, cwd, status, context_pack_id, started_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.jobId,
        run.provider,
        run.model,
        run.role,
        run.cwd,
        run.status,
        run.contextPackId,
        run.startedAt,
      );
    this.bus.emit({
      type: 'agent.started',
      jobId: input.jobId,
      runId: run.id,
      payload: { provider: run.provider, role: run.role, model: run.model },
    });
    return run;
  }

  finishRun(
    runId: string,
    patch: {
      status: string;
      result?: string;
      error?: string | null;
      externalSessionId?: string | null;
      usage?: Record<string, unknown>;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE agent_runs SET status=?, result=?, error=?, external_session_id=?, usage=?, ended_at=? WHERE id=?`,
      )
      .run(
        patch.status,
        patch.result === undefined ? null : redactSecrets(patch.result).slice(0, 40_000),
        patch.error === undefined || patch.error === null ? null : redactSecrets(patch.error),
        patch.externalSessionId ?? null,
        JSON.stringify(patch.usage ?? {}),
        nowIso(),
        runId,
      );
  }

  checkpointRunSession(runId: string, externalSessionId: string): void {
    this.db
      .prepare(
        `UPDATE agent_runs SET external_session_id=? WHERE id=? AND status='running' AND external_session_id IS NULL`,
      )
      .run(externalSessionId, runId);
  }

  runs(jobId: string): AgentRun[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at ASC')
      .all(jobId) as Row[];
    return rows.map(rowToRun);
  }

  /**
   * Crash recovery.
   *
   * Jobs are never resumed automatically. Their exact stage and worktree are
   * checkpointed as paused so an explicit resume can validate the workspace.
   */
  recoverInterrupted(): { jobs: number; runs: number } {
    const now = nowIso();
    const runs = Number(
      this.db
        .prepare(
          `UPDATE agent_runs SET status='interrupted', error=?, ended_at=? WHERE status='running'`,
        )
        .run('orchestrator restarted while this run was in flight', now).changes,
    );
    const stale = this.db
      .prepare(`SELECT id, stage FROM jobs WHERE status = 'running'`)
      .all() as Array<{ id: string; stage: JobStage }>;
    for (const job of stale) {
      this.db
        .prepare(
          `UPDATE jobs SET stage='paused', status='paused', resume_stage=?, restart_reason=?,
             updated_at=?, finished_at=NULL WHERE id=?`,
        )
        .run(job.stage, 'orchestrator_restart', now, job.id);
      this.bus.emit({
        type: 'system.recovery',
        jobId: job.id,
        payload: { reason: 'orchestrator_restart', stage: job.stage },
      });
    }
    return { jobs: stale.length, runs };
  }
}

/** A Job nothing is going to move on its own. */
function isFinished(job: Job): boolean {
  return ['completed', 'failed', 'cancelled', 'paused', 'awaiting_user'].includes(job.stage);
}

/** Trim a natural-language request into a one-line goal. Purely mechanical. */
export function normaliseGoal(request: string): string {
  const firstSentence = request.trim().split(/(?<=[.!?])\s+/)[0] ?? request.trim();
  const cleaned = firstSentence
    .replace(/^(?:jarvis[,: ]+)?(?:please\s+)?(?:can you\s+|could you\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const goal = cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
  return goal.charAt(0).toUpperCase() + goal.slice(1);
}
