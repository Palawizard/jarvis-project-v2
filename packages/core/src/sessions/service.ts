import type { Db } from '../db/index.js';
import { likeTerm, parseJson, transaction } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import { redactSecrets } from '../memory/secrets.js';

/**
 * Layer 1 — active working memory of one conversation.
 *
 * Structured and bounded on purpose. This is what a restarted Jarvis reads to
 * understand "what are we doing right now", and it is never a transcript.
 */
export interface SessionState {
  goal?: string;
  constraints: string[];
  decisions: string[];
  unresolved: string[];
  entities: string[];
  activeJobIds: string[];
  artifacts: string[];
  updatedAt?: string;
}

/**
 * A conversation.
 *
 * Stored in `sessions` for backward compatibility with every existing row and
 * foreign key; "Conversation" is the product-level name and the one the API and
 * UI use. `projectId` is *affinity*, not a required target: it records which
 * project the discussion drifted towards, and any explicit mention overrides it.
 */
export interface Session {
  id: string;
  title: string | null;
  projectId: string | null;
  state: SessionState;
  status: 'active' | 'archived';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  consolidatedAt: string | null;
}

export type Conversation = Session;

/** A conversation as the sidebar needs it: cheap, with a one-line preview. */
export interface ConversationSummary extends Session {
  preview: string | null;
  messageCount: number;
  jobIds: string[];
}

export type MessageStatus =
  'complete' | 'pending' | 'streaming' | 'failed' | 'stopped' | 'interrupted';

export interface MessageMetadata {
  /** Why a response ended the way it did. Redacted before it is stored. */
  error?: string;
  /** Deterministic activity cards ("job started", "job paused"). */
  activity?: string;
  /** Job ids this message refers to, for tombstone-safe card rendering. */
  jobIds?: string[];
  [key: string]: unknown;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  truncated: boolean;
  status: MessageStatus;
  jobId: string | null;
  metadata: MessageMetadata;
  createdAt: string;
}

const EMPTY_STATE: SessionState = {
  constraints: [],
  decisions: [],
  unresolved: [],
  entities: [],
  activeJobIds: [],
  artifacts: [],
};

/** Hard caps keep working memory small no matter how long a conversation runs. */
const LIMITS = { constraints: 8, decisions: 12, unresolved: 8, entities: 12, artifacts: 10 };

/** Raw history rows are archive, not context — cap what we store per message. */
const MAX_MESSAGE_CHARS = 8000;

const MAX_TITLE_CHARS = 60;

type Row = Record<string, unknown>;

function rowToSession(row: Row): Session {
  return {
    id: row.id as string,
    title: (row.title as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    state: { ...EMPTY_STATE, ...parseJson(row.state as string, {}) },
    status: row.archived_at ? 'archived' : 'active',
    pinned: Number(row.pinned ?? 0) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    consolidatedAt: (row.consolidated_at as string) ?? null,
  };
}

function rowToMessage(row: Row): Message {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as Message['role'],
    content: row.content as string,
    truncated: Number(row.truncated) === 1,
    status: ((row.status as MessageStatus) || 'complete') as MessageStatus,
    jobId: (row.job_id as string) ?? null,
    metadata: parseJson(row.metadata as string, {} as MessageMetadata),
    createdAt: row.created_at as string,
  };
}

/**
 * Derive a conversation title from its first useful message.
 *
 * Deterministic and local: spending a model round-trip to name a chat is exactly
 * the quota-burning pattern the design forbids, and the user can rename anyway.
 */
