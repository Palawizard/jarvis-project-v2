import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { newId, nowIso } from '../ids.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { isToolFreeRole } from './toolfree.js';
import type {
  AgentProvider,
  AgentRole,
  AgentRunResult,
  ModelProfile,
  ProviderCapabilities,
  ProviderId,
  RoutingDecision,
  TaskProfile,
} from './types.js';

interface HealthState {
  cooldownUntil?: string;
  lastFailureAt?: string;
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

  async capabilities(): Promise<ProviderCapabilities[]> {
    const now = this.now().getTime();
    return Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const capability = await provider.capabilities();
        const health = this.health.get(provider.id);
        const cooling = health?.cooldownUntil && Date.parse(health.cooldownUntil) > now;
        return {
          ...capability,
          available: capability.available && !cooling,
          ...(cooling
            ? {
                reason: `temporary cooldown until ${health.cooldownUntil}`,
                cooldownUntil: health.cooldownUntil,
              }
            : {}),
          ...(health?.lastFailureAt ? { lastFailureAt: health.lastFailureAt } : {}),
          ...(health?.lastSuccessAt ? { lastSuccessAt: health.lastSuccessAt } : {}),
        };
      }),
    );
  }

  async route(
    role: AgentRole,
    opts: {
      avoid?: ProviderId;
      prefer?: ProviderId;
      jobId?: string;
      taskProfile?: TaskProfile;
    } = {},
  ): Promise<RoutingResult> {
    const caps = await this.capabilities();
    const usable = caps.filter(
      (capability) => capability.available && roleAllowed(role, capability),
    );
    const profile = resolveModelProfile(opts.taskProfile);
    const order: ProviderId[] = [];
    if ((role === 'reviewer' || role === 'visual_reviewer') && opts.avoid) {
      if (opts.prefer && opts.prefer !== opts.avoid) order.push(opts.prefer);
      order.push(...usable.map((capability) => capability.id).filter((id) => id !== opts.avoid));
      // Independence is preferred, not fabricated: the avoided provider remains
      // a last resort when it is the only healthy option, always in fresh context.
      if (opts.prefer) order.push(opts.prefer);
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
                  ? role === 'chat'
                    ? 'cannot run tool-free chat'
                    : 'cannot be restricted to a read-only tool allowlist'
                  : (cap.reason ?? 'unavailable')
              }`,
          )
          .join('; ');
    const decision: RoutingDecision = {
      id: newId('route'),
      jobId: opts.jobId ?? null,
      role,
      provider: selectedId ?? null,
      model: selectedId ? selectModel(selectedId, profile, this.config) : null,
      reason: reason || 'no usable provider',
      avoid: opts.avoid ?? null,
      explicitPreference: opts.prefer ?? null,
      availability: caps.map((cap) => ({
        provider: cap.id,
        available: cap.available,
        ...(cap.reason ? { reason: cap.reason } : {}),
        ...(cap.cooldownUntil ? { cooldownUntil: cap.cooldownUntil } : {}),
      })),
      taskProfile: { ...opts.taskProfile, modelProfile: profile },
      createdAt: nowIso(),
    };
    this.persistDecision(decision);
    if (!selectedId || !capability) return { provider: null, reason: decision.reason, decision };
    return { provider: this.get(selectedId), capabilities: capability, decision };
  }

  recordResult(
    provider: ProviderId,
    result: Pick<AgentRunResult, 'status' | 'error'>,
    opts: { resumed?: boolean } = {},
  ): void {
    const at = this.now();
    if (result.status === 'completed') {
      this.health.set(provider, { lastSuccessAt: at.toISOString() });
      return;
    }
    const next: HealthState = {
      ...this.health.get(provider),
      lastFailureAt: at.toISOString(),
    };
    const kind = classifyAgentFailure(result);
    // A broken persisted session says nothing about the provider's health, so it
    // must not put an otherwise usable provider into cooldown. A protocol failure
    // while resuming is the same story: the observed Codex case answered a fresh
    // invocation perfectly and only failed on the resumed thread. Cooling the
    // provider down there would make the one legitimate recovery unroutable, so
    // the fresh-context attempt decides whether the provider is really unhealthy.
    const sessionScoped = kind === 'session_invalid' || (kind === 'protocol' && opts.resumed);
    if (!sessionScoped && ['quota', 'unavailable', 'timeout', 'protocol'].includes(kind)) {
      next.cooldownUntil = new Date(at.getTime() + this.config.agents.cooldownMs).toISOString();
      this.deps.bus?.emit({
        type: kind === 'quota' ? 'agent.rate_limited' : 'agent.provider_unhealthy',
        payload: { provider, kind, cooldownUntil: next.cooldownUntil },
      });
    }
    this.health.set(provider, next);
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
      reason: row.reason as string,
      avoid: (row.avoid_provider as ProviderId) ?? null,
      explicitPreference: (row.explicit_preference as ProviderId) ?? null,
      availability: JSON.parse(
        (row.provider_availability as string) || '[]',
      ) as RoutingDecision['availability'],
      taskProfile: JSON.parse((row.task_profile as string) || '{}') as TaskProfile,
      createdAt: row.created_at as string,
    }));
  }

  private persistDecision(decision: RoutingDecision): void {
    this.deps.db
      ?.prepare(
        `INSERT INTO routing_decisions (id, job_id, role, provider, model, reason, avoid_provider,
          explicit_preference, provider_availability, task_profile, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.jobId,
        decision.role,
        decision.provider,
        decision.model,
        decision.reason,
        decision.avoid,
        decision.explicitPreference,
        JSON.stringify(decision.availability),
        JSON.stringify(decision.taskProfile),
        decision.createdAt,
      );
    this.deps.bus?.emit({
      type: 'agent.routing.decided',
      jobId: decision.jobId,
      payload: {
        role: decision.role,
        provider: decision.provider,
        model: decision.model,
        reason: decision.reason,
      },
    });
  }
}

