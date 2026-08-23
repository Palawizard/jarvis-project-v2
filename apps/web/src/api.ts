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
  config: {
    candidateRuntime?: unknown;
    visualQa?: { required?: boolean; routes?: string[] };
  };
  createdAt: string;
  updatedAt: string;
}

export type JobStage =
  | 'queued'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'reviewing'
  | 'visual_qa'
  | 'fixing'
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
  episodeId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
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
  createdAt: string;
}

export interface VisualShot {
  id: string;
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
    route: string;
    viewport: 'desktop' | 'mobile';
    category: string;
    description: string;
    recommendation: string;
  }>;
  createdAt: string;
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
  status: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
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
  health: () => request<Health>('/api/health'),

  projects: () => request<Project[]>('/api/projects'),
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
    request<Project>(`/api/projects/${id}/refresh`, { method: 'POST' }),
  purgeProjectMemory: (id: string) =>
    request<{ removed: number }>(`/api/projects/${id}/memory`, { method: 'DELETE' }),

  session: () =>
    request<{ session: Session; rendered: string; messages: Message[] }>('/api/session'),
  setSessionProject: (id: string, projectId: string | null) =>
    request<Session>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId }),
    }),

  command: (text: string, sessionId: string, projectId: string | null) =>
    request<{ kind: string; reply: string; job?: Job; candidates?: Memory[] }>('/api/command', {
      method: 'POST',
      body: JSON.stringify({ text, sessionId, projectId }),
    }),

  jobs: (projectId?: string) =>
    request<Job[]>(`/api/jobs${projectId ? `?projectId=${projectId}` : ''}`),
  job: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  createJob: (projectId: string, req: string, acceptance: string[], autostart: boolean) =>
    request<Job>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ projectId, request: req, acceptance, autostart }),
    }),
  startJob: (id: string) =>
    request<{ started: boolean }>(`/api/jobs/${id}/start`, { method: 'POST' }),
  cancelJob: (id: string) =>
    request<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  approveJob: (id: string) =>
    request<CandidateApplication>(`/api/jobs/${id}/approve`, { method: 'POST' }),
  applyJob: (id: string) =>
    request<CandidateApplication>(`/api/jobs/${id}/apply`, { method: 'POST' }),

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
    request<{ deleted: boolean }>(`/api/memory/${id}?hard=${hard}`, { method: 'DELETE' }),

  contextPack: (id: string) => request<ContextPack>(`/api/context-packs/${id}`),

  captureVisualQa: (baseUrl: string, routes: string[], projectId?: string) =>
    request<VisualShot[]>('/api/visual-qa', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, routes, projectId }),
    }),

  tools: () => request<Array<{ name: string; description: string; risk: string }>>('/api/tools'),
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
