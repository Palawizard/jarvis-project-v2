export { Jarvis } from './jarvis.js';
export { loadConfig, getConfig, setConfig, ensureDirs, type JarvisConfig } from './config.js';
export { openDb, transaction, parseJson, type Db } from './db/index.js';
export { HumanControlAuth } from './auth/control.js';
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

export {
  JobService,
  normaliseGoal,
  type Job,
  type AgentRun,
  type RepairKind,
  type RepairCheckpoint,
} from './jobs/service.js';
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
export {
  CandidateApplicationService,
  CandidateApplicationError,
  type CandidateApplication,
  type CandidateApplicationStatus,
} from './application/service.js';
export { UpgradeManager, type UpgradeTransaction, type UpgradeStatus } from './upgrade/manager.js';

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
  type FastForwardPreflight,
} from './git/workspace.js';
export {
  VerificationEngine,
  type VerificationReport,
  type VerificationResult,
  type VerificationFailureKind,
} from './verification/engine.js';
export {
  ReviewEngine,
  parseReviewOutput,
  type Review,
  type ReviewFinding,
} from './review/engine.js';
export {
  VisualQaEngine,
  isEvidenceCoverageFailure,
  EVIDENCE_COVERAGE_PREFIX,
  type VisualQaShot,
  type VisualReviewFinding,
} from './visualqa/engine.js';
export { VisualReviewer, parseVisualReview, type VisualReview } from './visualqa/reviewer.js';
export {
  resolveVisualPlan,
  mapChangedFilesToSurfaces,
  SELF_VISUAL_SURFACES,
  FIXTURE_PAUSED_JOB_ID,
  selfSurfaceScenario,
  type VisualQaPlan,
  type VisualFixtureProfile,
} from './visualqa/surfaces.js';
export {
  startCandidateRuntime,
  CandidateRuntimeUnsupportedError,
  type CandidateRuntime,
} from './runtime/candidate.js';
export {
  seedCandidateFixtures,
  requestedCandidateFixtures,
  CANDIDATE_FIXTURE_ENV,
} from './runtime/fixtures.js';

export {
  ToolRegistry,
  ToolPermissionError,
  EFFECT_UNKNOWN_STATUSES,
  type ToolDefinition,
  type ToolContext,
  type ToolCallContext,
  type ToolExecution,
  type ToolExecutionOutcome,
  type ToolExecutionStatus,
  type ToolGrant,
  type GrantInput as ToolGrantInput,
  type ToolRegistryOptions,
} from './tools/registry.js';
export {
  decide as decideToolPolicy,
  previewDecision,
  riskExceeds,
  isGrantableActor,
  RISK_LEVELS,
  MAX_GRANTABLE_RISK,
  type RiskLevel,
  type ToolActor,
  type PolicyDecision,
} from './tools/policy.js';
export { registerBuiltinTools } from './tools/builtin.js';
export {
  agentIsolationPreflight,
  type AgentIsolationBackend,
  type AgentIsolationPreflight,
} from './tools/isolation.js';

export { createLogger } from './logger.js';
export { newId, nowIso, sha256 } from './ids.js';
