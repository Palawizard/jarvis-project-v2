import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import { assertTransition, isTerminal, statusForStage, type JobStage, type JobStatus } from './machine.js';

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
  episodeId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
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
    episodeId: (row.episode_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    finishedAt: (row.finished_at as string) ?? null,
  };
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
  }): Job {
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
      episodeId: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, session_id, project_id, request, goal, acceptance, stage, status,
          fix_cycles, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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

  list(filter: { projectId?: string; status?: JobStatus; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, filter.limit ?? 50) as Row[];
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
    const finishedAt = isTerminal(to) && to !== 'awaiting_user' ? now : (patch.finishedAt ?? job.finishedAt);

    this.db
      .prepare(
        `UPDATE jobs SET stage=?, status=?, error=?, branch=?, worktree_path=?, base_ref=?, head_ref=?,
          fix_cycles=?, episode_id=?, goal=?, acceptance=?, updated_at=?, finished_at=? WHERE id=?`,
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
    if (to === 'failed') this.bus.emit({ type: 'job.failed', jobId: id, payload: { error: next.error } });
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
          episode_id=?, goal=?, acceptance=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.error,
        next.branch,
        next.worktreePath,
        next.baseRef,
        next.headRef,
        next.fixCycles,
        next.episodeId,
        next.goal,
        JSON.stringify(next.acceptance),
        nowIso(),
        id,
      );
    return next;
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
      .run(run.id, run.jobId, run.provider, run.model, run.role, run.cwd, run.status, run.contextPackId, run.startedAt);
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
        patch.result?.slice(0, 40_000) ?? null,
        patch.error ?? null,
        patch.externalSessionId ?? null,
        JSON.stringify(patch.usage ?? {}),
        nowIso(),
        runId,
      );
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
   * Any job left mid-flight by a killed orchestrator is marked failed with an
   * explicit reason. We never resume automatically: the worktree state after an
   * abrupt kill is unknown, and silently continuing would be worse than saying so.
   */
  recoverInterrupted(): { jobs: number; runs: number } {
    const now = nowIso();
    const runs = Number(
      this.db
        .prepare(`UPDATE agent_runs SET status='interrupted', error=?, ended_at=? WHERE status='running'`)
        .run('orchestrator restarted while this run was in flight', now).changes,
    );
    const stale = this.db
      .prepare(`SELECT id, stage FROM jobs WHERE status = 'running'`)
      .all() as Array<{ id: string; stage: JobStage }>;
    for (const job of stale) {
      this.db
        .prepare(`UPDATE jobs SET stage='failed', status='failed', error=?, updated_at=?, finished_at=? WHERE id=?`)
        .run(`Orchestrator restarted during stage "${job.stage}". Worktree preserved; re-run to continue.`, now, now, job.id);
      this.bus.emit({
        type: 'system.recovery',
        jobId: job.id,
        payload: { reason: 'orchestrator_restart', stage: job.stage },
      });
    }
    return { jobs: stale.length, runs };
  }
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
