import type { AgentRole, ProviderId } from './types.js';

/**
 * The ONE place Jarvis decides how much model to spend on a run.
 *
 * Two separate dimensions, deliberately not collapsed into one scale:
 *   - `capabilityTier` — is a more capable model justified?
 *   - `effort`         — how deeply should it think?
 * `normal/high` and `strong/medium` are both legitimate and mean different things.
 *
 * The decision is a pure function of structured signals trusted code already
 * has (roles, booleans, counts, git paths). No model is consulted to choose a
 * model, and no prose — user text, README, project summary, memory, agent
 * output — is ever given authority here.
 */

export type CapabilityTier = 'normal' | 'strong';
export type EffortLevel = 'low' | 'medium' | 'high';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];
export const CAPABILITY_TIERS: readonly CapabilityTier[] = ['normal', 'strong'];

/**
 * The complete model space. Anything not in this table cannot be selected, and
 * the adapters refuse to pass anything else to a CLI.
 */
export const PROVIDER_MODELS: Record<ProviderId, Record<CapabilityTier, string>> = {
  claude: { normal: 'sonnet', strong: 'opus' },
  // These are the real Codex CLI model IDs, not the "terra"/"sol" shorthand
  // used in the feature spec — Codex rejects the shorthand outright.
  codex: { normal: 'gpt-5.6-terra', strong: 'gpt-5.6-sol' },
};

export const ALLOWED_MODELS: Record<ProviderId, readonly string[]> = {
  claude: [PROVIDER_MODELS.claude.normal, PROVIDER_MODELS.claude.strong],
  codex: [PROVIDER_MODELS.codex.normal, PROVIDER_MODELS.codex.strong],
};

export function modelFor(provider: ProviderId, tier: CapabilityTier): string {
  return PROVIDER_MODELS[provider][tier];
}

export function isAllowedModel(provider: ProviderId, model: string): boolean {
  return ALLOWED_MODELS[provider].includes(model);
}

export function isAllowedEffort(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isAllowedCapabilityTier(value: unknown): value is CapabilityTier {
  return typeof value === 'string' && (CAPABILITY_TIERS as readonly string[]).includes(value);
}

/**
 * A semantic read on ONE question: how much model does the initial implementer
 * need? Two independent dimensions — never a model name, never a score — so
 * trusted code stays the only thing that ever maps a tier to a provider's model
 * string.
 *
 * Two producers, one shape: the Job Brief Compiler emits it as a field of the
 * brief on the chat path (no extra call), and the Execution Advisor emits it
 * alone for a Job created directly with no brief. Neither may name a provider,
 * a model, a project, a permission or a sandbox.
 *
 * Advice, not a decision: `selectExecutionProfile` is the only reader, applies
 * it to the `implementer` role only, and still runs it through the same role
 * floors/ceilings and risk floor as every other decision.
 */
export interface ExecutionRecommendation {
  capabilityTier: CapabilityTier;
  effort: EffortLevel;
  /** Short, bounded — a handful of concrete reasons, never free-form prose. */
  reasons: string[];
}

/**
 * The recommendation is model-authored persisted data. Keep parsing it at this
 * boundary so an old or malformed optional field loses only its advice, never
 * the otherwise usable compiled brief.
 */
export function parseExecutionRecommendation(value: unknown): ExecutionRecommendation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !isAllowedCapabilityTier(record.capabilityTier) ||
    !isAllowedEffort(record.effort) ||
    !Array.isArray(record.reasons) ||
    record.reasons.length < 1 ||
    record.reasons.length > 4
  ) {
    return undefined;
  }
  const reasons = record.reasons.map((reason) =>
    typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '',
  );
  return reasons.every((reason) => reason.length > 0 && reason.length <= 240)
    ? { capabilityTier: record.capabilityTier, effort: record.effort, reasons }
    : undefined;
}

/**
 * Trusted, path-derived categories where a mistake is a security or integrity
 * event rather than a bug. Derived from git paths only — never from a model's
 * description of what it changed.
 *
 * Coarse on purpose: a false positive costs one stronger run, a false negative
 * costs a weak model on the permission boundary.
 */
