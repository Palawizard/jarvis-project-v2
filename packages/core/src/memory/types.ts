/** Memory layer selector. See docs/memory-architecture.md for the layer mapping. */
export type MemoryScope = 'user' | 'project' | 'session' | 'agent' | 'procedure';

export type MemoryKind =
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'decision'
  | 'project_knowledge'
  | 'episode'
  | 'procedure'
  | 'unresolved'
  | 'correction'
  | 'other';

export type MemoryStatus = 'active' | 'superseded' | 'expired' | 'deleted';

export type MemorySourceType =
  | 'user_explicit'
  | 'job_consolidation'
  | 'agent_proposal'
  /** Written by a bounded read-only project analysis run. */
  | 'project_analysis'
  | 'system'
  | 'import';

export interface MemorySourceRef {
  sessionId?: string;
  jobId?: string;
  runId?: string;
  messageId?: string;
  note?: string;
}

export interface Memory {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  kind: MemoryKind;
  subject: string | null;
  content: string;
  importance: number;
  confidence: number;
  sourceType: MemorySourceType;
  sourceRef: MemorySourceRef;
  status: MemoryStatus;
  supersedes: string | null;
  supersededBy: string | null;
  pinned: boolean;
  sensitivity: 'normal' | 'private' | 'secret_rejected';
  contentHash: string;
  metadata: Record<string, unknown>;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

/** Everything needed to propose a durable memory. */
export interface MemoryInput {
  scope: MemoryScope;
  scopeId?: string | null;
  kind: MemoryKind;
  subject?: string | null;
  content: string;
  importance?: number;
  confidence?: number;
  sourceType: MemorySourceType;
  sourceRef?: MemorySourceRef;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
  /** Explicit user requests bypass the automatic importance threshold. */
  explicit?: boolean;
}

export type RememberOutcome =
  | { status: 'stored'; memory: Memory; supersededId?: string }
  | { status: 'duplicate'; memory: Memory; reason: string }
  | { status: 'rejected'; reason: string; detail?: string };

/** A memory selected by retrieval, with the evidence for why it ranked. */
export interface RetrievedMemory {
  memory: Memory;
  score: number;
  signals: {
    lexical?: number;
    semantic?: number;
    subjectMatch?: boolean;
    scopePriority: number;
    importance: number;
    confidence: number;
    pinned: boolean;
    recency?: number;
  };
  reason: string;
}

export interface ScopeSelector {
  scope: MemoryScope;
  scopeId?: string | null;
}

export type ForgetResolution =
  | { status: 'resolved'; memory: Memory; matchedBy: 'id' | 'subject' | 'content' }
  | { status: 'ambiguous'; candidates: Memory[] }
  | { status: 'not_found'; candidates: [] };

export interface RetrieveOptions {
  query: string;
  /** Retrieval is scope-filtered BEFORE ranking; unrelated projects never compete. */
  scopes: ScopeSelector[];
  kinds?: MemoryKind[];
  limit?: number;
  /** Include memories whose status is not `active`. Off by default. */
  includeInactive?: boolean;
  /** Reference time for validity windows; defaults to now. Injectable for tests. */
  at?: string;
  /** Skip the semantic leg even when embeddings are available. */
  lexicalOnly?: boolean;
}
