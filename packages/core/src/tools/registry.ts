import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { transaction, type Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../ids.js';
import { redactSecrets, scanForSecrets } from '../memory/secrets.js';
import { createLogger } from '../logger.js';
import {
  MAX_GRANTABLE_RISK,
  decide,
  isGrantableActor,
  previewDecision,
  riskExceeds,
  type PolicyDecision,
  type PolicyReasonCode,
  type RiskLevel,
  type ToolActor,
} from './policy.js';

const log = createLogger('tools');

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  risk: RiskLevel;
  /** Bump when the schema or security-relevant meaning changes. */
  revision: string;
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
  /**
   * Aborted when this invocation's timeout fires.
   *
   * Honouring it is how a tool turns "Jarvis stopped waiting" into "the work
   * actually stopped". Nothing forces it to: an uncooperative tool keeps running
   * and may still produce its side effect long after Jarvis recorded a timeout.
   * That is precisely why a timeout is recorded as `timed_out` and not as an
   * ordinary failure. Pass it to fetch, to spawn, or to your own cleanup.
   */
  signal: AbortSignal;
}

/**
 * What a call site passes in. `actor` is the caller's own identity, asserted in
 * code, never taken from a request body — see docs/tool-permissions.md.
 */
export interface ToolCallContext {
  actor: ToolActor;
  /** Original requester. Agent-originated user confirmations keep this as `agent`. */
  originatedBy?: ToolActor | undefined;
  sessionId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  agentRunId?: string | null;
  /** Voluntary extra ceiling. Can only tighten what the actor is already allowed. */
  maxRisk?: RiskLevel | undefined;
  /** Internal audit link used by explicit re-issue. */
  parentExecutionId?: string | null;
}

export type ToolExecutionStatus =
  | 'pending_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired'
  | 'interrupted'
  | 'timed_out';

type ExecutionReasonCode =
  | PolicyReasonCode
  | 'legacy'
  | 'invalid_input'
  | 'unserialisable_input'
  | 'noncanonical_input'
  | 'secret_in_input'
  | 'input_too_large';

/**
 * Outcomes after which Jarvis cannot say whether the tool's external effect
 * happened: the process died mid-call, or the call outlived its timeout and may
 * still be running. Re-issuing one of these can duplicate a real-world action,
 * so they are never replayed automatically and are labelled as such in the UI.
 */
export const EFFECT_UNKNOWN_STATUSES: readonly ToolExecutionStatus[] = ['interrupted', 'timed_out'];

