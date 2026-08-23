import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../ids.js';
import { redactSecrets, scanForSecrets } from '../memory/secrets.js';
import { createLogger } from '../logger.js';
import {
  MAX_GRANTABLE_RISK,
  decide,
  previewDecision,
  riskExceeds,
  type PolicyDecision,
  type RiskLevel,
  type ToolActor,
} from './policy.js';

const log = createLogger('tools');

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  risk: RiskLevel;
  input: z.ZodType<TInput>;
  /** Hard ceiling for one invocation. Falls back to the registry default. */
  timeoutMs?: number;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

/** What a tool implementation is told about the call. */
export interface ToolContext {
  actor: ToolActor;
  sessionId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  agentRunId?: string | null;
  /** Id of the audit row for this invocation. */
  executionId: string;
}

/**
 * What a call site passes in. `actor` is the caller's own identity, asserted in
 * code, never taken from a request body — see docs/tool-permissions.md.
 */
export interface ToolCallContext {
  actor: ToolActor;
  sessionId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  agentRunId?: string | null;
  /** Voluntary extra ceiling. Can only tighten what the actor is already allowed. */
  maxRisk?: RiskLevel | undefined;
}

export type ToolExecutionStatus =
  'pending_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'interrupted';

export interface ToolExecution {
  id: string;
  toolName: string;
  risk: RiskLevel;
  actor: ToolActor;
  decision: PolicyDecision;
  status: ToolExecutionStatus;
  reason: string;
  sessionId: string | null;
  projectId: string | null;
  jobId: string | null;
  agentRunId: string | null;
  input: unknown;
  /**
   * Whether `input` is the schema-validated payload the tool would receive.
   * Denied and malformed attempts keep their arguments for the audit trail only
   * — redacted, and never eligible to be replayed.
   */
  inputValidated: boolean;
  result: unknown;
  error: string | null;
  grantId: string | null;
  approvedBy: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  updatedAt: string;
}

export interface ToolGrant {
  id: string;
  toolName: string;
  actor: ToolActor;
  projectId: string | null;
  sessionId: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface GrantInput {
  toolName: string;
  actor: ToolActor;
  projectId?: string | null;
  sessionId?: string | null;
  note?: string | null;
  expiresAt?: string | null;
}

export type ToolExecutionOutcome =
  | { status: 'succeeded'; execution: ToolExecution; result: unknown }
  | { status: 'failed'; execution: ToolExecution; error: string }
  | { status: 'denied'; execution: ToolExecution; error: string }
  | { status: 'pending_approval'; execution: ToolExecution };

export class ToolPermissionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolPermissionError';
  }
}

export interface ToolRegistryOptions {
  db: Db;
  bus: EventBus;
  /** Default per-invocation timeout. */
  defaultTimeoutMs?: number;
  /** How long an unanswered approval request stays actionable. */
  approvalTtlMs?: number;
  /**
   * Ceiling on the JSON kept per input/result. Results above it are truncated;
   * arguments above it are refused, because a truncated payload must never be
   * replayed by an approval.
   */
  maxRecordChars?: number;
}

type Row = Record<string, unknown>;

