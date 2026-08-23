import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.js';
import { nowIso } from '../ids.js';

/**
 * Normalized Jarvis event types. Provider-specific shapes are translated into
 * these by the agent adapters so nothing downstream knows about Claude or Codex.
 */
export type JarvisEventType =
  | 'job.created'
  | 'job.stage.changed'
  | 'job.completed'
  | 'job.failed'
  | 'job.cancelled'
  | 'candidate.approved'
  | 'candidate.apply.started'
  | 'candidate.apply.completed'
  | 'candidate.apply.failed'
  | 'agent.started'
  | 'agent.output'
  | 'agent.thinking'
  | 'agent.tool.started'
  | 'agent.tool.completed'
  | 'agent.waiting'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.routing.decided'
  | 'agent.rate_limited'
  | 'verification.started'
  | 'verification.step'
  | 'verification.completed'
  | 'review.started'
  | 'review.completed'
  | 'visual_qa.started'
  | 'visual_qa.captured'
  | 'visual_qa.completed'
  | 'visual_review.started'
  | 'visual_review.completed'
  | 'visual_review.failed'
  | 'memory.candidate'
  | 'memory.stored'
  | 'memory.rejected'
  | 'memory.superseded'
  | 'memory.retrieved'
  | 'memory.deleted'
  | 'session.updated'
  | 'system.recovery';

export interface JarvisEvent {
  id?: number;
  type: JarvisEventType;
  jobId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

/**
 * Persist-then-emit event bus.
 *
 * Persisting first is what makes restart recovery possible: a subscriber that
 * missed an event can replay from the `events` table by id. Emission is
 * best-effort in-process fan-out for the live UI.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly db: Db) {
    this.emitter.setMaxListeners(0);
  }

  emit(event: JarvisEvent): JarvisEvent {
    const createdAt = event.createdAt ?? nowIso();
    const payload = JSON.stringify(event.payload ?? {});
    const info = this.db
      .prepare(
        `INSERT INTO events (type, job_id, session_id, run_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.type,
        event.jobId ?? null,
        event.sessionId ?? null,
        event.runId ?? null,
        payload,
        createdAt,
      );
    const stored: JarvisEvent = { ...event, id: Number(info.lastInsertRowid), createdAt };
    this.emitter.emit('event', stored);
    this.emitter.emit(event.type, stored);
    return stored;
  }

  on(listener: (event: JarvisEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  onType(type: JarvisEventType, listener: (event: JarvisEvent) => void): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }

  /** Replay persisted events, optionally after a cursor id. Used by SSE reconnects. */
  list(
    opts: { jobId?: string; sessionId?: string; afterId?: number; limit?: number } = {},
  ): JarvisEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.jobId) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.afterId !== undefined) {
      where.push('id > ?');
      params.push(opts.afterId);
    }
    const sql = `SELECT id, type, job_id, session_id, run_id, payload, created_at FROM events
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id ASC LIMIT ?`;
    params.push(opts.limit ?? 500);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      type: r.type as JarvisEventType,
      jobId: (r.job_id as string) ?? null,
      sessionId: (r.session_id as string) ?? null,
      runId: (r.run_id as string) ?? null,
      payload: JSON.parse((r.payload as string) || '{}') as Record<string, unknown>,
      createdAt: r.created_at as string,
    }));
  }
}