export const SENSITIVE_CATEGORIES = [
  'auth',
  'permissions',
  'sandbox_isolation',
  'supervisor_activation',
  'database_migration',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const SENSITIVE_PATTERNS: Array<[SensitiveCategory, RegExp]> = [
  ['auth', /(^|\/)(auth|authn|authz|oauth|login)([./-]|$)|credential|(^|\/)secrets?\.[a-z]+$/i],
  ['permissions', /permission|privilege|(^|\/)acl([./-]|$)/i],
  ['sandbox_isolation', /sandbox|isolation|worktree|child_process|(^|\/)spawn\./i],
  ['supervisor_activation', /supervisor|activation|(^|\/)upgrade([./-]|$)|self[-_]?upgrade/i],
  ['database_migration', /(^|\/)migrations?([./-]|\/)|schema\.sql$|\.sql$/i],
];

const FRONTEND = /\.(tsx|jsx|css|scss|less|vue|svelte|html)$|(^|\/)(web|frontend|ui|client)\//i;
const BACKEND =
  /\.(ts|js|mjs|cjs|py|go|rs|rb|java|kt|php)$|(^|\/)(server|backend|api|core|orchestrator)\//i;

export interface ChangedPathFacts {
  filesChanged: number;
  packagesTouched: number;
  frontendTouched: boolean;
  backendTouched: boolean;
  dbMigration: boolean;
  sensitive: SensitiveCategory[];
}

/** Deterministic facts about a candidate diff, from paths alone. */
export function classifyChangedPaths(paths: readonly string[]): ChangedPathFacts {
  const workspaces = new Set<string>();
  const sensitive = new Set<SensitiveCategory>();
  let frontendTouched = false;
  let backendTouched = false;
  for (const raw of paths) {
    const file = raw.replace(/\\/g, '/').replace(/^\.?\//, '');
    const segments = file.split('/');
    // `packages/core/...` and `apps/web/...` are one workspace each; anything
    // else is grouped by its top-level directory.
    workspaces.add(
      (segments[0] === 'packages' || segments[0] === 'apps') && segments.length > 2
        ? `${segments[0]}/${segments[1]}`
        : (segments[0] ?? ''),
    );
    if (FRONTEND.test(file)) frontendTouched = true;
    else if (BACKEND.test(file)) backendTouched = true;
    for (const [category, pattern] of SENSITIVE_PATTERNS) {
      if (pattern.test(file)) sensitive.add(category);
    }
  }
  return {
    filesChanged: paths.length,
    packagesTouched: workspaces.size,
    frontendTouched,
    backendTouched,
    dbMigration: sensitive.has('database_migration'),
    sensitive: SENSITIVE_CATEGORIES.filter((category) => sensitive.has(category)),
  };
}

/**
 * Everything a caller may say about a run. All of it is structured and produced
 * by trusted code: booleans the pipeline sets, counts read off a validated
 * compiled brief, git numstat, review findings, repair cycle counters.
 *
 * Callers pass SIGNALS. No caller picks a model.
 */
export interface TaskSignals {
  selfDevelopment?: boolean;
  highRisk?: boolean;
  mechanical?: boolean;

  /** Size of the user's own request, used only when no compiled brief exists. */
  requestChars?: number;

  // ---- before implementation: the compiled brief ----
  hasCompiledBrief?: boolean;
  requirements?: number;
  acceptanceCriteria?: number;
  /**
   * Semantic advice for the INITIAL implementer only, from the Brief Compiler
   * or the Execution Advisor. `selectExecutionProfile` ignores this for every
   * other role, including both producers themselves — see the docstring on
   * `ExecutionRecommendation`.
   */
  executionRecommendation?: ExecutionRecommendation;

  // ---- after implementation: the candidate diff ----
  filesChanged?: number;
  linesChanged?: number;
  packagesTouched?: number;
  frontendTouched?: boolean;
  backendTouched?: boolean;
  dbMigration?: boolean;
  /** Trusted PATH-derived categories only. Never inferred from text. */
  sensitive?: SensitiveCategory[];

  // ---- review / repair ----
  /** Number of the current repair cycle; 0 or absent means first attempt. */
  repairCycle?: number;
  blockers?: number;
  /** True when at least one blocker is `high` or `critical`. */
  highSeverityBlocker?: boolean;
  failedChecks?: number;

  // ---- visual QA ----
  uiFilesChanged?: number;
  productDefect?: boolean;
  /** The single permitted Visual QA re-look after an inconclusive verdict. */
  escalated?: boolean;
}

export interface ExecutionProfile {
  capabilityTier: CapabilityTier;
  effort: EffortLevel;
  /** Null when semantic brief advice, rather than the old score, selected it. */
  score: number | null;
  /** Bounded, human-readable audit of what actually moved the decision. */
  factors: string[];
}

export interface RolePolicy {
  /** Bounded roles skip scoring entirely: their answer never varies by task. */
  fixed?: { tier: CapabilityTier; effort: EffortLevel };
  maxTier: CapabilityTier;
  minEffort: EffortLevel;
  maxEffort: EffortLevel;
  /** Added to the score before banding, to place the role on the scale. */
  bias?: number;
  note: string;
}

/**
 * Role floors and ceilings. These are safety bounds — scoring only refines the
 * decision INSIDE them, and they are applied last so nothing can escape them.
 */
export const ROLE_POLICY: Record<AgentRole, RolePolicy> = {
  router: {
    fixed: { tier: 'normal', effort: 'low' },
    maxTier: 'normal',
    minEffort: 'low',
    maxEffort: 'low',
    note: 'bounded tool-free classification',
  },
  autostart_verifier: {
    fixed: { tier: 'normal', effort: 'low' },
    maxTier: 'normal',
    minEffort: 'low',
    maxEffort: 'low',
    note: 'bounded tool-free second opinion',
  },
  execution_advisor: {
    // FIXED, and that is the point: an advisor that could choose its own
    // capability tier would be recursively selecting the model that selects
    // the model. One bounded structured judgement, always at the same cost.
    fixed: { tier: 'normal', effort: 'medium' },
    maxTier: 'normal',
    minEffort: 'medium',
    maxEffort: 'medium',
    note: 'bounded tool-free execution advice',
  },
  brief_compiler: {
    maxTier: 'normal',
    minEffort: 'low',
    maxEffort: 'medium',
    // Tool-free structured compilation of one message: nothing about the diff,
    // the repository or the risk of the task changes what it has to do.
    bias: -2,
    note: 'bounded tool-free structured compilation',
  },
  chat: {
    maxTier: 'normal',
    minEffort: 'low',
    maxEffort: 'high',
    // Conversation has no candidate diff and no brief, so an unqualified turn
    // must land on `low` rather than on the implementer's default band.
    bias: -1,
    note: 'conversation, no candidate diff',
  },
  project_analyst: {
    maxTier: 'strong',
    minEffort: 'medium',
    maxEffort: 'high',
    note: 'bounded read-only reconnaissance',
  },
  implementer: {
    maxTier: 'strong',
    minEffort: 'medium',
    maxEffort: 'high',
    note: 'implementation',
  },
  fixer: { maxTier: 'strong', minEffort: 'low', maxEffort: 'high', note: 'repair' },
  visual_fixer: { maxTier: 'strong', minEffort: 'low', maxEffort: 'high', note: 'visual repair' },
  reviewer: {
    maxTier: 'strong',
    // A real code review is never a low-effort read of a diff.
    minEffort: 'high',
    maxEffort: 'high',
    note: 'independent code review',
  },
  visual_reviewer: {
    maxTier: 'strong',
    minEffort: 'medium',
    maxEffort: 'high',
    // Judging a rendered surface is already a careful task, and the visual
    // agent sees far fewer signals than a code reviewer does (no numstat, no
    // findings). It starts one band up so that "the diff touched a real amount
    // of UI" is enough to reach high, without needing a risk signal.
    bias: 2,
    note: 'rendered-surface review',
  },
};

/** Ordered weakest to strongest. `strong/low` is deliberately not reachable. */
const BANDS: Array<{ atLeast: number; tier: CapabilityTier; effort: EffortLevel }> = [
  { atLeast: 7, tier: 'strong', effort: 'high' },
  { atLeast: 5, tier: 'strong', effort: 'medium' },
  { atLeast: 3, tier: 'normal', effort: 'high' },
  { atLeast: 0, tier: 'normal', effort: 'medium' },
  { atLeast: Number.NEGATIVE_INFINITY, tier: 'normal', effort: 'low' },
];

const rank = (tier: CapabilityTier, effort: EffortLevel): number =>
  CAPABILITY_TIERS.indexOf(tier) * 3 + EFFORT_LEVELS.indexOf(effort);

const MAX_FACTORS = 12;

/**
 * The scoring table. One place, readable end to end, no scattered branches.
 *
 * Thresholds are deliberately blunt. Every weight is documented next to it and
 * every one is exercised by a boundary case in `policy.test.ts`.
 */
function scoreSignals(signals: TaskSignals): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;
  const add = (points: number, label: string): void => {
    if (points === 0) return;
    score += points;
    factors.push(`${label} (${points > 0 ? '+' : ''}${points})`);
  };

  // ------------------------------------------------------------ complexity --
  const requirements = signals.requirements ?? 0;
  if (requirements > 5) add(1, `${requirements} requirements`);
  if (requirements > 10) add(1, `${requirements} requirements (large brief)`);
  if ((signals.acceptanceCriteria ?? 0) > 5)
    add(1, `${signals.acceptanceCriteria} acceptance criteria`);
  // Request size only counts when no brief exists, so a compiled brief is not
  // paid for twice.
  if (!signals.hasCompiledBrief) {
    const chars = signals.requestChars ?? 0;
    if (chars > 2_000) add(1, 'long request');
    if (chars > 8_000) add(1, 'very long request');
  }
  if ((signals.packagesTouched ?? 0) > 1) add(1, `${signals.packagesTouched} workspaces touched`);
  if (signals.frontendTouched && signals.backendTouched) add(1, 'frontend and backend touched');
  if (signals.dbMigration) add(1, 'database migration');
  const lines = signals.linesChanged ?? 0;
  if (lines > 400) add(1, `${lines} lines changed`);
  if (lines > 1_500) add(1, `${lines} lines changed (very large diff)`);

  // ------------------------------------------------------------------ risk --
  if (signals.selfDevelopment) add(2, 'self-development');
  if (signals.highRisk) add(2, 'high-risk');
  if (signals.sensitive?.length) add(2, `sensitive: ${signals.sensitive.join(', ')}`);
  if ((signals.repairCycle ?? 0) > 0) add(1, `repair cycle ${signals.repairCycle}`);
  if (signals.highSeverityBlocker) add(1, 'high-severity blocker');
  if ((signals.blockers ?? 0) > 1) add(1, `${signals.blockers} blockers`);
  if (signals.productDefect) add(1, 'visual product defect');
  if (signals.escalated) add(2, 'escalated re-look');
  if ((signals.failedChecks ?? 0) > 2) add(1, `${signals.failedChecks} failing checks`);
  if ((signals.uiFilesChanged ?? 0) > 4) add(1, `${signals.uiFilesChanged} UI files changed`);

  // ------------------------------------------------------------ simplicity --
  if (signals.mechanical) add(-1, 'mechanical change');
  // Only claimable when the diff is actually known.
  if (
    signals.filesChanged !== undefined &&
    signals.linesChanged !== undefined &&
    signals.filesChanged <= 2 &&
    signals.linesChanged <= 20
  ) {
    add(-1, 'trivial diff');
  }

  return { score, factors };
}

/**
 * Risk floors. A blunt "this must not be done by the cheap model" rule, applied
 * on top of the score because the score is a complexity estimate and these are
 * not complexity questions.
 */
function riskFloor(
  role: AgentRole,
  signals: TaskSignals,
): { tier: CapabilityTier; effort: EffortLevel; reason: string } | null {
  const touchesSource =
    role === 'implementer' || role === 'fixer' || role === 'reviewer' || role === 'visual_fixer';
  if (touchesSource && signals.sensitive?.length) {
    return {
      tier: 'strong',
      effort: 'high',
      reason: `floor: ${signals.sensitive.join(', ')} is security-sensitive`,
    };
  }
  if (role === 'visual_reviewer' && signals.escalated) {
    return { tier: 'strong', effort: 'medium', reason: 'floor: escalated visual re-look' };
  }
  return null;
}

function profileForTrustedGuardrails(signals: TaskSignals): {
  capabilityTier: CapabilityTier;
  effort: EffortLevel;
  factors: string[];
} {
  // Semantic brief advice deliberately replaces the request/brief-count score.
  // These are the remaining trusted pre-implementation facts that can impose a
  // floor regardless of what the compiler recommended.
  const { score, factors } = scoreSignals({
    selfDevelopment: signals.selfDevelopment,
    highRisk: signals.highRisk,
  });
  const band = BANDS.find((entry) => score >= entry.atLeast) as (typeof BANDS)[number];
  return { capabilityTier: band.tier, effort: band.effort, factors };
}

/**
 * Choose capability tier and effort for one agent run. Pure and total: the same
 * inputs always produce exactly the same decision.
 */
export function selectExecutionProfile(input: {
  role: AgentRole;
  signals?: TaskSignals;
}): ExecutionProfile {
  const policy = ROLE_POLICY[input.role];
  const signals = input.signals ?? {};

  if (policy.fixed) {
    return {
      capabilityTier: policy.fixed.tier,
      effort: policy.fixed.effort,
      score: 0,
      factors: [
        `${input.role}: ${policy.note}`,
        `role policy: ${policy.fixed.tier}/${policy.fixed.effort}`,
      ],
    };
  }

  const { score: raw, factors } = scoreSignals(signals);
  const score = raw + (policy.bias ?? 0);
  if (policy.bias) {
    factors.unshift(`${policy.note} (${policy.bias > 0 ? '+' : ''}${policy.bias})`);
  }

  const recommendation =
    input.role === 'implementer'
      ? parseExecutionRecommendation(signals.executionRecommendation)
      : undefined;
  const band = BANDS.find((entry) => score >= entry.atLeast) as (typeof BANDS)[number];
  let tier = recommendation?.capabilityTier ?? band.tier;
  let effort = recommendation?.effort ?? band.effort;
  if (recommendation) {
    // Do not let prompt length or compiled-brief item counts re-classify a
    // semantic recommendation. They remain in `score` only for old audit rows.
    factors.length = 0;
    factors.push(`brief recommendation: ${recommendation.capabilityTier}/${recommendation.effort}`);
    factors.push(...recommendation.reasons.map((reason) => `brief: ${reason}`));
    const guardrail = profileForTrustedGuardrails(signals);
    if (CAPABILITY_TIERS.indexOf(guardrail.capabilityTier) > CAPABILITY_TIERS.indexOf(tier)) {
      tier = guardrail.capabilityTier;
      factors.push(`trusted capability floor: ${guardrail.capabilityTier}`);
    }
    if (EFFORT_LEVELS.indexOf(guardrail.effort) > EFFORT_LEVELS.indexOf(effort)) {
      effort = guardrail.effort;
      factors.push(`trusted effort floor: ${guardrail.effort}`);
    }
    factors.push(...guardrail.factors.map((factor) => `trusted: ${factor}`));
  }

  const floor = riskFloor(input.role, signals);
  if (floor && recommendation) {
    const tierRaised = CAPABILITY_TIERS.indexOf(floor.tier) > CAPABILITY_TIERS.indexOf(tier);
    const effortRaised = EFFORT_LEVELS.indexOf(floor.effort) > EFFORT_LEVELS.indexOf(effort);
    if (tierRaised) tier = floor.tier;
    if (effortRaised) effort = floor.effort;
    if (tierRaised || effortRaised) {
      factors.push(floor.reason);
    }
  } else if (floor && rank(floor.tier, floor.effort) > rank(tier, effort)) {
    // Keep the long-standing combined floor for every other role. Only the
    // semantic initial-implementer merge needs independent dimension clamping.
    tier = floor.tier;
    effort = floor.effort;
    factors.push(floor.reason);
  }

  // Role bounds are applied LAST: nothing may escape a ceiling.
  if (tier === 'strong' && policy.maxTier === 'normal') {
    tier = 'normal';
    // Demoted to the strongest thing this role IS allowed to be, not to the
    // effort the strong band happened to carry: otherwise a higher score could
    // produce a weaker run (strong/medium -> normal/medium) than a lower one
    // (normal/high), and the decision would stop being monotonic in risk.
    effort = policy.maxEffort;
    factors.push(`role ceiling: ${input.role} never uses a strong model`);
  }
  if (EFFORT_LEVELS.indexOf(effort) > EFFORT_LEVELS.indexOf(policy.maxEffort)) {
    effort = policy.maxEffort;
    factors.push(`role ceiling: ${input.role} effort <= ${policy.maxEffort}`);
  }
  if (EFFORT_LEVELS.indexOf(effort) < EFFORT_LEVELS.indexOf(policy.minEffort)) {
    effort = policy.minEffort;
    factors.push(`role floor: ${input.role} effort >= ${policy.minEffort}`);
  }

  return {
    capabilityTier: tier,
    effort,
    score: recommendation ? null : score,
    factors: (factors.length ? factors : [`${input.role}: no escalating signal`]).slice(
      0,
      MAX_FACTORS,
    ),
  };
}