export function deriveConversationTitle(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New conversation';
  return cleaned.length > MAX_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : cleaned;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly bus?: EventBus,
  ) {}

  create(input: { title?: string; projectId?: string | null } = {}): Session {
    const now = nowIso();
    const session: Session = {
      id: newId('ses'),
      title: input.title?.trim() || null,
      projectId: input.projectId ?? null,
      state: { ...EMPTY_STATE },
      status: 'active',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      consolidatedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, project_id, state, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        session.id,
        session.title,
        session.projectId,
        JSON.stringify(session.state),
        'active',
        now,
        now,
      );
    this.bus?.emit({
      type: 'conversation.created',
      sessionId: session.id,
      payload: { title: session.title },
    });
    return session;
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  list(limit = 30): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(rowToSession);
  }

  /**
   * The sidebar list. Pinned first, then most recent activity, with a preview
   * and the linked Job ids so the UI can badge a conversation that needs you.
   */
  conversations(
    filter: { status?: 'active' | 'archived' | 'all'; search?: string; limit?: number } = {},
  ): ConversationSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const status = filter.status ?? 'active';
    if (status === 'active') where.push('s.archived_at IS NULL');
    if (status === 'archived') where.push('s.archived_at IS NOT NULL');
    const search = filter.search?.trim();
    if (search) {
      where.push(
        `(lower(COALESCE(s.title,'')) LIKE ?1 ESCAPE '~'
          OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id
            AND lower(m.content) LIKE ?1 ESCAPE '~'))`,
      );
      params.push(likeTerm(search.toLowerCase()));
    }
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.pinned DESC, s.updated_at DESC, s.rowid DESC LIMIT ?`,
      )
      .all(...params, Math.min(Math.max(filter.limit ?? 60, 1), 300)) as Row[];
    return rows.map((row) => {
      const session = rowToSession(row);
      const last = this.db
        .prepare(
          `SELECT content FROM messages WHERE session_id = ? AND trim(content) <> ''
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(session.id) as { content?: string } | undefined;
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
        .get(session.id) as { n: number };
      const jobs = this.db
        .prepare('SELECT id FROM jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 20')
        .all(session.id) as Array<{ id: string }>;
      return {
        ...session,
        preview: last?.content ? last.content.replace(/\s+/g, ' ').slice(0, 120) : null,
        messageCount: Number(count.n),
        jobIds: jobs.map((job) => job.id),
      };
    });
  }

  /** Most recent active conversation, or a fresh one. */
  current(): Session {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`)
      .get() as Row | undefined;
    return row ? rowToSession(row) : this.create();
  }

  setProject(id: string, projectId: string | null): Session | null {
    this.db
      .prepare('UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?')
      .run(projectId, nowIso(), id);
    return this.get(id);
  }

  rename(id: string, title: string): Session | null {
    const clean = title.trim().slice(0, 200);
    // A blank title is a no-op. Returning the session made conversation.rename
    // report `succeeded` for a rename that never happened -- the HTTP route
    // guards this, but the chat path does not reach that guard.
    if (!clean) return null;
    this.db
      // Not updated_at: renaming a months-old conversation is not activity in
      // it, and the sidebar orders by updated_at.
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(clean, id);
    const session = this.get(id);
    if (session) {
      this.bus?.emit({ type: 'conversation.updated', sessionId: id, payload: { title: clean } });
    }
    return session;
  }

  setPinned(id: string, pinned: boolean): Session | null {
    this.db
      .prepare('UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, nowIso(), id);
    const session = this.get(id);
    if (session)
      this.bus?.emit({ type: 'conversation.updated', sessionId: id, payload: { pinned } });
    return session;
  }

  setArchived(id: string, archived: boolean): Session | null {
    const now = nowIso();
    this.db
      .prepare(`UPDATE sessions SET archived_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? now : null, archived ? 'archived' : 'active', now, id);
    const session = this.get(id);
    if (session) {
      this.bus?.emit({
        type: archived ? 'conversation.archived' : 'conversation.updated',
        sessionId: id,
        payload: { archived },
      });
    }
    return session;
  }

  /**
   * Delete a conversation.
   *
   * Removes the transcript and the conversation-only working state, and nothing
   * else. Jobs created from it survive with a null conversation link (the
   * `jobs.session_id` foreign key is ON DELETE SET NULL precisely so an audit
   * trail cannot be erased by tidying up a chat), as do global user memories,
   * project memories and every piece of application/upgrade evidence.
   */
  delete(id: string): { deleted: boolean; messages: number; detachedJobs: number } {
    const session = this.get(id);
    if (!session) return { deleted: false, messages: 0, detachedJobs: 0 };
    return transaction(this.db, () => {
      const detachedJobs = Number(
        (
          this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE session_id = ?').get(id) as {
            n: number;
          }
        ).n,
      );
      const messages = Number(
        this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id).changes,
      );
      // Layer-1 working state only. Global/project memory is untouched.
      this.db.prepare(`DELETE FROM memories WHERE scope = 'session' AND scope_id = ?`).run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.bus?.emit({ type: 'conversation.deleted', payload: { conversationId: id, messages } });
      return { deleted: true, messages, detachedJobs };
    });
  }

  /**
   * Incremental, deterministic compaction.
   *
   * There is no LLM call here: we merge structured deltas and trim to the caps
   * above. Re-summarising the whole conversation every turn is exactly the
   * quota-burning pattern the design forbids.
   */
  updateState(id: string, patch: Partial<SessionState>): Session | null {
    const session = this.get(id);
    if (!session) return null;
    const state = session.state;

    const merge = (existing: string[], incoming: string[] | undefined, cap: number): string[] => {
      if (!incoming?.length) return existing;
      const seen = new Set(existing.map((s) => s.toLowerCase().trim()));
      const merged = [...existing];
      for (const item of incoming) {
        const key = item.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item.trim());
      }
      // Newest wins when we overflow: older entries have had their chance.
      return merged.slice(-cap);
    };

    const next: SessionState = {
      ...state,
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      constraints: merge(state.constraints, patch.constraints, LIMITS.constraints),
      decisions: merge(state.decisions, patch.decisions, LIMITS.decisions),
      unresolved: merge(state.unresolved, patch.unresolved, LIMITS.unresolved),
      entities: merge(state.entities, patch.entities, LIMITS.entities),
      artifacts: merge(state.artifacts, patch.artifacts, LIMITS.artifacts),
      activeJobIds: patch.activeJobIds ?? state.activeJobIds,
      updatedAt: nowIso(),
    };

    this.db
      .prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), nowIso(), id);
    this.bus?.emit({ type: 'session.updated', sessionId: id, payload: { state: next } });
    return this.get(id);
  }

  /** Resolve an unresolved item without rewriting the whole state. */
  resolveItem(id: string, item: string): void {
    const session = this.get(id);
    if (!session) return;
    const next = {
      ...session.state,
      unresolved: session.state.unresolved.filter((u) => u !== item),
    };
    this.db
      .prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), nowIso(), id);
  }

  /** Compact rendering handed to the Context Pack Builder. */
  renderState(state: SessionState): string {
    const lines: string[] = [];
    if (state.goal) lines.push(`Goal: ${state.goal}`);
    if (state.constraints.length) lines.push(`Constraints: ${state.constraints.join('; ')}`);
    if (state.decisions.length) lines.push(`Decisions so far: ${state.decisions.join('; ')}`);
    if (state.unresolved.length) lines.push(`Open questions: ${state.unresolved.join('; ')}`);
    if (state.entities.length) lines.push(`In play: ${state.entities.join(', ')}`);
    if (state.artifacts.length) lines.push(`Artifacts: ${state.artifacts.join(', ')}`);
    return lines.join('\n');
  }

  // ------------------------------------------------------- Layer 6: archive --

  addMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    options: { status?: MessageStatus; jobId?: string | null; metadata?: MessageMetadata } = {},
  ): Message {
    const safe = redactSecrets(content);
    const truncated = safe.length > MAX_MESSAGE_CHARS;
    const stored = truncated ? `${safe.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]` : safe;
    const message: Message = {
      id: newId('msg'),
      sessionId,
      role,
      content: stored,
      truncated,
      status: options.status ?? 'complete',
      jobId: options.jobId ?? null,
      metadata: options.metadata ?? {},
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, truncated, status, job_id, metadata, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        message.id,
        sessionId,
        role,
        message.content,
        truncated ? 1 : 0,
        message.status,
        message.jobId,
        JSON.stringify(message.metadata),
        message.createdAt,
      );
    this.touch(sessionId, message.createdAt);
    // Name the conversation from its first useful user message, once. From the
    // REDACTED text: the title is durable, and it is rendered in the sidebar,
    // returned by the conversations API, indexed by search and copied into
    // event payloads, so deriving it from the raw content persisted any secret
    // the message body had just been scrubbed of.
    if (role === 'user') this.autoTitle(sessionId, stored);
    this.bus?.emit({
      type: 'message.created',
      sessionId,
      payload: { messageId: message.id, role, status: message.status },
    });
    return message;
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  /**
   * Update an in-flight assistant message. Only the message's own fields move;
   * a completed message is never rewritten by a later attempt.
   */
  /**
   * Anchor a Job to the message that asked for it.
   *
   * Creation can land later than the turn that requested it -- a Job the human
   * confirms is created by the approval, not by the chat reply -- so the link is
   * written when the Job actually exists rather than assumed at settle time.
   */
  linkMessageJob(messageId: string, jobId: string): void {
    this.db
      .prepare('UPDATE messages SET job_id = ? WHERE id = ? AND job_id IS NULL')
      .run(jobId, messageId);
  }

  updateMessage(
    id: string,
    patch: { content?: string; status?: MessageStatus; metadata?: MessageMetadata },
  ): Message | null {
    const existing = this.getMessage(id);
    if (!existing) return null;
    const redacted = patch.content === undefined ? null : redactSecrets(patch.content);
    const clipped = redacted !== null && redacted.length > MAX_MESSAGE_CHARS;
    const safe = redacted === null ? existing.content : redacted.slice(0, MAX_MESSAGE_CHARS);
    const status = patch.status ?? existing.status;
    const metadata = patch.metadata
      ? { ...existing.metadata, ...patch.metadata }
      : existing.metadata;
    this.db
      .prepare(
        'UPDATE messages SET content = ?, truncated = ?, status = ?, metadata = ? WHERE id = ?',
      )
      // A clipped streamed answer has to say so, exactly as a clipped incoming
      // message does; reporting `truncated: false` for cut content is a lie the
      // UI has no way to see through.
      .run(safe, clipped || existing.truncated ? 1 : 0, status, JSON.stringify(metadata), id);
    this.touch(existing.sessionId, nowIso());
    this.bus?.emit({
      type:
        status === 'complete'
          ? 'message.completed'
          : status === 'failed'
            ? 'message.failed'
            : 'message.delta',
      sessionId: existing.sessionId,
      payload: { messageId: id, status, chars: safe.length },
    });
    return this.getMessage(id);
  }

  /**
   * The most recent `limit` messages, oldest first.
   *
   * The tail, not the head: this used to take the FIRST rows, so a conversation
   * past the limit stopped showing anything new -- the UI rendered messages
   * 1..400 forever while answers were written past them -- and `edit last`
   * found its "last" user message in the middle of the transcript and deleted
   * around there.
   */
  messages(sessionId: string, limit = 200): Message[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(sessionId, limit) as Row[];
    return rows.map(rowToMessage).reverse();
  }

  /** The newest message in a conversation, whatever its role or status. */
  lastMessage(sessionId: string): Message | null {
    const row = this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  /** The most recent turns, oldest-first, for the bounded chat context pack. */
  recentMessages(sessionId: string, limit = 12): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND status IN ('complete','stopped')
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Row[];
    return rows.map(rowToMessage).reverse();
  }

  lastUserMessage(sessionId: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? AND role = 'user'
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  deleteMessage(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes) > 0;
  }

  /**
   * Crash recovery for responses.
   *
   * An assistant turn that was still being produced when the process died is
   * marked interrupted, never silently promoted to a completed answer.
   */
  recoverInterruptedMessages(): number {
    const stale = this.db
      .prepare(`SELECT id FROM messages WHERE status IN ('pending','streaming')`)
      .all() as Array<{ id: string }>;
    // Written directly rather than through updateMessage: that touches the
    // session, so every boot pushed each conversation holding an interrupted
    // answer to the top of the sidebar, ahead of genuinely newer ones.
    const metadata = JSON.stringify({
      error: 'Jarvis restarted while this response was being generated.',
    });
    for (const row of stale) {
      this.db
        .prepare("UPDATE messages SET status = 'interrupted', metadata = ? WHERE id = ?")
        .run(metadata, row.id);
    }
    return stale.length;
  }

  markConsolidated(id: string): void {
    const now = nowIso();
    this.db
      .prepare(`UPDATE sessions SET consolidated_at=?, updated_at=? WHERE id=?`)
      .run(now, now, id);
  }

  /** Configurable retention for the raw archive. 0 days = keep forever. */
  pruneHistory(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes);
  }

  private touch(sessionId: string, at: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at, sessionId);
  }

  private autoTitle(sessionId: string, text: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR trim(title) = '')`)
      .run(deriveConversationTitle(text), sessionId);
  }
}

export { SessionService as ConversationService };
