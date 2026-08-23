export { Jarvis } from './jarvis.js';
export { loadConfig, getConfig, setConfig, ensureDirs, type JarvisConfig } from './config.js';
export { openDb, transaction, parseJson, type Db } from './db/index.js';
export { EventBus, type JarvisEvent, type JarvisEventType } from './events/bus.js';

export { MemoryService, calibrateSemantic, toFtsQuery } from './memory/service.js';
export * from './memory/types.js';
export { scanForSecrets, redactSecrets } from './memory/secrets.js';
export {
  detectExplicitCommand,
  classifyExplicitMemory,
  scoreCandidate,
  jaccard,
  foldAccents,
  normaliseForHash,
} from './memory/policy.js';
export {
  getEmbeddingProvider,
  setEmbeddingProvider,
  cosine,
  NULL_ANCHORS,
  type EmbeddingProvider,
  type EmbeddingStatus,
} from './memory/embeddings.js';

export {
  ContextPackBuilder,
  estimateTokens,
  type ContextPack,
  type ContextSelection,
} from './context/pack.js';

export {
  ProjectService,
  detectStack,
  type Project,
  type ProjectCommands,
  type ProjectStack,
  type ProjectConfig,
  type CandidateRuntimeConfig,
  type VisualInteraction,
} from './projects/service.js';
export {
  SessionService,
  type Session,
  type SessionState,
  type Message,
} from './sessions/service.js';

export { JobService, normaliseGoal, type Job, type AgentRun } from './jobs/service.js';
export {
  canTransition,
  assertTransition,
  statusForStage,
  isTerminal,
  InvalidTransitionError,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  type JobStage,
  type JobStatus,
} from './jobs/machine.js';
export { JobPipeline, candidateRejectionReason, renderProjectSnapshot } from './jobs/pipeline.js';

export { AgentRegistry } from './agents/registry.js';
export { ClaudeProvider } from './agents/claude.js';
export { CodexProvider } from './agents/codex.js';
export { extractMemoryProposals, MEMORY_PROPOSAL_INSTRUCTIONS } from './agents/proposals.js';
export * from './agents/types.js';

export {
  GitWorkspace,
  repoStatus,
  GitError,
  type RepoStatus,
  type Worktree,
} from './git/workspace.js';
export {
  VerificationEngine,
  type VerificationReport,
  type VerificationResult,
} from './verification/engine.js';
export {
  ReviewEngine,
  parseReviewOutput,
  type Review,
  type ReviewFinding,
} from './review/engine.js';
export { VisualQaEngine, startDevServer, type VisualQaShot } from './visualqa/engine.js';
export {
  startCandidateRuntime,
  CandidateRuntimeUnsupportedError,
  type CandidateRuntime,
} from './runtime/candidate.js';

export {
  ToolRegistry,
  riskExceeds,
  ToolPermissionError,
  type RiskLevel,
  type ToolDefinition,
  type ToolContext,
} from './tools/registry.js';
export { registerBuiltinTools } from './tools/builtin.js';

export { createLogger } from './logger.js';
export { newId, nowIso, sha256 } from './ids.js';
