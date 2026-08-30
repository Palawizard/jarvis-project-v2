/**
 * The permission policy. Pure functions only — no database, no clock, no I/O —
 * so the rules that decide whether Jarvis may act are readable and testable in
 * isolation from the machinery that records the decision.
 */

/**
 * Risk level gates what a tool may do without explicit approval. Classifying a
 * tool is the only thing a tool author has to get right; the policy below turns
 * that classification into a decision, so adding a tool never means inventing
 * new permission logic.
 *
 * - `observe`                 reads state, changes nothing (memory.search)
 * - `safe_action`             changes only Jarvis-internal scratch state
 * - `reversible_modification` changes durable state that can be undone (memory.store)
 * - `sensitive`               touches the user's private data or the outside
 *                             world (mail, calendar, screen, desktop input)
 * - `destructive`             loses data or has no undo (hard delete, send, pay)
 */
export type RiskLevel =
  'observe' | 'safe_action' | 'reversible_modification' | 'sensitive' | 'destructive';

/**
 * Who is asking. This is asserted by the *call site inside Jarvis*, never by the
 * payload of the call — a caller that could name its own actor could name its
 * own privileges, which is the whole hole this layer exists to close.
 */
export type ToolActor = 'user' | 'agent' | 'system';

export type PolicyDecision = 'allow' | 'confirm' | 'deny';

export type PolicyReasonCode =
  | 'caller_ceiling'
  | 'actor_risk_ceiling'
  | 'base_allow'
  | 'standing_grant'
  | 'grant_definition_drift'
  | 'non_grantable_risk'
  | 'confirmation_required';

export const RISK_LEVELS: RiskLevel[] = [
  'observe',
  'safe_action',
  'reversible_modification',
  'sensitive',
  'destructive',
];

export function riskExceeds(risk: RiskLevel, max: RiskLevel): boolean {
  return RISK_LEVELS.indexOf(risk) > RISK_LEVELS.indexOf(max);
}

/**
 * Default decision per actor and risk.
 *
 * The shape that matters: an agent can never reach `sensitive` or `destructive`
 * at all. Broader agent powers are a deliberate future decision, not something
 * that leaks in the day a tool is registered with the wrong risk level.
 */
const BASE: Record<ToolActor, Record<RiskLevel, PolicyDecision>> = {
  user: {
    observe: 'allow',
    safe_action: 'allow',
    reversible_modification: 'allow',
    sensitive: 'confirm',
    destructive: 'confirm',
  },
  agent: {
    observe: 'allow',
    safe_action: 'allow',
    reversible_modification: 'confirm',
    sensitive: 'deny',
    destructive: 'deny',
  },
  system: {
    observe: 'allow',
    safe_action: 'allow',
    reversible_modification: 'allow',
    sensitive: 'confirm',
    destructive: 'deny',
  },
};

/**
 * A standing grant can never raise a level above this. "Always allow" is a
 * convenience for actions the user repeats, not a way to hand out an unattended
 * irreversible action, so `destructive` always comes back to a human.
 */
export const MAX_GRANTABLE_RISK: RiskLevel = 'sensitive';

/**
 * Standing permissions only ever cover the user's own actions.
 *
 * "Always allow" means "do this unattended next time". Handing that to an agent
 * is delegated autonomy — a separate product decision with its own blocking
 * prerequisite (OS-level isolation of agent children, see docs/roadmap.md), not
 * something that should fall out of a checkbox on an approval dialog. Approving
 * a single agent invocation stays possible; remembering it does not.
 */
export function isGrantableActor(actor: ToolActor): boolean {
  return actor === 'user';
}

export interface PolicyInput {
  risk: RiskLevel;
  actor: ToolActor;
  /** A matching, unexpired standing grant exists for this tool in this context. */
  hasGrant: boolean;
  /**
   * Optional extra ceiling the *call site* imposes on itself. It can only
   * tighten the decision; there is no value that widens it.
   */
  maxRisk?: RiskLevel | undefined;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  /** Stable classification used for security-sensitive follow-up decisions. */
  code: PolicyReasonCode;
  /** Stable machine-readable reason, stored on every execution row. */
  reason: string;
}

export function decide(input: PolicyInput): PolicyOutcome {
  if (input.maxRisk && riskExceeds(input.risk, input.maxRisk)) {
    return {
      decision: 'deny',
      code: 'caller_ceiling',
      reason: `above the caller ceiling ${input.maxRisk}`,
    };
  }

  const base = BASE[input.actor][input.risk];
  if (base === 'deny') {
    return {
      decision: 'deny',
      code: 'actor_risk_ceiling',
      reason: `${input.actor} may not run ${input.risk} tools`,
    };
  }
  if (base === 'allow') {
    return {
      decision: 'allow',
      code: 'base_allow',
      reason: `${input.risk} is allowed for ${input.actor}`,
    };
  }

  if (input.hasGrant) {
    if (riskExceeds(input.risk, MAX_GRANTABLE_RISK)) {
      return {
        decision: 'confirm',
        code: 'non_grantable_risk',
        reason: `${input.risk} always needs a human, a standing permission cannot cover it`,
      };
    }
    return {
      decision: 'allow',
      code: 'standing_grant',
      reason: 'standing permission for this context',
    };
  }
  return {
    decision: 'confirm',
    code: 'confirmation_required',
    reason: `${input.risk} needs your confirmation`,
  };
}

/** What the policy would decide right now, used to explain the catalog in the UI. */
export function previewDecision(risk: RiskLevel, actor: ToolActor): PolicyDecision {
  return decide({ risk, actor, hasGrant: false }).decision;
}
