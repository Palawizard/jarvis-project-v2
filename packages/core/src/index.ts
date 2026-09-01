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
  normaliseProjectName,
  projectNameKeys,
  type Project,
  type ProjectCommands,
  type ProjectStack,
  type ProjectConfig,
  type ProjectResolution,
  type CandidateRuntimeConfig,
  type VisualInteraction,
  renderProjectRegistry,
  mentionsSelfProject,
} from './projects/service.js';
export {
  classifyProjectReference,
  tokenizeMessage,
  type ProjectReference,
  type MessageTokens,
} from './projects/reference.js';
export {
  ProjectAnalysisService,
  parseAnalystResult,
  type ProjectAnalysisOutcome,
} from './projects/analysis.js';
export {
  PROJECT_PROFILE_VERSION,
  ProjectProfileResultSchema,
  renderProjectProfile,
  type ProjectProfile,
  type ProjectAnalysisState,
} from './projects/profile.js';
export {
  SessionService,
  ConversationService,
  deriveConversationTitle,
  type Session,
  type Conversation,
  type ConversationSummary,
  type SessionState,
  type Message,
  type MessageStatus,
} from './sessions/service.js';
export { ChatService, type ChatTurn, type ChatTurnKind } from './chat/service.js';
export {
  SemanticRouter,
  ROUTER_SCHEMA_VERSION,
  RouterResultSchema,
  VerifierResultSchema,
  type RouterResult,
  type RouterKind,
  type ProjectRelationship,
  type RoutingAudit,
  type RoutingOutcome,
  type RoutingRejection,
  type RoutedTurn,
} from './chat/router.js';
export {
  ChatActionSchema,
  extractChatAction,
  ACTION_TOOLS,
  CHAT_ACTION_INSTRUCTIONS,
  type ChatAction,
  type ChatActionName,
} from './chat/actions.js';

export {
  JobService,
  normaliseGoal,
  type Job,
  type JobTombstone,
  type AgentRun,
  type RepairKind,
  type RepairCheckpoint,
} from './jobs/service.js';
export { JobLifecycle, type StaleJobReport, type JobDeletionPlan } from './jobs/lifecycle.js';
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
export {
  JobPipeline,
  candidateRejectionReason,
  renderProjectSnapshot,
  agentStagePauseReason,
  type AgentStageOutcome,
} from './jobs/pipeline.js';
export {
  CandidateApplicationService,
  CandidateApplicationError,
  type CandidateApplication,
  type CandidateApplicationStatus,
} from './application/service.js';
export { UpgradeManager, type UpgradeTransaction, type UpgradeStatus } from './upgrade/manager.js';

export {
  AgentRegistry,
  classifyAgentFailure,
  describeAgentFailure,
  parseQuotaReset,
  INFRASTRUCTURE_FAILURE_KINDS,
  type AgentFailureKind,
} from './agents/registry.js';
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
  isCandidateDevServerNoise,
  isCandidateStreamAbort,
  EVIDENCE_COVERAGE_PREFIX,
  type VisualQaShot,
  type VisualReviewFinding,
} from './visualqa/engine.js';
export {
  VisualReviewer,
  parseVisualReview,
  parseDurableVisualReview,
  serializeVisualReview,
  type VisualReview,
} from './visualqa/reviewer.js';
export {
  resolveVisualPlan,
  mapChangedFilesToSurfaces,
  SELF_VISUAL_SURFACES,
  FIXTURE_PAUSED_JOB_ID,
  selfSurfaceScenario,
  type VisualQaPlan,
  planFixtures,
  type VisualFixtureProfile,
} from './visualqa/surfaces.js';
export {
  resolveVisualPlanForCandidate,
  validateCatalog,
  VisualQaPlanningError,
  VISUAL_QA_CATALOG_PATH,
} from './visualqa/candidate-plan.js';
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
export { registerBuiltinTools, searchEverything, type SearchHit } from './tools/builtin.js';
export {
  agentIsolationPreflight,
  type AgentIsolationBackend,
  type AgentIsolationPreflight,
} from './tools/isolation.js';

export { createLogger } from './logger.js';
export { newId, nowIso, sha256 } from './ids.js';