function resolveModelProfile(task: TaskProfile | undefined): ModelProfile {
  if (task?.modelProfile) return task.modelProfile;
  if (task?.selfDevelopment || task?.highRisk) return 'quality';
  if (task?.mechanical) return 'economy';
  return 'balanced';
}

function selectModel(id: ProviderId, profile: ModelProfile, config: JarvisConfig): string | null {
  if (id === 'claude') {
    if (profile === 'economy') return 'haiku';
    if (profile === 'quality') return 'opus';
    return config.agents.claudeModel;
  }
  return config.agents.codexModel ?? null;
}

function routingReason(
  selected: ProviderId,
  role: AgentRole,
  opts: { avoid?: ProviderId; prefer?: ProviderId },
  caps: ProviderCapabilities[],
  profile: ModelProfile,
): string {
  if (opts.prefer === selected)
    return `explicit ${role} provider override; ${profile} model profile`;
  if (opts.prefer && !caps.find((cap) => cap.id === opts.prefer)?.available) {
    return `preferred ${opts.prefer} unavailable; fell back to ${selected}; ${profile} model profile`;
  }
  if (
    (role === 'reviewer' || role === 'visual_reviewer') &&
    opts.avoid &&
    selected !== opts.avoid
  ) {
    return `independent cross-provider ${role}; ${profile} model profile`;
  }
  if ((role === 'reviewer' || role === 'visual_reviewer') && opts.avoid === selected) {
    return `no healthy alternative; fresh ${selected} context; ${profile} model profile`;
  }
  return `healthy provider fallback order; ${profile} model profile`;
}

/**
 * May this provider serve this role at all?
 *
 * Three roles make a promise the provider itself has to keep. `chat`, `router`
 * and `autostart_verifier` promise no tools; `project_analyst` promises an exact
 * read-only allowlist, which a merely read-only sandbox does not give (it still
 * runs shell commands). A provider that cannot make the guarantee is not routed,
 * rather than being routed and quietly making a weaker one.
 */
function roleAllowed(role: AgentRole, capability: ProviderCapabilities): boolean {
  // Conversation and the two routing roles all promise the same thing — the
  // model reaches no provider-native tool — so they all need the same declared
  // capability. A provider that cannot prove it is tool-free never sees one.
  if (isToolFreeRole(role)) return capability.toolFreeChat === true;
  if (role === 'project_analyst') return capability.enforcesToolAllowlist === true;
  return true;
}
