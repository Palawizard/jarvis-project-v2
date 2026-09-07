import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../ids.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { isToolFreeRole } from './toolfree.js';
import {
  modelFor,
  selectExecutionProfile,
  type ExecutionProfile,
  type TaskSignals,
} from './policy.js';
import type {
  AgentProvider,
  AgentRole,
  AgentRunResult,
  ProviderCapabilities,
  ProviderId,
  RoutingDecision,
} from './types.js';

/**
 * What this process has observed about a provider. Every field is
 * INFORMATIONAL: nothing here can make a provider unroutable.
 *
 * The predecessor kept a `cooldownUntil` and subtracted it from `available`,
 * which turned one reported usage limit into a hard routing lock that outlived
 * the condition it described. It survived the user switching Claude account,
 * the provider recovering early, and a reset timestamp the provider had simply
 * guessed — and every one of those made Resume impossible for a Job that had
 * nothing wrong with it. Availability is now what the installed CLI answers
 * right now, so a later Resume always gets to ask again.
 */
interface HealthState {
  lastFailureAt?: string;
  lastFailureKind?: AgentFailureKind;
  /** The reset moment the provider itself named, when it named one. */
  lastFailureReset?: string;
  lastSuccessAt?: string;
}

export type AgentFailureKind =
  | 'cancelled'
  | 'quota'
  | 'cooldown'
  | 'session_invalid'
  | 'unavailable'
  | 'timeout'
  | 'protocol'
  | 'agent_failure';

/** Failure kinds that describe provider/infrastructure state, never the source. */
export const INFRASTRUCTURE_FAILURE_KINDS: readonly AgentFailureKind[] = [
  'quota',
  'cooldown',
  'unavailable',
  'timeout',
  'session_invalid',
  'protocol',
];

/**
 * Provider usage-limit vocabulary, as Claude Code and Codex actually phrase it.
 * Kept explicit rather than folded into a generic "error" bucket, because a
 * quota pause must never look like a product defect and must never reach a fixer.
 */
const QUOTA_PATTERNS = [
  /rate[ -]?limit/i,
  /too many requests/i,
  /\bquota\b/i,
  /usage limit (?:reached|exceeded)/i,
  /(?:monthly|weekly|daily|session|spend|hourly) limit/i,
  /limit (?:will )?reset(?:s)? (?:at|in|on)/i,
  /out of (?:credits|usage)/i,
  /upgrade to increase your usage limit/i,
  /you(?:'ve| have) (?:hit|reached) your/i,
];

/**
 * A persisted provider session that can no longer be resumed. Distinguished
 * from a generic failure so recovery can retire the session id and try ONCE in
 * a fresh context instead of replaying the same broken thread forever.
 */
const SESSION_INVALID_PATTERNS = [
  /(?:session|conversation|thread|resume)[^.\n]{0,40}(?:not found|invalid|expired|no longer|(?:can ?not|could not|can't|couldn't) be resumed|does not exist)/i,
  /(?:no|unknown) (?:such )?(?:session|conversation|thread)\b/i,
  /--resume[^.\n]{0,40}(?:failed|invalid|unknown)/i,
];

export function classifyAgentFailure(
  result: Pick<AgentRunResult, 'status' | 'error'>,
): AgentFailureKind {
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'timeout') return 'timeout';
  const error = result.error ?? '';
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(error))) return 'quota';
  if (/cooldown/i.test(error)) return 'cooldown';
  // Auth outages are provider health, not a stale thread id: "your session has
  // expired" would otherwise read as session_invalid and skip the cooldown.
  if (/not logged in|log ?in again/i.test(error)) return 'unavailable';
  if (SESSION_INVALID_PATTERNS.some((pattern) => pattern.test(error))) return 'session_invalid';
  if (/not found|could not start|could not be executed|not logged in|unavailable/i.test(error))
    return 'unavailable';
  if (/malformed JSONL|without a terminal structured event|protocol/i.test(error))
    return 'protocol';
  return 'agent_failure';
}

/**
 * The reset moment a provider mentioned, when it names one unambiguously.
 * Best-effort and honest: an unparsable phrase yields null rather than a guess.
 */
export function parseQuotaReset(error: string | undefined): string | null {
  if (!error) return null;
  const iso =
    /reset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?)/i.exec(
      error,
    );
  if (iso?.[1]) {
    const parsed = Date.parse(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const clock =
    /reset(?:s|ting)?\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([^)]{1,20}\))?)/i.exec(error);
  return clock?.[1] ? clock[1].trim() : null;
}