/**
 * The single execution boundary for every tool Jarvis can run.
 *
 * Three properties are load-bearing and everything else is detail:
 *
 * 1. The tool table is a genuinely private field with no accessor. There is no way to
 *    obtain a `ToolDefinition` and call `.execute()` behind the policy — the
 *    only path from "a tool exists" to "a tool ran" goes through this class.
 * 2. Privilege comes from the caller's `actor`, decided by the policy. Nothing
 *    a caller *passes* can raise its own ceiling; `maxRisk` only lowers it.
 * 3. Every attempt is persisted before it runs, so a crash mid-action leaves
 *    evidence instead of an unexplained side effect.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never, unknown>>();
  readonly #db: Db;
  readonly #bus: EventBus;
  readonly #defaultTimeoutMs: number;
  readonly #approvalTtlMs: number;
  readonly #maxRecordChars: number;

  constructor(options: ToolRegistryOptions) {
    this.#db = options.db;
    this.#bus = options.bus;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.#approvalTtlMs = options.approvalTtlMs ?? 24 * 60 * 60_000;
    this.#maxRecordChars = options.maxRecordChars ?? 4000;
  }

  // ------------------------------------------------------------------ catalog

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.#tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool as unknown as ToolDefinition<never, unknown>);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Catalog for the UI and for agent prompts. Never exposes the implementation. */
  list(actor: ToolActor = 'user'): Array<{
    name: string;
    description: string;
    risk: RiskLevel;
    decision: PolicyDecision;
    schema: unknown;
  }> {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      decision: previewDecision(tool.risk, actor),
      schema: z.toJSONSchema(tool.input as z.ZodType),
    }));
  }

  // ---------------------------------------------------------------- execution

  /**
   * Ask to run a tool. Returns the outcome instead of throwing for policy or
   * input problems: a denial is a normal, recorded result, not an exception the
   * caller might swallow. Only an unknown tool throws, because that is a bug.
   */
  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolExecutionOutcome> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);

    // Decide before touching the input: a caller that may not run this tool
    // gets no validation feedback and reaches no tool code at all.
    const grant = this.#matchingGrant(name, ctx);
    const outcome = decide({
      risk: tool.risk,
      actor: ctx.actor,
      hasGrant: !!grant,
      maxRisk: ctx.maxRisk,
    });

    if (outcome.decision === 'deny') {
      // The attempt itself is the interesting audit record, so keep the raw
      // arguments — redacted and bounded by #record, and never replayed.
      const execution = this.#insert({
        tool,
        ctx,
        decision: 'deny',
        status: 'denied',
        reason: outcome.reason,
        inputJson: this.#record(rawInput ?? null),
        grantId: null,
      });
      this.#emit('tool.execution.denied', execution);
      return { status: 'denied', execution, error: outcome.reason };
    }

    const parsed = (tool.input as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      const message = `invalid input for ${name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`.trim())
        .join('; ')}`;
      const execution = this.#insert({
        tool,
        ctx,
        decision: outcome.decision,
        status: 'failed',
        reason: 'invalid_input',
        inputJson: this.#record(rawInput ?? null),
        grantId: grant?.id ?? null,
        error: message,
      });
      this.#emit('tool.execution.failed', execution);
      return { status: 'failed', execution, error: message };
    }

    /** Refuse without keeping the arguments, and still leave an audit row. */
    const refuse = (reason: string, message: string): ToolExecutionOutcome => {
      const execution = this.#insert({
        tool,
        ctx,
        decision: 'deny',
        status: 'denied',
        reason,
        inputJson: null,
        grantId: null,
        error: message,
      });
      this.#emit('tool.execution.denied', execution);
      return { status: 'denied', execution, error: message };
    };

    // Accepted arguments are stored verbatim, because an approval that outlives
    // the process replays exactly this payload. That forces three guarantees:
    // they must round-trip through JSON, must not contain a credential, and
    // must not be truncated.
    const serialized = safeJson(parsed.data);
    if (serialized === null) {
      return refuse('unserialisable_input', 'refused: the arguments are not serialisable');
    }
    const secrets = scanForSecrets(serialized);
    if (!secrets.clean) {
      return refuse(
        'secret_in_input',
        'refused: the arguments contain what looks like a credential ' +
          `(${secrets.matches.join(', ')})`,
      );
    }
    if (serialized.length > this.#maxRecordChars) {
      return refuse(
        'input_too_large',
        `refused: ${serialized.length} characters of arguments exceeds ` +
          `the ${this.#maxRecordChars} character limit`,
      );
    }

    const execution = this.#insert({
      tool,
      ctx,
      decision: outcome.decision,
      status: outcome.decision === 'allow' ? 'running' : 'pending_approval',
      reason: outcome.reason,
      inputJson: serialized,
      grantId: grant?.id ?? null,
    });

    if (outcome.decision === 'confirm') {
      this.#emit('tool.execution.requested', execution);
      return { status: 'pending_approval', execution };
    }

    this.#emit('tool.execution.started', execution);
    return this.#run(tool, execution, parsed.data);
  }

  /**
   * Approve a pending request and run it. The stored, already-validated input is
   * re-used verbatim: approving cannot be turned into approving something else.
   */
  async approve(
    executionId: string,
    options: { remember?: Omit<GrantInput, 'toolName' | 'actor'> } = {},
  ): Promise<ToolExecutionOutcome> {
    const pending = this.getExecution(executionId);
    if (!pending) throw new ToolPermissionError('tool execution not found', 'execution_not_found');
    if (pending.status !== 'pending_approval') {
      throw new ToolPermissionError(
        `execution is ${pending.status}, not awaiting approval`,
        'execution_not_pending',
      );
    }

    const tool = this.#tools.get(pending.toolName);
    if (!tool) {
      const failed = this.#finish(executionId, 'failed', {
        error: `tool ${pending.toolName} is no longer registered`,
      });
      return { status: 'failed', execution: failed, error: failed.error ?? 'tool missing' };
    }

    // Re-decide at approval time. A tool re-classified as riskier since the
    // request was made, or a row edited underneath us, must not sail through.
    const recheck = decide({
      risk: tool.risk,
      actor: pending.actor,
      hasGrant: false,
      maxRisk: undefined,
    });
    if (recheck.decision === 'deny') {
      const denied = this.#finish(executionId, 'denied', { error: recheck.reason });
      this.#emit('tool.execution.denied', denied);
      return { status: 'denied', execution: denied, error: recheck.reason };
    }

    const parsed = (tool.input as z.ZodType).safeParse(pending.input);
    if (!parsed.success) {
      const message = `stored arguments no longer validate against ${tool.name}`;
      const failed = this.#finish(executionId, 'failed', { error: message });
      this.#emit('tool.execution.failed', failed);
      return { status: 'failed', execution: failed, error: message };
    }

    // Refuse an impossible "always allow" before claiming the row: throwing
    // after the claim would strand the execution in `running` forever.
    if (options.remember && riskExceeds(tool.risk, MAX_GRANTABLE_RISK)) {
      throw new ToolPermissionError(
        `${tool.risk} actions always need a human; they cannot be remembered as always-allow`,
        'grant_not_permitted',
      );
    }

    // Conditional claim: two concurrent approvals cannot both start the tool.
    const claimed = this.#db
      .prepare(
        `UPDATE tool_executions SET status='running', approved_by='user', started_at=?, updated_at=?
         WHERE id=? AND status='pending_approval'`,
      )
      .run(nowIso(), nowIso(), executionId);
    if (Number(claimed.changes) !== 1) {
      throw new ToolPermissionError('execution was already answered', 'execution_not_pending');
    }

    if (options.remember) {
      this.grant({
        toolName: pending.toolName,
        actor: pending.actor,
        projectId: options.remember.projectId ?? pending.projectId,
        sessionId: options.remember.sessionId ?? null,
        note: options.remember.note ?? null,
        expiresAt: options.remember.expiresAt ?? null,
      });
    }

    const execution = this.getExecution(executionId);
    if (!execution) throw new ToolPermissionError('tool execution vanished', 'execution_not_found');
    this.#emit('tool.execution.approved', execution);
    return this.#run(tool, execution, parsed.data);
  }

  /**
   * Refuse a pending request. Recorded, not deleted. `decision` deliberately
   * keeps saying `confirm`: it records what the policy asked for, while `status`
   * records what the user answered. Conflating the two would also mark the
   * arguments unreplayable, and refusing something is not a reason to stop the
   * user from asking for it again.
   */
  deny(executionId: string, reason = 'declined by the user'): ToolExecution {
    const changed = this.#db
      .prepare(
        `UPDATE tool_executions SET status='denied', reason=?, error=?,
           finished_at=?, updated_at=? WHERE id=? AND status='pending_approval'`,
      )
      .run(reason, reason, nowIso(), nowIso(), executionId);
    if (Number(changed.changes) !== 1) {
      throw new ToolPermissionError('execution is not awaiting approval', 'execution_not_pending');
    }
    const execution = this.getExecution(executionId);
    if (!execution)
      throw new ToolPermissionError('tool execution not found', 'execution_not_found');
    this.#emit('tool.execution.denied', execution);
    return execution;
  }

  /**
   * Re-issue a finished execution as a brand new request. Interrupted and failed
   * actions are never replayed automatically — Jarvis cannot know a tool is
   * idempotent, so resuming is always the user's explicit decision.
   */
  async retry(executionId: string, actor: ToolActor = 'user'): Promise<ToolExecutionOutcome> {
    const previous = this.getExecution(executionId);
    if (!previous) throw new ToolPermissionError('tool execution not found', 'execution_not_found');
    if (previous.status === 'pending_approval' || previous.status === 'running') {
      throw new ToolPermissionError(
        `execution is still ${previous.status}`,
        'execution_not_finished',
      );
    }
    // Stored arguments of a rejected attempt are redacted audit text, not a
    // faithful payload. Replaying them would run the tool with mangled input.
    if (!previous.inputValidated) {
      throw new ToolPermissionError(
        'this attempt was rejected before its arguments were accepted; issue it again instead',
        'input_not_replayable',
      );
    }
    return this.execute(previous.toolName, previous.input ?? {}, {
      actor,
      sessionId: previous.sessionId,
      projectId: previous.projectId,
      jobId: previous.jobId,
    });
  }

  async #run(
    tool: ToolDefinition<never, unknown>,
    execution: ToolExecution,
    input: unknown,
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    const timeoutMs = tool.timeoutMs ?? this.#defaultTimeoutMs;
    let timer: NodeJS.Timeout | undefined;

    try {
      const result = await Promise.race([
        tool.execute(input as never, {
          actor: execution.actor,
          sessionId: execution.sessionId,
          projectId: execution.projectId,
          jobId: execution.jobId,
          agentRunId: execution.agentRunId,
          executionId: execution.id,
        }),
        // ponytail: a timeout records the failure but cannot cancel the
        // underlying work — Node has no generic cancellation. Tools that own a
        // child process or socket should honour their own abort; wire an
        // AbortSignal through ToolContext if that ever becomes common.
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`tool timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      const finished = this.#finish(execution.id, 'succeeded', {
        result,
        durationMs: Date.now() - startedAt,
      });
      this.#emit('tool.execution.completed', finished);
      return { status: 'succeeded', execution: finished, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finished = this.#finish(execution.id, 'failed', {
        error: message,
        durationMs: Date.now() - startedAt,
      });
      this.#emit('tool.execution.failed', finished);
      return { status: 'failed', execution: finished, error: message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------- grants

  grant(input: GrantInput): ToolGrant {
    const tool = this.#tools.get(input.toolName);
    if (!tool) throw new Error(`unknown tool: ${input.toolName}`);
    // The policy would ignore such a grant anyway; refusing to create it is the
    // difference between an honest error and a permission the user believes in.
    if (riskExceeds(tool.risk, MAX_GRANTABLE_RISK)) {
      throw new ToolPermissionError(
        `${tool.risk} actions always need a human; they cannot be remembered as always-allow`,
        'grant_not_permitted',
      );
    }
    const id = newId('grn');
    const createdAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO tool_grants
           (id, tool_name, actor, project_id, session_id, note, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.toolName,
        input.actor,
        input.projectId ?? null,
        input.sessionId ?? null,
        input.note ?? null,
        createdAt,
        input.expiresAt ?? null,
      );
    const grant = this.getGrant(id);
    if (!grant) throw new Error('grant insert failed');
    this.#bus.emit({
      type: 'tool.permission.granted',
      sessionId: grant.sessionId,
      payload: { ...grant },
    });
    return grant;
  }

  getGrant(id: string): ToolGrant | null {
    const sql = 'SELECT * FROM tool_grants WHERE id = ?';
    const row = this.#db.prepare(sql).get(id);
    return row ? rowToGrant(row as Row) : null;
  }

  grants(includeInactive = false): ToolGrant[] {
    const rows = includeInactive
      ? this.#db.prepare('SELECT * FROM tool_grants ORDER BY created_at DESC').all()
      : this.#db
          .prepare(
            `SELECT * FROM tool_grants
              WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY created_at DESC`,
          )
          .all(nowIso());
    return (rows as Row[]).map(rowToGrant);
  }

  revokeGrant(id: string): boolean {
    const changed = this.#db
      .prepare('UPDATE tool_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), id);
    if (Number(changed.changes) !== 1) return false;
    this.#bus.emit({ type: 'tool.permission.revoked', payload: { grantId: id } });
    return true;
  }

  /**
   * A grant matches when it is for this tool and actor and its scope contains
   * the call's context. A null scope column means "any"; a set one must match
   * exactly, so a project-scoped permission never leaks to another project.
   */
  #matchingGrant(toolName: string, ctx: ToolCallContext): ToolGrant | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM tool_grants
          WHERE tool_name = ? AND actor = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND (project_id IS NULL OR project_id = ?)
            AND (session_id IS NULL OR session_id = ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(toolName, ctx.actor, nowIso(), ctx.projectId ?? null, ctx.sessionId ?? null);
    return row ? rowToGrant(row as Row) : null;
  }

  // -------------------------------------------------------------- audit trail

  getExecution(id: string): ToolExecution | null {
    const sql = 'SELECT * FROM tool_executions WHERE id = ?';
    const row = this.#db.prepare(sql).get(id);
    return row ? rowToExecution(row as Row) : null;
  }

  executions(
    filter: {
      status?: ToolExecutionStatus;
      toolName?: string;
      jobId?: string;
      projectId?: string;
      limit?: number;
    } = {},
  ): ToolExecution[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ['status', filter.status],
      ['tool_name', filter.toolName],
      ['job_id', filter.jobId],
      ['project_id', filter.projectId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    const rows = this.#db
      .prepare(
        `SELECT * FROM tool_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(rowToExecution);
  }

  pending(): ToolExecution[] {
    return this.executions({ status: 'pending_approval', limit: 200 });
  }

  // ----------------------------------------------------------------- recovery

  /**
   * Startup reconciliation. Anything left `running` died with the process: the
   * side effect may or may not have happened, so it is marked `interrupted` and
   * surfaced, never silently retried. Stale approval requests expire so an old
   * prompt cannot be answered months later against changed state.
   */
  recoverInterrupted(now = Date.now()): { interrupted: number; expired: number } {
    const timestamp = nowIso();
    const running = this.#db
      .prepare("SELECT id FROM tool_executions WHERE status = 'running'")
      .all() as Array<{ id: string }>;
    for (const row of running) {
      this.#db
        .prepare(
          `UPDATE tool_executions SET status='interrupted', error=?, finished_at=?, updated_at=?
           WHERE id=? AND status='running'`,
        )
        .run(
          'Jarvis restarted while this tool was running; its effect is unknown. Re-run it only if that is safe.',
          timestamp,
          timestamp,
          row.id,
        );
      const execution = this.getExecution(row.id);
      if (execution) this.#emit('tool.execution.interrupted', execution);
    }

    const cutoff = new Date(now - this.#approvalTtlMs).toISOString();
    const stale = this.#db
      .prepare(
        "SELECT id FROM tool_executions WHERE status='pending_approval' AND requested_at < ?",
      )
      .all(cutoff) as Array<{ id: string }>;
    for (const row of stale) {
      this.#db
        .prepare(
          `UPDATE tool_executions SET status='expired', error=?, finished_at=?, updated_at=?
           WHERE id=? AND status='pending_approval'`,
        )
        .run('the approval request expired before it was answered', timestamp, timestamp, row.id);
      const execution = this.getExecution(row.id);
      if (execution) this.#emit('tool.execution.expired', execution);
    }

    if (running.length || stale.length) {
      log.warn('reconciled tool executions after restart', {
        interrupted: running.length,
        expired: stale.length,
      });
    }
    return { interrupted: running.length, expired: stale.length };
  }

  /** Drop audit rows older than the retention window. 0 keeps them forever. */
  pruneAudit(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
    const changed = this.#db
      .prepare(
        `DELETE FROM tool_executions
          WHERE requested_at < ? AND status NOT IN ('pending_approval','running')`,
      )
      .run(cutoff);
    return Number(changed.changes);
  }

  // ------------------------------------------------------------------ storage

  #insert(args: {
    tool: ToolDefinition<never, unknown>;
    ctx: ToolCallContext;
    decision: PolicyDecision;
    status: ToolExecutionStatus;
    reason: string;
    /** Already serialised by the caller, which decides faithful vs audit-only. */
    inputJson: string | null;
    grantId: string | null;
    error?: string;
  }): ToolExecution {
    const id = newId('tex');
    const timestamp = nowIso();
    const terminal = args.status === 'denied' || args.status === 'failed';
    this.#db
      .prepare(
        `INSERT INTO tool_executions
           (id, tool_name, risk, actor, decision, status, reason, session_id, project_id, job_id,
            agent_run_id, input, error, grant_id, requested_at, started_at, finished_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        args.tool.name,
        args.tool.risk,
        args.ctx.actor,
        args.decision,
        args.status,
        args.reason,
        args.ctx.sessionId ?? null,
        args.ctx.projectId ?? null,
        args.ctx.jobId ?? null,
        args.ctx.agentRunId ?? null,
        args.inputJson,
        args.error ?? null,
        args.grantId,
        timestamp,
        args.status === 'running' ? timestamp : null,
        terminal ? timestamp : null,
        timestamp,
      );
    const execution = this.getExecution(id);
    if (!execution) throw new Error('tool execution insert failed');
    return execution;
  }

  #finish(
    id: string,
    status: ToolExecutionStatus,
    patch: { result?: unknown; error?: string; durationMs?: number },
  ): ToolExecution {
    const timestamp = nowIso();
    this.#db
      .prepare(
        `UPDATE tool_executions SET status=?, result=?, error=?, duration_ms=?, finished_at=?,
           updated_at=? WHERE id=?`,
      )
      .run(
        status,
        patch.result === undefined ? null : this.#record(patch.result),
        patch.error ?? null,
        patch.durationMs ?? null,
        timestamp,
        timestamp,
        id,
      );
    const execution = this.getExecution(id);
    if (!execution) throw new Error(`tool execution ${id} disappeared`);
    return execution;
  }

  /**
   * Serialise for the audit log: redacted and bounded. A tool result can echo
   * text that matches a credential pattern, and the log is long-lived.
   */
  #record(value: unknown): string {
    const redacted = redactSecrets(safeJson(value) ?? '"[unserialisable]"');
    return redacted.length > this.#maxRecordChars
      ? JSON.stringify({
          truncated: true,
          chars: redacted.length,
          preview: redacted.slice(0, this.#maxRecordChars),
        })
      : redacted;
  }

  #emit(
    type:
      | 'tool.execution.requested'
      | 'tool.execution.approved'
      | 'tool.execution.denied'
      | 'tool.execution.started'
      | 'tool.execution.completed'
      | 'tool.execution.failed'
      | 'tool.execution.interrupted'
      | 'tool.execution.expired',
    execution: ToolExecution,
  ): void {
    this.#bus.emit({
      type,
      jobId: execution.jobId,
      sessionId: execution.sessionId,
      payload: {
        executionId: execution.id,
        tool: execution.toolName,
        risk: execution.risk,
        actor: execution.actor,
        status: execution.status,
        reason: execution.reason,
        ...(execution.error ? { error: execution.error } : {}),
      },
    });
  }
}

/** JSON or nothing. `null` means the value cannot be persisted faithfully. */
function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value ?? null) ?? null;
  } catch {
    return null;
  }
}

function parseRecord(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function rowToExecution(row: Row): ToolExecution {
  return {
    id: row.id as string,
    toolName: row.tool_name as string,
    risk: row.risk as RiskLevel,
    actor: row.actor as ToolActor,
    decision: row.decision as PolicyDecision,
    status: row.status as ToolExecutionStatus,
    reason: (row.reason as string) ?? '',
    sessionId: (row.session_id as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    jobId: (row.job_id as string) ?? null,
    agentRunId: (row.agent_run_id as string) ?? null,
    input: parseRecord(row.input),
    inputValidated: row.decision !== 'deny' && row.reason !== 'invalid_input',
    result: parseRecord(row.result),
    error: (row.error as string) ?? null,
    grantId: (row.grant_id as string) ?? null,
    approvedBy: (row.approved_by as string) ?? null,
    requestedAt: row.requested_at as string,
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
    updatedAt: row.updated_at as string,
  };
}

function rowToGrant(row: Row): ToolGrant {
  return {
    id: row.id as string,
    toolName: row.tool_name as string,
    actor: row.actor as ToolActor,
    projectId: (row.project_id as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    note: (row.note as string) ?? null,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string) ?? null,
    revokedAt: (row.revoked_at as string) ?? null,
  };
}