export interface ToolExecution {
  id: string;
  toolName: string;
  risk: RiskLevel;
  definitionRevision: string | null;
  actor: ToolActor;
  originatingActor: ToolActor;
  decision: PolicyDecision;
  reasonCode: ExecutionReasonCode;
  status: ToolExecutionStatus;
  reason: string;
  sessionId: string | null;
  projectId: string | null;
  jobId: string | null;
  agentRunId: string | null;
  parentExecutionId: string | null;
  input: unknown;
  inputHash: string | null;
  /**
   * Whether `input` is the schema-validated payload the tool would receive.
   * Denied and malformed attempts keep their arguments for the audit trail only
   * — redacted, and never eligible to be replayed.
   */
  inputValidated: boolean;
  /**
   * True when Jarvis cannot say whether the tool's external effect happened.
   * A re-issue may therefore duplicate it. See EFFECT_UNKNOWN_STATUSES.
   */
  effectUnknown: boolean;
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
  risk: RiskLevel | null;
  definitionRevision: string | null;
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
  | { status: 'timed_out'; execution: ToolExecution; error: string; effectUnknown: true }
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
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(tool.revision)) {
      throw new Error(`invalid tool revision for ${tool.name}`);
    }
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
    // A trusted user-confirmation wrapper cannot turn an agent request into a
    // direct human request. Agent provenance centrally disables standing grants.
    const grant = ctx.originatedBy === 'agent' ? null : this.#matchingGrant(tool, ctx);
    const outcome = decide({
      risk: tool.risk,
      actor: ctx.actor,
      hasGrant: !!grant,
      maxRisk: ctx.maxRisk,
    });
    if (!grant && outcome.decision === 'allow' && this.#hasDriftedGrant(tool, ctx)) {
      outcome.decision = 'confirm';
      outcome.code = 'grant_definition_drift';
      outcome.reason = 'tool definition changed since the standing permission';
    }

    if (outcome.decision === 'deny') {
      // The attempt itself is the interesting audit record, so keep the raw
      // arguments — redacted and bounded by #record, and never replayed.
      const execution = this.#insert({
        tool,
        ctx,
        decision: 'deny',
        status: 'denied',
        reasonCode: outcome.code,
        reason: outcome.reason,
        inputJson: this.#record(rawInput ?? null),
        inputValidated: false,
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
        reasonCode: 'invalid_input',
        reason: 'invalid_input',
        inputJson: this.#record(rawInput ?? null),
        inputValidated: false,
        grantId: grant?.id ?? null,
        error: message,
      });
      this.#emit('tool.execution.failed', execution);
      return { status: 'failed', execution, error: message };
    }

    /** Refuse without keeping the arguments, and still leave an audit row. */
    const refuse = (
      reason: Exclude<ExecutionReasonCode, PolicyReasonCode | 'legacy' | 'invalid_input'>,
      message: string,
    ): ToolExecutionOutcome => {
      const execution = this.#insert({
        tool,
        ctx,
        decision: 'deny',
        status: 'denied',
        reasonCode: reason,
        reason,
        inputJson: null,
        inputValidated: false,
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
    const canonicalInput = JSON.parse(serialized) as unknown;
    if (!isDeepStrictEqual(parsed.data, canonicalInput)) {
      return refuse(
        'noncanonical_input',
        'refused: transformed arguments do not round-trip through canonical JSON',
      );
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
      reasonCode: outcome.code,
      reason: outcome.reason,
      inputJson: serialized,
      inputValidated: true,
      inputHash: canonicalHash(serialized),
      grantId: grant?.id ?? null,
    });

    if (outcome.decision === 'confirm') {
      this.#emit('tool.execution.requested', execution);
      return { status: 'pending_approval', execution };
    }

    this.#emit('tool.execution.started', execution);
    return this.#run(tool, execution, canonicalInput);
  }

  /**
   * Convert only an agent risk-ceiling denial into a linked, one-shot human
   * confirmation. The original canonical payload must match, and grants stay
   * disabled because the new execution retains `originatedBy: 'agent'`.
   */
  async escalateAgentRequest(
    executionId: string,
    rawInput: unknown,
  ): Promise<ToolExecutionOutcome> {
    const previous = this.getExecution(executionId);
    if (!previous) throw new ToolPermissionError('tool execution not found', 'execution_not_found');
    const refused = (): ToolExecutionOutcome => ({
      status: 'denied',
      execution: previous,
      error: previous.error ?? previous.reason,
    });
    if (
      previous.status !== 'denied' ||
      previous.actor !== 'agent' ||
      previous.originatingActor !== 'agent' ||
      previous.reasonCode !== 'actor_risk_ceiling'
    ) {
      return refused();
    }

    const tool = this.#tools.get(previous.toolName);
    if (
      !tool ||
      tool.risk !== previous.risk ||
      definitionRevision(tool) !== previous.definitionRevision ||
      decide({ risk: tool.risk, actor: 'user', hasGrant: false }).decision !== 'confirm'
    ) {
      return refused();
    }

    const parsed = (tool.input as z.ZodType).safeParse(rawInput);
    if (!parsed.success) return refused();
    const serialized = safeJson(parsed.data);
    if (serialized === null || serialized.length > this.#maxRecordChars) return refused();
    const canonicalInput = JSON.parse(serialized) as unknown;
    if (
      !isDeepStrictEqual(parsed.data, canonicalInput) ||
      !scanForSecrets(serialized).clean ||
      !isDeepStrictEqual(previous.input, canonicalInput)
    ) {
      return refused();
    }

    const outcome = await this.execute(previous.toolName, canonicalInput, {
      actor: 'user',
      originatedBy: 'agent',
      sessionId: previous.sessionId,
      projectId: previous.projectId,
      jobId: previous.jobId,
      agentRunId: previous.agentRunId,
      parentExecutionId: previous.id,
    });
    if (outcome.status === 'pending_approval' || outcome.status === 'denied') return outcome;
    throw new Error(
      `agent-originated escalation invariant violated: ${previous.toolName} became ${outcome.status}`,
    );
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

    if (
      pending.risk !== tool.risk ||
      pending.definitionRevision !== definitionRevision(tool) ||
      !pending.inputValidated ||
      !pending.inputHash ||
      canonicalHash(safeJson(pending.input) ?? '') !== pending.inputHash
    ) {
      const message =
        'tool definition or canonical input changed since review; create a new request';
      const failed = this.#finish(executionId, 'failed', { error: message });
      this.#emit('tool.execution.failed', failed);
      return { status: 'failed', execution: failed, error: message };
    }

    // Re-decide at approval time as a second policy guard.
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

    // Refuse an impossible "always allow" *before* claiming the row: throwing
    // after the claim would strand the execution in `running` forever. Both
    // rules are re-stated here rather than left to grant(), so that approving
    // the single invocation stays possible even when remembering it does not.
    if (
      options.remember &&
      (!isGrantableActor(pending.actor) || pending.originatingActor !== pending.actor)
    ) {
      throw new ToolPermissionError(
        "standing permissions are only for the user's own actions; agent-originated confirmations are one-shot; " +
          'approve this one invocation without remembering it',
        'grant_actor_not_permitted',
      );
    }
    if (options.remember && riskExceeds(tool.risk, MAX_GRANTABLE_RISK)) {
      throw new ToolPermissionError(
        `${tool.risk} actions always need a human; they cannot be remembered as always-allow`,
        'grant_not_permitted',
      );
    }
    const remember = options.remember
      ? {
          toolName: pending.toolName,
          actor: pending.actor,
          projectId: options.remember.projectId ?? pending.projectId,
          sessionId: options.remember.sessionId ?? null,
          note: options.remember.note ?? null,
          expiresAt: normaliseExpiry(options.remember.expiresAt ?? null),
        }
      : null;

    // Conditional claim. One statement decides three things at once, which is
    // what makes it safe under concurrency: the row is still pending, it has not
    // outlived its TTL, and this caller is the one that gets to run it. A
    // separate "is it expired?" read before the update would be a TOCTOU gap.
    const cutoff = this.#approvalCutoff();
    const claimed = transaction(this.#db, () => {
      const result = this.#db
        .prepare(
          `UPDATE tool_executions SET status='running', approved_by='user', started_at=?, updated_at=?
           WHERE id=? AND status='pending_approval' AND requested_at >= ?`,
        )
        .run(nowIso(), nowIso(), executionId, cutoff);
      if (Number(result.changes) === 1 && remember) this.#insertGrant(remember, remember.expiresAt);
      return result;
    });
    if (Number(claimed.changes) !== 1) {
      // Losing the claim means either somebody else answered first, or the
      // request aged out. Only the second case leaves a row to clean up.
      const expired = this.#expireStale(cutoff);
      const current = this.getExecution(executionId);
      if (expired > 0 && current?.status === 'expired') {
        throw new ToolPermissionError(
          'the approval request expired before it was answered',
          'execution_expired',
        );
      }
      throw new ToolPermissionError('execution was already answered', 'execution_not_pending');
    }

    const execution = this.getExecution(executionId);
    if (!execution) throw new ToolPermissionError('tool execution vanished', 'execution_not_found');
    this.#emit('tool.execution.approved', execution);
    return this.#run(tool, execution, pending.input);
  }

  /**
   * Refuse a pending request. Recorded, not deleted. `decision` deliberately
   * keeps saying `confirm`: it records what the policy asked for, while `status`
   * records what the user answered. Conflating the two would also mark the
   * arguments unreplayable, and refusing something is not a reason to stop the
   * user from asking for it again.
   */
  deny(executionId: string, reason = 'declined by the user'): ToolExecution {
    // The reason is caller-supplied text that is persisted and broadcast, so it
    // gets the same redaction and size bound as any other recorded tool error.
    const recorded = this.#recordError(reason);
    const changed = this.#db
      .prepare(
        `UPDATE tool_executions SET status='denied', reason=?, error=?,
           finished_at=?, updated_at=? WHERE id=? AND status='pending_approval'`,
      )
      .run(recorded, recorded, nowIso(), nowIso(), executionId);
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
  async retry(executionId: string): Promise<ToolExecutionOutcome> {
    const previous = this.getExecution(executionId);
    if (!previous) throw new ToolPermissionError('tool execution not found', 'execution_not_found');
    if (!['interrupted', 'timed_out', 'expired', 'failed'].includes(previous.status)) {
      throw new ToolPermissionError(
        `execution status ${previous.status} cannot be re-issued`,
        'execution_not_retryable',
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
    // The re-issue keeps the original actor: replaying an agent's action as the
    // user would hand it privilege it never had, and go through policy at the
    // wrong level.
    return this.execute(previous.toolName, previous.input ?? {}, {
      actor: previous.actor,
      originatedBy: previous.originatingActor,
      sessionId: previous.sessionId,
      projectId: previous.projectId,
      jobId: previous.jobId,
      agentRunId: previous.agentRunId,
      parentExecutionId: previous.id,
    });
  }

  /**
   * Run the tool under a timeout.
   *
   * The timeout aborts `ctx.signal` and stops waiting. It cannot *make* the work
   * stop: only a tool that watches the signal actually cancels, and Node offers
   * no way to force the rest. So the two cases are recorded differently — a
   * plain rejection is a deterministic `failed`, while a timeout is `timed_out`,
   * meaning the external effect may still land afterwards.
   */
  async #run(
    tool: ToolDefinition<never, unknown>,
    execution: ToolExecution,
    input: unknown,
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    const timeoutMs = tool.timeoutMs ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Start the work before racing so the losing branch can be neutralised: once
    // the race settles on the timeout, a later rejection from the tool would
    // otherwise surface as an unhandled rejection and take the process down.
    const work = (async () =>
      tool.execute(input as never, {
        actor: execution.actor,
        sessionId: execution.sessionId,
        projectId: execution.projectId,
        jobId: execution.jobId,
        agentRunId: execution.agentRunId,
        executionId: execution.id,
        signal: controller.signal,
      }))();
    work.catch(() => undefined);

    const abortion = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error(`tool timed out after ${timeoutMs}ms`)),
        { once: true },
      );
    });

    try {
      const result = await Promise.race([work, abortion]);
      const finished = this.#finish(execution.id, 'succeeded', {
        result,
        durationMs: Date.now() - startedAt,
      });
      this.#emit('tool.execution.completed', finished);
      return { status: 'succeeded', execution: finished, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A cooperative tool rejects *because* it saw the abort. Either way the
      // deadline is what ended this, so both land on the same honest status.
      const status: ToolExecutionStatus = timedOut ? 'timed_out' : 'failed';
      const detail = timedOut
        ? `${message}. The tool was asked to stop, but Jarvis cannot confirm it did: ` +
          'its effect on the outside world is unknown.'
        : message;
      const finished = this.#finish(execution.id, status, {
        error: detail,
        durationMs: Date.now() - startedAt,
      });
      this.#emit('tool.execution.failed', finished);
      return timedOut
        ? {
            status: 'timed_out',
            execution: finished,
            error: finished.error ?? 'tool timed out',
            effectUnknown: true,
          }
        : { status: 'failed', execution: finished, error: finished.error ?? 'tool failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------- grants

  /**
   * Create a standing permission. This is the boundary that enforces who may
   * hold one — deliberately here and not only on the HTTP route, because the
   * route is one caller among several and an in-process caller must not be able
   * to mint a permission the product does not offer.
   */
  grant(input: GrantInput): ToolGrant {
    const tool = this.#tools.get(input.toolName);
    if (!tool) throw new Error(`unknown tool: ${input.toolName}`);
    if (!isGrantableActor(input.actor)) {
      throw new ToolPermissionError(
        `standing permissions are only for the user's own actions, not for ${input.actor}`,
        'grant_actor_not_permitted',
      );
    }
    // The policy would ignore such a grant anyway; refusing to create it is the
    // difference between an honest error and a permission the user believes in.
    if (riskExceeds(tool.risk, MAX_GRANTABLE_RISK)) {
      throw new ToolPermissionError(
        `${tool.risk} actions always need a human; they cannot be remembered as always-allow`,
        'grant_not_permitted',
      );
    }
    return this.#insertGrant(input, normaliseExpiry(input.expiresAt ?? null));
  }

  #insertGrant(input: GrantInput, expiresAt: string | null): ToolGrant {
    const tool = this.#tools.get(input.toolName);
    if (!tool) throw new Error(`unknown tool: ${input.toolName}`);
    const id = newId('grn');
    const createdAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO tool_grants
           (id, tool_name, actor, risk, definition_revision, project_id, session_id, note,
            created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.toolName,
        input.actor,
        tool.risk,
        definitionRevision(tool),
        input.projectId ?? null,
        input.sessionId ?? null,
        input.note ?? null,
        createdAt,
        expiresAt,
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
              WHERE revoked_at IS NULL AND risk IS NOT NULL AND definition_revision IS NOT NULL
                AND (expires_at IS NULL OR expires_at > ?)
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
  #matchingGrant(tool: ToolDefinition, ctx: ToolCallContext): ToolGrant | null {
    // Fail closed for anyone who may not hold a grant, so a row written before
    // that rule existed (or straight into the database) still grants nothing.
    if (!isGrantableActor(ctx.actor)) return null;
    const row = this.#db
      .prepare(
        `SELECT * FROM tool_grants
          WHERE tool_name = ? AND actor = ? AND risk = ? AND definition_revision = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND (project_id IS NULL OR project_id = ?)
            AND (session_id IS NULL OR session_id = ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(
        tool.name,
        ctx.actor,
        tool.risk,
        definitionRevision(tool),
        nowIso(),
        ctx.projectId ?? null,
        ctx.sessionId ?? null,
      );
    return row ? rowToGrant(row as Row) : null;
  }

  #hasDriftedGrant(tool: ToolDefinition, ctx: ToolCallContext): boolean {
    if (!isGrantableActor(ctx.actor)) return false;
    return Boolean(
      this.#db
        .prepare(
          `SELECT 1 FROM tool_grants
            WHERE tool_name = ? AND actor = ? AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (project_id IS NULL OR project_id = ?)
              AND (session_id IS NULL OR session_id = ?)
              AND (risk IS NULL OR risk <> ? OR definition_revision IS NULL OR definition_revision <> ?)
            LIMIT 1`,
        )
        .get(
          tool.name,
          ctx.actor,
          nowIso(),
          ctx.projectId ?? null,
          ctx.sessionId ?? null,
          tool.risk,
          definitionRevision(tool),
        ),
    );
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
    // A negative LIMIT means "no limit" in SQLite, and NaN is a runtime error,
    // so the bound has to be clamped rather than merely capped.
    params.push(clampLimit(filter.limit));
    const rows = this.#db
      .prepare(
        `SELECT * FROM tool_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY requested_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(rowToExecution);
  }

  /**
   * Requests still awaiting an answer. Sweeps first, so a long-running Jarvis
   * never shows a request the user can no longer act on.
   */
  pending(): ToolExecution[] {
    this.#expireStale(this.#approvalCutoff());
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

    const expired = this.#expireStale(this.#approvalCutoff(now));

    if (running.length || expired) {
      log.warn('reconciled tool executions after restart', {
        interrupted: running.length,
        expired,
      });
    }
    return { interrupted: running.length, expired };
  }

  /** ISO timestamp before which a pending approval request is too old to answer. */
  #approvalCutoff(now = Date.now()): string {
    return new Date(now - this.#approvalTtlMs).toISOString();
  }

  /**
   * Expire pending requests older than the cutoff. Each transition is its own
   * conditional UPDATE, so a request being approved concurrently is either
   * claimed or expired, never both.
   */
  #expireStale(cutoff: string): number {
    const stale = this.#db
      .prepare(
        "SELECT id FROM tool_executions WHERE status='pending_approval' AND requested_at < ?",
      )
      .all(cutoff) as Array<{ id: string }>;
    let count = 0;
    for (const row of stale) {
      const timestamp = nowIso();
      const changed = this.#db
        .prepare(
          `UPDATE tool_executions SET status='expired', error=?, finished_at=?, updated_at=?
           WHERE id=? AND status='pending_approval'`,
        )
        .run('the approval request expired before it was answered', timestamp, timestamp, row.id);
      if (Number(changed.changes) !== 1) continue;
      count += 1;
      const execution = this.getExecution(row.id);
      if (execution) this.#emit('tool.execution.expired', execution);
    }
    return count;
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
    reasonCode: ExecutionReasonCode;
    reason: string;
    /** Already serialised by the caller, which decides faithful vs audit-only. */
    inputJson: string | null;
    inputValidated: boolean;
    inputHash?: string | null;
    grantId: string | null;
    error?: string;
  }): ToolExecution {
    const id = newId('tex');
    const timestamp = nowIso();
    const terminal = args.status === 'denied' || args.status === 'failed';
    this.#db
      .prepare(
        `INSERT INTO tool_executions
           (id, tool_name, risk, definition_revision, actor, originating_actor, decision, status,
            reason_code, reason, session_id,
            project_id, job_id, agent_run_id, parent_execution_id, input, input_hash,
            input_validated, error, grant_id, requested_at, started_at, finished_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        args.tool.name,
        args.tool.risk,
        definitionRevision(args.tool),
        args.ctx.actor,
        args.ctx.originatedBy ?? args.ctx.actor,
        args.decision,
        args.status,
        args.reasonCode,
        args.reason,
        args.ctx.sessionId ?? null,
        args.ctx.projectId ?? null,
        args.ctx.jobId ?? null,
        args.ctx.agentRunId ?? null,
        args.ctx.parentExecutionId ?? null,
        args.inputJson,
        args.inputHash ?? null,
        args.inputValidated ? 1 : 0,
        args.error === undefined ? null : this.#recordError(args.error),
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
        patch.error === undefined ? null : this.#recordError(patch.error),
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

  #recordError(value: string): string {
    return redactSecrets(value).slice(0, this.#maxRecordChars);
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
        originatingActor: execution.originatingActor,
        parentExecutionId: execution.parentExecutionId,
        status: execution.status,
        reason: execution.reason,
        ...(execution.error ? { error: execution.error } : {}),
      },
    });
  }
}

/** SQLite treats a negative LIMIT as unbounded, so clamp into a real range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}

/**
 * Canonical ISO-8601, or a thrown error.
 *
 * Expiry is compared lexically in SQL, which is only sound when every stored
 * value has the same shape. Accepting "tomorrow" or "2026-13-99" would store a
 * string that silently sorts wrong — a permission that never expires, or one
 * that expires immediately. An expiry already in the past is refused too: it
 * would create a grant that is dead on arrival and looks live in the UI.
 */
function normaliseExpiry(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ToolPermissionError(`expiresAt is not a valid date: ${value}`, 'invalid_expiry');
  }
  if (parsed <= Date.now()) {
    throw new ToolPermissionError('expiresAt must be in the future', 'invalid_expiry');
  }
  return new Date(parsed).toISOString();
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
    definitionRevision: (row.definition_revision as string) ?? null,
    actor: row.actor as ToolActor,
    originatingActor: ((row.originating_actor as ToolActor) ?? row.actor) as ToolActor,
    decision: row.decision as PolicyDecision,
    reasonCode: ((row.reason_code as string) ?? 'legacy') as ToolExecution['reasonCode'],
    status: row.status as ToolExecutionStatus,
    reason: (row.reason as string) ?? '',
    sessionId: (row.session_id as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    jobId: (row.job_id as string) ?? null,
    agentRunId: (row.agent_run_id as string) ?? null,
    parentExecutionId: (row.parent_execution_id as string) ?? null,
    input: parseRecord(row.input),
    inputHash: (row.input_hash as string) ?? null,
    inputValidated: Number(row.input_validated) === 1,
    effectUnknown: EFFECT_UNKNOWN_STATUSES.includes(row.status as ToolExecutionStatus),
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

function definitionRevision(tool: Pick<ToolDefinition, 'revision'>): string {
  return tool.revision;
}

function canonicalHash(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function rowToGrant(row: Row): ToolGrant {
  return {
    id: row.id as string,
    toolName: row.tool_name as string,
    actor: row.actor as ToolActor,
    risk: (row.risk as RiskLevel) ?? null,
    definitionRevision: (row.definition_revision as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    note: (row.note as string) ?? null,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string) ?? null,
    revokedAt: (row.revoked_at as string) ?? null,
  };
}