/** One line a human can act on, for the pause reason and the UI. */
export function describeAgentFailure(kind: AgentFailureKind, error: string | undefined): string {
  switch (kind) {
    case 'quota': {
      const reset = parseQuotaReset(error);
      return `Provider usage limit reached${reset ? `; resets at ${reset}` : ''}. This is provider state, not a problem with the code.`;
    }
    case 'cooldown':
      return 'Provider is in a temporary cooldown. This is provider state, not a problem with the code.';
    case 'session_invalid':
      return 'The saved provider session could not be resumed.';
    case 'unavailable':
      return 'No provider CLI is available or logged in.';
    case 'timeout':
      return 'The provider run exceeded its time budget.';
    case 'protocol':
      return 'The provider produced an unusable structured response.';
    case 'cancelled':
      return 'The run was cancelled.';
    default:
      return 'The agent reported an error during execution.';
  }
}

interface RegistryDeps {
  providers?: AgentProvider[];
  db?: Db;
  bus?: EventBus;
  now?: () => Date;
}

export type RoutingResult =
  | { provider: AgentProvider; capabilities: ProviderCapabilities; decision: RoutingDecision }
  | { provider: null; reason: string; decision: RoutingDecision };

/** Deterministic provider/model router with observable, lightweight health. */
export class AgentRegistry {
  private readonly providers = new Map<ProviderId, AgentProvider>();
  private readonly health = new Map<ProviderId, HealthState>();
  private readonly now: () => Date;

