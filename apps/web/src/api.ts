/** Types mirrored from @jarvis/core. Kept structural so the UI never imports Node code. */

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  stack: {
    languages: string[];
    frameworks: string[];
    packageManager?: string;
    hasTests: boolean;
    webRoutes?: string[];
  };
  commands: Record<string, string | undefined>;
  devUrl: string | null;
  summary: string | null;
  isSelf: boolean;
  aliases: string[];
  archivedAt: string | null;
  config: {
    candidateRuntime?: unknown;
    visualQa?: { required?: boolean; routes?: string[] };
  };
  createdAt: string;
  updatedAt: string;
}

export interface UnregisterPreflight {
  eligible: boolean;
  mode: 'hard' | 'soft';
  reason: string;
  activeJobs: number;
  historicalJobs: number;
  memories: number;
}

export type JobStage =
  | 'queued'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'reviewing'
  | 'visual_qa'
  | 'fixing'
  | 'paused'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Job {
  id: string;
  projectId: string;
  sessionId: string | null;
  request: string;
  goal: string;
  acceptance: string[];
  stage: JobStage;
  status: string;
  error: string | null;
  branch: string | null;
  worktreePath: string | null;
  baseRef: string | null;
  headRef: string | null;
  fixCycles: number;
  reviewFixCycles: number;
  visualFixCycles: number;
  resumeStage: JobStage | null;
  pauseReason: string | null;
  reviewedHead: string | null;
  visualHead: string | null;
  candidateBaseSha: string | null;
  candidateSourceSha: string | null;
  validationOnly: boolean;
  visualQaPlan: {
    source: string;
    scenarios: Array<{ name: string; viewports?: Array<'desktop' | 'mobile'> }>;
    reasons: string[];
  } | null;
  episodeId: string | null;
  archivedAt: string | null;
  predecessorJobId: string | null;
  originMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface JobTombstone {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  goal: string;
  reason: string;
  deletedAt: string;
}

export interface StaleJobReport {
  stale: boolean;
  reason: string;
  jobBase: string | null;
  targetHead: string | null;
  detail: string;
}

export interface JobDeletionPlan {
  eligible: boolean;
  reason: string;
  removes: string[];
  preserves: string[];
}

export interface Memory {
  id: string;
  scope: string;
  scopeId: string | null;
  kind: string;
  subject: string | null;
  content: string;
  importance: number;
  confidence: number;
  sourceType: string;
  sourceRef: { sessionId?: string; jobId?: string; runId?: string; note?: string };
  status: 'active' | 'superseded' | 'expired' | 'deleted';
  supersedes: string | null;
  supersededBy: string | null;
  pinned: boolean;
  metadata: Record<string, unknown>;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

export interface JarvisEvent {
  id?: number;
  type: string;
  jobId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface AgentRun {
  id: string;
  provider: string;
  model: string | null;
  role: string;
  externalSessionId: string | null;
  status: string;
  result: string | null;
  error: string | null;
  contextPackId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Verification {
  id: string;
  name: string;
  command: string;
  status: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  kind: string;
  required: boolean;
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file?: string;
  line?: number;
  description: string;
  recommendation: string;
}

export interface Review {
  id: string;
  provider: string;
  verdict: 'approve' | 'request_changes' | 'error';
  summary: string;
  findings: ReviewFinding[];
  headRef: string;
  blocking: boolean;
  createdAt: string;
}

export interface VisualShot {
  id: string;
  scenarioName: string;
  route: string;
  viewport: string;
  screenshotPath: string | null;
  consoleErrors: string[];
  networkFailures: string[];
  status: string;
  error: string | null;
  reviewedBy: string | null;
  reviewVerdict: 'pass' | 'needs_fix' | null;
  reviewFindings: Array<{
    severity: 'high' | 'medium' | 'low' | 'info';
    scenarioName: string;
    route: string;
    viewport: 'desktop' | 'mobile';
    category: string;
    description: string;
    recommendation: string;
  }>;
  createdAt: string;
  headRef: string | null;
  cycle: number;
}

export interface ContextSelection {
  memoryId: string;
  scope: string;
  kind: string;
  score: number;
  reason: string;
  tokens: number;
  section: string;
  memory?: Memory | null;
}

export interface ContextPack {
  id: string;
  role: string;
  rendered: string;
  usedTokens: number;
  budgetTokens: number;
  selections: ContextSelection[];
  createdAt?: string;
}

export interface CandidateChanges {
  head: string;
  commits: Array<{ sha: string; subject: string }>;
  files: Array<{ path: string; added: number; removed: number }>;
  diff: string;
  diffTruncated: boolean;
  uncommitted: string[];
}

export interface JobDetail {
  job: Job;
  stages: JobStage[];
  running: boolean;
  acceptanceEligible: boolean;
  acceptanceError: string | null;
  application: CandidateApplication | null;
  upgrade: UpgradeTransaction | null;
  routingDecisions: RoutingDecision[];
  runs: AgentRun[];
  candidate: CandidateChanges | null;
  verifications: Verification[];
  reviews: Review[];
  visualQa: VisualShot[];
  events: JarvisEvent[];
  episode: Memory | null;
  contextPacks: ContextPack[];
  project: Project | null;
  staleness: StaleJobReport | null;
  deletionPlan: JobDeletionPlan;
}

export interface CandidateApplication {
  id: string;
  status: 'approved' | 'applying' | 'applied' | 'failed' | 'inspection_required';
  candidateBase: string;
  candidateHead: string;
  targetBranch: string | null;
  targetHeadBefore: string | null;
  targetHeadAfter: string | null;
  method: 'ff-only';
  failure: string | null;
  approvedAt: string;
  completedAt: string | null;
}

export interface RoutingDecision {
  id: string;
  role: string;
  provider: string | null;
  model: string | null;
  reason: string;
  createdAt: string;
}

export interface UpgradeTransaction {
  id: string;
  status: string;
  previousSha: string;
  candidateSha: string;
  rollbackRef: string | null;
  healthcheckResult: Record<string, unknown> | null;
  rollbackSha: string | null;
  failure: string | null;
}

export interface ProviderCapability {
  id: string;
  available: boolean;
  reason?: string;
  version?: string;
  authenticated: boolean;
  authMethod?: string;
  models: string[];
  cooldownUntil?: string;
}

export interface Health {
  ok: boolean;
  home: string;
  artifactsDir: string;
  providers: ProviderCapability[];
  memory: {
    active: number;
    superseded: number;
    deleted: number;
    expired: number;
    embedded: number;
    embeddings: {
      enabled: boolean;
      ready: boolean;
      model: string;
      dim: number;
      error?: string;
      disabledForProcess: boolean;
    };
  };
  context: { budgetTokens: number };
}

export type RiskLevel =
  'observe' | 'safe_action' | 'reversible_modification' | 'sensitive' | 'destructive';

export type ToolActor = 'user' | 'agent' | 'system';
export type PolicyDecision = 'allow' | 'confirm' | 'deny';

export interface ToolSummary {
  name: string;
  description: string;
  risk: RiskLevel;
  decision: PolicyDecision;
  schema: unknown;
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

export interface ToolExecution {
  id: string;
  toolName: string;
  risk: RiskLevel;
  actor: ToolActor;
  originatingActor: ToolActor;
  decision: PolicyDecision;
  reasonCode: string;
  status: ToolExecutionStatus;
  reason: string;
  sessionId: string | null;
  projectId: string | null;
  jobId: string | null;
  agentRunId: string | null;
  parentExecutionId: string | null;
  input: unknown;
  inputValidated: boolean;
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

export interface ToolCapabilities {
  sensitiveAgentTools: {
    active: boolean;
    backend: string | null;
    reason: string;
    guarantees: string[];
  };
}

export type ToolOutcome =
  | { status: 'succeeded'; execution: ToolExecution; result: unknown }
  | { status: 'failed'; execution: ToolExecution; error: string }
  | { status: 'timed_out'; execution: ToolExecution; error: string; effectUnknown: true }
  | { status: 'denied'; execution: ToolExecution; error: string }
  | { status: 'pending_approval'; execution: ToolExecution };

export interface Session {
  id: string;
  title: string | null;
  projectId: string | null;
  state: {
    goal?: string;
    constraints: string[];
    decisions: string[];
    unresolved: string[];
    entities: string[];
    activeJobIds: string[];
    artifacts: string[];
  };
  status: 'active' | 'archived';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type Conversation = Session;

export interface ConversationSummary extends Session {
  preview: string | null;
  messageCount: number;
  jobIds: string[];
}

export type MessageStatus =
  'complete' | 'pending' | 'streaming' | 'failed' | 'stopped' | 'interrupted';

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: MessageStatus;
  jobId: string | null;
  metadata: {
    error?: string;
    activity?: string;
    jobIds?: string[];
    executionId?: string;
    tool?: string;
    /** Server-resolved name for a pending action target. */
    target?: string;
  };
  createdAt: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  rendered: string;
  messages: Message[];
  toolExecutions: ToolExecution[];
  jobs: Job[];
  tombstones: JobTombstone[];
  responding: boolean;
}

export interface ChatTurn {
  conversationId: string;
  kind: 'memory' | 'chat' | 'action' | 'clarification' | 'confirmation_required' | 'error';
  reply: string;
  userMessage: Message | null;
  assistantMessage: Message | null;
  action?: {
    name: string;
    status: 'executed' | 'confirmation_required' | 'refused';
    executionId?: string;
    error?: string;
  };
  job?: Job | null;
  memoryCandidates?: Memory[];
  projectCandidates?: Project[];
}

export interface SearchHit {
  type: 'conversation' | 'project' | 'job';
  id: string;
  title: string;
  subtitle: string;
}

export interface AuthStatus {
  authenticated: boolean;
  paired: boolean;
}

const CONTROL_STORAGE_KEY = 'jarvis-human-control';

function clean(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function controlCredential(): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(CONTROL_STORAGE_KEY);
}

export async function authenticatedFetch(path: string, init?: RequestInit): Promise<Response> {
  const credential = controlCredential();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(credential ? { 'x-jarvis-control': credential } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401 && typeof localStorage !== 'undefined') {
    localStorage.removeItem(CONTROL_STORAGE_KEY);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('jarvis-auth-failed'));
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  pair: async (bootstrap: string) => {
    const paired = await request<{ credential: string }>('/api/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ bootstrap }),
    });
    localStorage.setItem(CONTROL_STORAGE_KEY, paired.credential);
    return paired;
  },
  revokeControl: async () => {
    const result = await request<{ revoked: boolean; restartRequired: boolean }>(
      '/api/auth/revoke',
      { method: 'POST' },
    );
    localStorage.removeItem(CONTROL_STORAGE_KEY);
    return result;
  },
  health: () => request<Health>('/api/health'),

  projects: (params: { status?: string; search?: string } = {}) =>
    request<Project[]>(`/api/projects?${new URLSearchParams(clean(params))}`),
  project: (id: string) =>
    request<{
      project: Project;
      snapshot: string;
      jobs: Job[];
      memory: { items: Memory[]; total: number };
    }>(`/api/projects/${id}`),
  addProject: (rootPath: string, name?: string, devUrl?: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ rootPath, name, devUrl }),
    }),
  refreshProject: (id: string) =>
    request<ToolOutcome>(`/api/projects/${id}/refresh`, { method: 'POST' }),
  updateProject: (
    id: string,
    patch: Partial<Pick<Project, 'name' | 'aliases' | 'devUrl' | 'summary'>>,
  ) =>
    request<ToolOutcome>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  archiveProject: (id: string, archived: boolean) =>
    request<ToolOutcome>(`/api/projects/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  unregisterPreflight: (id: string) =>
    request<UnregisterPreflight>(`/api/projects/${id}/unregister-preflight`),
  unregisterProject: (id: string) =>
    request<ToolOutcome>(`/api/projects/${id}`, { method: 'DELETE' }),
  purgeProjectMemory: (id: string) =>
    request<ToolOutcome>(`/api/projects/${id}/memory`, { method: 'DELETE' }),

  conversations: (params: { status?: string; search?: string } = {}) =>
    request<ConversationSummary[]>(`/api/conversations?${new URLSearchParams(clean(params))}`),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}`),
  createConversation: (title?: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    }),
  updateConversation: (
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null },
  ) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<ToolOutcome>(`/api/conversations/${id}`, { method: 'DELETE' }),
  sendMessage: (id: string, text: string) =>
    request<ChatTurn>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  stopResponse: (id: string) =>
    request<{ stopped: boolean }>(`/api/conversations/${id}/stop`, { method: 'POST' }),
  retryResponse: (id: string) =>
    request<ChatTurn>(`/api/conversations/${id}/retry`, { method: 'POST' }),
  editLastMessage: (id: string, text: string) =>
    request<ChatTurn>(`/api/conversations/${id}/edit-last`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  search: (query: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`),

  session: () =>
    request<{ session: Session; rendered: string; messages: Message[] }>('/api/session'),
  setSessionProject: (id: string, projectId: string | null) =>
    request<Session>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId }),
    }),

  jobs: (
    params: {
      projectId?: string;
      sessionId?: string;
      status?: string;
      stage?: string;
      search?: string;
      archived?: string;
      sort?: string;
      limit?: string;
    } = {},
  ) => request<Job[]>(`/api/jobs?${new URLSearchParams(clean(params))}`),
  job: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  createJob: (
    projectId: string,
    req: string,
    acceptance: string[],
    autostart: boolean,
    options?: {
      validationOnly?: boolean;
      candidateSource?: { baseSha: string; sourceSha: string };
    },
  ) =>
    request<Job>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ projectId, request: req, acceptance, autostart, ...options }),
    }),
  startJob: (id: string) =>
    request<{ started: boolean }>(`/api/jobs/${id}/start`, { method: 'POST' }),
  cancelJob: (id: string) => request<ToolOutcome>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  resumeJob: (id: string) => request<ToolOutcome>(`/api/jobs/${id}/resume`, { method: 'POST' }),
  archiveJob: (id: string, archived: boolean) =>
    request<ToolOutcome>(`/api/jobs/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  retryJob: (id: string, autostart = true) =>
    request<ToolOutcome>(`/api/jobs/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ autostart }),
    }),
  jobDeletionPlan: (id: string) => request<JobDeletionPlan>(`/api/jobs/${id}/deletion-plan`),
  deleteJob: (id: string) => request<ToolOutcome>(`/api/jobs/${id}`, { method: 'DELETE' }),
  approveJob: (id: string) =>
    request<CandidateApplication>(`/api/jobs/${id}/approve`, { method: 'POST' }),
  applyJob: (id: string) =>
    request<CandidateApplication>(`/api/jobs/${id}/apply`, { method: 'POST' }),
  prepareUpgrade: (id: string) =>
    request<UpgradeTransaction>(`/api/jobs/${id}/upgrade/prepare`, { method: 'POST' }),
  activateUpgrade: (id: string, activationToken: string) =>
    request<UpgradeTransaction>(`/api/jobs/${id}/upgrade/activate`, {
      method: 'POST',
      body: JSON.stringify({ activationToken }),
    }),

  memory: (params: Record<string, string>) =>
    request<{ items: Memory[]; total: number }>(`/api/memory?${new URLSearchParams(params)}`),
  memoryOne: (id: string) =>
    request<{ memory: Memory; supersedes: Memory | null; supersededBy: Memory | null }>(
      `/api/memory/${id}`,
    ),
  searchMemory: (query: string, projectId: string | null) =>
    request<
      Array<{ memory: Memory; score: number; reason: string; signals: Record<string, unknown> }>
    >('/api/memory/search', { method: 'POST', body: JSON.stringify({ query, projectId }) }),
  addMemory: (body: Partial<Memory> & { content: string }) =>
    request<{ status: string; memory?: Memory; reason?: string; detail?: string }>('/api/memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pinMemory: (id: string, pinned: boolean) =>
    request<Memory>(`/api/memory/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }),
  correctMemory: (id: string, content: string) =>
    request<{ status: string }>(`/api/memory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (id: string, hard = false) =>
    request<{ deleted: boolean; mode: 'soft' } | ToolOutcome>(`/api/memory/${id}?hard=${hard}`, {
      method: 'DELETE',
    }),

  contextPack: (id: string) => request<ContextPack>(`/api/context-packs/${id}`),

  captureVisualQa: (baseUrl: string, routes: string[], projectId?: string) =>
    request<VisualShot[]>('/api/visual-qa', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, routes, projectId }),
    }),

  tools: () => request<ToolSummary[]>('/api/tools'),
  toolCapabilities: () => request<ToolCapabilities>('/api/tools/capabilities'),
  toolExecutions: () =>
    request<{ pending: ToolExecution[]; executions: ToolExecution[] }>('/api/tool-executions'),
  approveTool: (id: string, remember: boolean, projectId: string | null) =>
    request<ToolOutcome>(`/api/tool-executions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ remember, projectId }),
    }),
  denyTool: (id: string, reason?: string) =>
    request<ToolExecution>(`/api/tool-executions/${id}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  retryTool: (id: string) =>
    request<ToolOutcome>(`/api/tool-executions/${id}/retry`, { method: 'POST' }),
  toolGrants: () => request<ToolGrant[]>('/api/tool-grants'),
  revokeToolGrant: (id: string) =>
    request<{ revoked: boolean }>(`/api/tool-grants/${id}`, { method: 'DELETE' }),
  artifact: async (url: string) => {
    const response = await authenticatedFetch(url);
    if (!response.ok) throw new Error(`artifact request failed: ${response.status}`);
    return response.blob();
  },
};

/** Screenshots are served from the artifacts root, addressed by relative path. */
export function artifactUrl(absolutePath: string, artifactsRoot: string): string {
  const normalised = absolutePath.replace(/\\/g, '/');
  const root = artifactsRoot.replace(/\\/g, '/');
  const relative = normalised.startsWith(root)
    ? normalised.slice(root.length).replace(/^\//, '')
    : normalised;
  return `/api/artifacts/${relative.split('/').map(encodeURIComponent).join('/')}`;
}
