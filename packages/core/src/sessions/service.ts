import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import { redactSecrets } from '../memory/secrets.js';

/**
 * Layer 1 — active working memory.
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

export interface Session {
  id: string;
  title: string | null;
  projectId: string | null;
  state: SessionState;
  status: 'active' | 'consolidated' | 'archived';
  createdAt: string;
  updatedAt: string;
  consolidatedAt: string | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  truncated: boolean;
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

/** Hard caps keep working memory small no matter how long a session runs. */
const LIMITS = { constraints: 8, decisions: 12, unresolved: 8, entities: 12, artifacts: 10 };

/** Raw history rows are archive, not context — cap what we store per message. */
const MAX_MESSAGE_CHARS = 8000;

type Row = Record<string, unknown>;

function rowToSession(row: Row): Session {
  return {
    id: row.id as string,
    title: (row.title as string) ?? null,
    projectId: (row.project_id as string) ?? null,
    state: { ...EMPTY_STATE, ...parseJson(row.state as string, {}) },
    status: row.status as Session['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    consolidatedAt: (row.consolidated_at as string) ?? null,
  };
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
      title: input.title ?? null,
      projectId: input.projectId ?? null,
      state: { ...EMPTY_STATE },
      status: 'active',
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
        session.status,
        now,
        now,
      );
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

  /** Most recent active session, or a fresh one. Keeps the UI single-session-simple. */
  current(): Session {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`)
      .get() as Row | undefined;
    return row ? rowToSession(row) : this.create();
  }

  setProject(id: string, projectId: string | null): Session | null {
    this.db
      .prepare('UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?')
      .run(projectId, nowIso(), id);
    return this.get(id);
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

  addMessage(sessionId: string, role: Message['role'], content: string): Message {
    const safe = redactSecrets(content);
    const truncated = safe.length > MAX_MESSAGE_CHARS;
    const stored = truncated ? `${safe.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]` : safe;
    const message: Message = {
      id: newId('msg'),
      sessionId,
      role,
      content: stored,
      truncated,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, session_id, role, content, truncated, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(message.id, sessionId, role, message.content, truncated ? 1 : 0, message.createdAt);
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(message.createdAt, sessionId);
    return message;
  }

  messages(sessionId: string, limit = 100): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(sessionId, limit) as Row[];
    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      truncated: Number(row.truncated) === 1,
      createdAt: row.created_at as string,
    }));
  }

  markConsolidated(id: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE sessions SET status='consolidated', consolidated_at=?, updated_at=? WHERE id=?`,
      )
      .run(now, now, id);
  }

  /** Configurable retention for the raw archive. 0 days = keep forever. */
  pruneHistory(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes);
  }
}