  constructor(
    private readonly config: JarvisConfig = getConfig(),
    private readonly deps: RegistryDeps = {},
  ) {
    for (const provider of deps.providers ?? [
      new ClaudeProvider(config),
      new CodexProvider(config),
    ]) {
      this.providers.set(provider.id, provider);
    }
    this.now = deps.now ?? (() => new Date());
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`unknown provider: ${id}`);
    return provider;
  }

  /**
   * What each provider can do RIGHT NOW.
   *
   * `available` comes from the provider's own probe of the installed CLI and
   * nothing else. Recorded failures ride along beside it so the UI and the
   * routing reason can explain a previous outage, but they never subtract from
   * it — see `HealthState`.
   */
  async capabilities(): Promise<ProviderCapabilities[]> {
    return Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const capability = await provider.capabilities();
        const health = this.health.get(provider.id);
        return {
          ...capability,
          ...(health?.lastFailureAt ? { lastFailureAt: health.lastFailureAt } : {}),
          ...(health?.lastFailureKind ? { lastFailureKind: health.lastFailureKind } : {}),
          ...(health?.lastFailureReset ? { lastFailureReset: health.lastFailureReset } : {}),
          ...(health?.lastSuccessAt ? { lastSuccessAt: health.lastSuccessAt } : {}),
        };
      }),
    );
  }

  /** The last failure recorded for a provider in this process. Informational. */
  lastFailure(provider: ProviderId): {
    at: string;
    kind: AgentFailureKind;
    reset?: string;
  } | null {
    const health = this.health.get(provider);
    if (!health?.lastFailureAt || !health.lastFailureKind) return null;
    return {
      at: health.lastFailureAt,
      kind: health.lastFailureKind,
      ...(health.lastFailureReset ? { reset: health.lastFailureReset } : {}),
    };
  }

  async route(
    role: AgentRole,
    opts: {
      avoid?: ProviderId;
      prefer?: ProviderId;
      jobId?: string;
      signals?: TaskSignals;
    } = {},
  ): Promise<RoutingResult> {
    const caps = await this.capabilities();
    const usable = caps.filter(
      (capability) => capability.available && roleAllowed(role, capability),
    );
    // Provider selection below is unchanged and comes first; the policy only
    // decides how much model to spend once a legitimate provider is chosen.
    const profile = selectExecutionProfile({
      role,
      ...(opts.signals ? { signals: opts.signals } : {}),
    });
    const order: ProviderId[] = [];
    if ((role === 'reviewer' || role === 'visual_reviewer') && opts.avoid) {
      if (opts.prefer && opts.prefer !== opts.avoid) order.push(opts.prefer);
      order.push(...usable.map((capability) => capability.id).filter((id) => id !== opts.avoid));
      // Independence is preferred, not fabricated: the avoided provider remains
      // a last resort when it is the only healthy option, always in fresh context.
      if (opts.prefer) order.push(opts.prefer);
      order.push(opts.avoid);
    } else if (opts.avoid) {
      // `avoid` now means something for every role, not just the two reviewers:
      // "this provider already failed THIS logical action, try the other one".
      // That used to be a side effect of the persistent cooldown -- the failed
      // provider became unavailable, so the next attempt landed elsewhere. With
      // the cooldown gone, the retry would otherwise route straight back to the
      // provider that had just refused. It stays a last resort rather than an
      // exclusion, so a single-provider machine can still make progress.
      if (opts.prefer && opts.prefer !== opts.avoid) order.push(opts.prefer);
      order.push(...usable.map((capability) => capability.id).filter((id) => id !== opts.avoid));
      order.push(opts.avoid);
    } else if (opts.prefer) {
      order.push(opts.prefer);
    }
    order.push('claude', 'codex');

    const selectedId = [...new Set(order)].find((id) => usable.some((cap) => cap.id === id));
    const capability = selectedId ? usable.find((cap) => cap.id === selectedId) : undefined;
    const reason = selectedId
      ? routingReason(selectedId, role, opts, caps, profile)
      : caps
          .map(
            (cap) =>
              `${cap.id}: ${
                cap.available && !roleAllowed(role, cap)
                  ? isToolFreeRole(role)
                    ? 'cannot run tool-free'
                    : 'cannot be restricted to a read-only tool allowlist'
                  : (cap.reason ?? 'unavailable')
              }`,
          )
          .join('; ');
    // An honest audit trail: the effort is only claimed as applied when the
    // installed CLI actually accepts one.
    const factors = [...profile.factors];
    if (capability && !capability.effortControl) {
      factors.push(`effort not applied: ${capability.id} CLI has no effort control`);
    }
    const decision: RoutingDecision = {
      id: newId('route'),
      jobId: opts.jobId ?? null,
      role,
      provider: selectedId ?? null,
      model: selectedId ? modelFor(selectedId, profile.capabilityTier) : null,
      capabilityTier: selectedId ? profile.capabilityTier : null,
      effort: selectedId ? profile.effort : null,
      score: selectedId ? profile.score : null,
      factors,
      reason: reason || 'no usable provider',
      avoid: opts.avoid ?? null,
      explicitPreference: opts.prefer ?? null,
      availability: caps.map((cap) => ({
        provider: cap.id,
        available: cap.available,
        ...(cap.reason ? { reason: cap.reason } : {}),
        ...(cap.lastFailureKind ? { lastFailureKind: cap.lastFailureKind } : {}),
      })),
      signals: { ...opts.signals },
      createdAt: nowIso(),
    };
    this.persistDecision(decision);
    if (!selectedId || !capability) return { provider: null, reason: decision.reason, decision };
    return { provider: this.get(selectedId), capabilities: capability, decision };
  }

  /**
   * Record what a run did, for diagnostics and the UI. Never a routing gate.
   *
   * A failure here is remembered and announced; it is not punished. The next
   * caller — including a Resume the user pressed one second later — routes on
   * what the CLI answers then, not on what it answered before.
   */
  recordResult(
    provider: ProviderId,
    result: Pick<AgentRunResult, 'status' | 'error'>,
    _opts: { resumed?: boolean } = {},
  ): void {
    const at = this.now();
    if (result.status === 'completed') {
      this.health.set(provider, { lastSuccessAt: at.toISOString() });
      return;
    }
    const kind = classifyAgentFailure(result);
    const reset = kind === 'quota' ? parseQuotaReset(result.error) : null;
    this.health.set(provider, {
      ...this.health.get(provider),
      lastFailureAt: at.toISOString(),
      lastFailureKind: kind,
      ...(reset ? { lastFailureReset: reset } : {}),
    });
    if (INFRASTRUCTURE_FAILURE_KINDS.includes(kind)) {
      this.deps.bus?.emit({
        type: kind === 'quota' ? 'agent.rate_limited' : 'agent.provider_unhealthy',
        payload: {
          provider,
          kind,
          ...(reset ? { reportedReset: reset } : {}),
          // Said out loud because the previous behaviour was the opposite.
          routingBlocked: false,
        },
      });
    }
  }

  decisions(jobId: string): RoutingDecision[] {
    if (!this.deps.db) return [];
    const rows = this.deps.db
      .prepare('SELECT * FROM routing_decisions WHERE job_id = ? ORDER BY created_at ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      jobId: (row.job_id as string) ?? null,
      role: row.role as AgentRole,
      provider: (row.provider as ProviderId) ?? null,
      model: (row.model as string) ?? null,
      capabilityTier: (row.capability_tier as RoutingDecision['capabilityTier']) ?? null,
      effort: (row.effort as RoutingDecision['effort']) ?? null,
      score: row.score === null || row.score === undefined ? null : Number(row.score),
      factors: JSON.parse((row.factors as string) || '[]') as string[],
      reason: row.reason as string,
      avoid: (row.avoid_provider as ProviderId) ?? null,
      explicitPreference: (row.explicit_preference as ProviderId) ?? null,
      availability: JSON.parse(
        (row.provider_availability as string) || '[]',
      ) as RoutingDecision['availability'],
      signals: JSON.parse((row.task_profile as string) || '{}') as TaskSignals,
      createdAt: row.created_at as string,
    }));
  }

  private persistDecision(decision: RoutingDecision): void {
    this.deps.db
      ?.prepare(
        `INSERT INTO routing_decisions (id, job_id, role, provider, model, capability_tier, effort,
          score, factors, reason, avoid_provider, explicit_preference, provider_availability,
          task_profile, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.jobId,
        decision.role,
        decision.provider,
        decision.model,
        decision.capabilityTier,
        decision.effort,
        decision.score,
        JSON.stringify(decision.factors),
        decision.reason,
        decision.avoid,
        decision.explicitPreference,
        JSON.stringify(decision.availability),
        JSON.stringify(decision.signals),
        decision.createdAt,
      );
    this.deps.bus?.emit({
      type: 'agent.routing.decided',
      jobId: decision.jobId,
      payload: {
        role: decision.role,
        provider: decision.provider,
        model: decision.model,
        effort: decision.effort,
        score: decision.score,
        factors: decision.factors,
        reason: decision.reason,
      },
    });
  }
}

function routingReason(
  selected: ProviderId,
  role: AgentRole,
  opts: { avoid?: ProviderId; prefer?: ProviderId },
  caps: ProviderCapabilities[],
  profile: ExecutionProfile,
): string {
  const model = `${profile.capabilityTier}/${profile.effort}`;
  if (opts.prefer === selected) return `explicit ${role} provider override; ${model}`;
  if (opts.prefer && !caps.find((cap) => cap.id === opts.prefer)?.available) {
    return `preferred ${opts.prefer} unavailable; fell back to ${selected}; ${model}`;
  }
  if (
    (role === 'reviewer' || role === 'visual_reviewer') &&
    opts.avoid &&
    selected !== opts.avoid
  ) {
    return `independent cross-provider ${role}; ${model}`;
  }
  if (opts.avoid && selected !== opts.avoid) {
    return `${opts.avoid} failed this action; alternate provider; ${model}`;
  }
  if (opts.avoid === selected) {
    return `no healthy alternative to ${selected}; fresh attempt; ${model}`;
  }
  if ((role === 'reviewer' || role === 'visual_reviewer') && opts.avoid === selected) {
    return `no healthy alternative; fresh ${selected} context; ${model}`;
  }
  return `healthy provider fallback order; ${model}`;
}

/**
 * May this provider serve this role at all?
 *
 * Some roles make a promise the provider itself has to keep. The tool-free set
 * (`chat`, `router`, `autostart_verifier`, `brief_compiler`) promises no tools;
 * `project_analyst` promises an exact read-only allowlist, which a merely
 * read-only sandbox does not give (it still runs shell commands). A provider
 * that cannot make the guarantee is not routed, rather than being routed and
 * quietly making a weaker one.
 */
function roleAllowed(role: AgentRole, capability: ProviderCapabilities): boolean {
  // Conversation, the two routing roles and the brief compiler all promise the
  // same thing — the model reaches no provider-native tool — so they all need
  // the same declared capability. A provider that cannot prove it is tool-free
  // never sees one.
  if (isToolFreeRole(role)) return capability.toolFreeChat === true;
  if (role === 'project_analyst') return capability.enforcesToolAllowlist === true;
  return true;
}
