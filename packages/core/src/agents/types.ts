import type { MemoryInput, MemoryKind, MemoryScope } from '../memory/types.js';

export type ProviderId = 'claude' | 'codex';

export type ModelProfile = 'economy' | 'balanced' | 'quality';

export interface TaskProfile {
  modelProfile?: ModelProfile;
  selfDevelopment?: boolean;
  highRisk?: boolean;
  mechanical?: boolean;
}

export interface RoutingDecision {
  id: string;
  jobId: string | null;
  role: AgentRole;
  provider: ProviderId | null;
  model: string | null;
  reason: string;
  avoid: ProviderId | null;
  explicitPreference: ProviderId | null;
  availability: Array<{
    provider: ProviderId;
    available: boolean;
    reason?: string;
    cooldownUntil?: string;
  }>;
  taskProfile: TaskProfile;
  createdAt: string;
}

export type AgentRole =
  | 'implementer'
  | 'reviewer'
  | 'fixer'
  | 'visual_fixer'
  | 'visual_reviewer'
  | 'chat'
  /** Bounded read-only repository reconnaissance. Never edits, never commits. */
  | 'project_analyst'
  /** Tool-free structured classification of what the user asked for. */
  | 'router'
  /** The independent second opinion required before an unattended agent starts. */
  | 'autostart_verifier';

export interface ProviderCapabilities {
  id: ProviderId;
  available: boolean;
  /** Human-readable reason when `available` is false. Surfaced verbatim in the UI. */
  reason?: string;
  version?: string;
  authenticated: boolean;
  authMethod?: string;
  streaming: boolean;
  resumable: boolean;
  models: string[];
  structuredOutput: boolean;
  /** Provider can answer normal chat with no filesystem or execution tools. */
  toolFreeChat?: boolean;
  /**
   * Provider can be restricted to an exact list of built-in tools.
   *
   * Distinct from a read-only sandbox: Codex's `read-only` mode prevents writes
   * but still runs shell commands, which is not what "reads the repository and
   * reports" means. Roles that promise a tool allowlist route only to providers
   * that declare this.
   */
  enforcesToolAllowlist?: boolean;
  cooldownUntil?: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

/** Normalized agent event. Provider-specific shapes never escape the adapter. */
export type AgentEvent =
  | { kind: 'started'; sessionId?: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_started'; tool: string; input?: unknown; id?: string }
  | { kind: 'tool_completed'; tool?: string; id?: string; isError?: boolean; preview?: string }
  | { kind: 'waiting'; note: string }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'completed'; result: string; sessionId?: string; usage?: Record<string, unknown> }
  | { kind: 'failed'; error: string; sessionId?: string };

export interface AgentStartOptions {
  /** Absolute path the agent runs in. For jobs this is always an isolated worktree. */
  cwd: string;
  prompt: string;
  role: AgentRole;
  model?: string;
  /** Resume a previous provider session/thread instead of starting fresh. */
  resumeSessionId?: string;
  /** Extra system instruction appended to the provider default. */
  appendSystemPrompt?: string;
  /** Local images attached to the initial request. Paths must be absolute. */
  imagePaths?: string[];
  /** JSON Schema file constraining the provider's final response. */
  outputSchemaPath?: string;
  /** Disable project/user customizations while preserving subscription authentication. */
  safeMode?: boolean;
  /** Do not persist the external provider session. */
  ephemeral?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  result: string;
  /** Provider session/thread id, persisted so the run can be resumed later. */
  sessionId?: string;
  error?: string;
  usage?: Record<string, unknown>;
  structuredOutput?: unknown;
  memoryProposals: MemoryProposal[];
}

/**
 * A memory an agent suggests during work it was already doing.
 *
 * Never trusted directly — MemoryService re-validates scope, sensitivity,
 * duplication and importance before anything is persisted.
 */
export interface MemoryProposal {
  type: MemoryKind;
  scope: MemoryScope;
  subject?: string;
  content: string;
  importance?: number;
  confidence?: number;
  reason?: string;
}

export interface AgentProvider {
  readonly id: ProviderId;
  capabilities(): Promise<ProviderCapabilities>;
  /**
   * Run the agent to completion, emitting normalized events as they arrive.
   * Implementations must never throw for provider-level failures — they return
   * a `failed` result so the job state machine can record it explicitly.
   */
  run(options: AgentStartOptions, onEvent: (event: AgentEvent) => void): Promise<AgentRunResult>;
}

/** Convert a validated proposal into a MemoryService input. */
export function proposalToInput(
  proposal: MemoryProposal,
  ctx: { projectId?: string | null; sessionId?: string | null; jobId?: string; runId?: string },
): MemoryInput | null {
  const scopeId =
    proposal.scope === 'project'
      ? (ctx.projectId ?? null)
      : proposal.scope === 'session'
        ? (ctx.sessionId ?? null)
        : null;
  // An agent may not propose into a scope the run has no claim to.
  if (proposal.scope === 'project' && !scopeId) return null;
  if (proposal.scope === 'session' && !scopeId) return null;
  if (proposal.scope === 'agent') return null;

  return {
    scope: proposal.scope,
    scopeId,
    kind: proposal.type,
    subject: proposal.subject ?? null,
    content: proposal.content,
    importance: proposal.importance,
    confidence: proposal.confidence ?? 0.7,
    sourceType: 'agent_proposal',
    sourceRef: {
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(proposal.reason ? { note: proposal.reason } : {}),
    },
  };
}
