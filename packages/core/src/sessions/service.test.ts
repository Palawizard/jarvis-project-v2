import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { EventBus } from '../events/bus.js';
import { MIGRATIONS, openDb, type Db } from '../db/index.js';
import { SessionService, deriveConversationTitle } from './service.js';

const homes: string[] = [];
const open: Db[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by a restart assertion.
    }
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversations-'));
  homes.push(home);
  const config = loadConfig({ home });
  const db = openDb(config);
  open.push(db);
  return { config, db, sessions: new SessionService(db, new EventBus(db)) };
}

describe('conversation lifecycle', () => {
  it('creates, lists, renames, pins and archives a conversation', () => {
    const { sessions } = fresh();
    const conversation = sessions.create();
    expect(sessions.get(conversation.id)?.status).toBe('active');

    sessions.addMessage(conversation.id, 'user', 'How does DNSSEC actually work?');
    // Named deterministically from the first useful user message — no model call.
    expect(sessions.get(conversation.id)?.title).toBe('How does DNSSEC actually work?');

    sessions.rename(conversation.id, 'DNS notes');
    expect(sessions.get(conversation.id)?.title).toBe('DNS notes');

    sessions.setPinned(conversation.id, true);
    expect(sessions.get(conversation.id)?.pinned).toBe(true);

    sessions.setArchived(conversation.id, true);
    expect(sessions.get(conversation.id)?.status).toBe('archived');
    expect(sessions.conversations({ status: 'active' })).toHaveLength(0);
    expect(sessions.conversations({ status: 'archived' })).toHaveLength(1);

    sessions.setArchived(conversation.id, false);
    expect(sessions.conversations({ status: 'active' })).toHaveLength(1);
  });

  it('sorts pinned first, then by activity, with a preview for the sidebar', () => {
    const { sessions } = fresh();
    const first = sessions.create({ title: 'first' });
    const second = sessions.create({ title: 'second' });
    sessions.addMessage(first.id, 'user', 'older');
    sessions.addMessage(second.id, 'user', 'newer message here');

    expect(sessions.conversations().map((c) => c.id)).toEqual([second.id, first.id]);
    expect(sessions.conversations()[0]?.preview).toBe('newer message here');
    expect(sessions.conversations()[0]?.messageCount).toBe(1);

    sessions.setPinned(first.id, true);
    expect(sessions.conversations().map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('searches conversations by title and by transcript content', () => {
    const { sessions } = fresh();
    const supervisor = sessions.create({ title: 'Supervisor design' });
    const other = sessions.create({ title: 'Unrelated' });
    sessions.addMessage(other.id, 'user', 'talking about the launcher instead');

    expect(sessions.conversations({ search: 'supervisor' }).map((c) => c.id)).toEqual([
      supervisor.id,
    ]);
    expect(sessions.conversations({ search: 'launcher' }).map((c) => c.id)).toEqual([other.id]);
    expect(sessions.conversations({ search: 'nothing at all' })).toEqual([]);
  });

  it('gives every new conversation its own fresh working state', () => {
    const { sessions } = fresh();
    const first = sessions.create();
    sessions.updateState(first.id, { goal: 'ship the launcher fix' });
    const second = sessions.create();

    expect(sessions.get(first.id)?.state.goal).toBe('ship the launcher fix');
    expect(sessions.get(second.id)?.state.goal).toBeFalsy();
  });
});

describe('conversation deletion semantics', () => {
  it('removes the transcript and working state but never Jobs or durable memory', () => {
    const { db, sessions } = fresh();
    const conversation = sessions.create({ title: 'doomed' });
    sessions.addMessage(conversation.id, 'user', 'make me a job');

    db.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_1', 'demo', '/tmp/demo', 'main', '{}', '{}', 0, '{}', 'now', 'now');
    db.prepare(
      `INSERT INTO jobs (id, session_id, project_id, request, goal, acceptance, stage, status,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('job_1', conversation.id, 'prj_1', 'req', 'goal', '[]', 'planning', 'running', 'n', 'n');
    // Layer 1 (conversation working state) vs layer 3/4 (durable memory).
    db.prepare(
      `INSERT INTO memories (id, scope, scope_id, kind, content, source_type, content_hash,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('mem_session', 'session', conversation.id, 'fact', 'scratch', 'agent', 'h1', 'n', 'n');
    db.prepare(
      `INSERT INTO memories (id, scope, kind, content, source_type, content_hash,
        created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('mem_user', 'user', 'fact', 'I prefer pnpm', 'user_explicit', 'h2', 'now', 'now');

    const result = sessions.delete(conversation.id);
    expect(result).toEqual({ deleted: true, messages: 1, detachedJobs: 1 });
    expect(sessions.get(conversation.id)).toBeNull();
    expect(sessions.messages(conversation.id)).toEqual([]);
    expect(db.prepare("SELECT id FROM memories WHERE id='mem_session'").get()).toBeUndefined();

    // The Job and the durable memory both survive; only the link is cleared, so
    // no audit trail can be erased by tidying up a chat.
    const job = db.prepare("SELECT session_id FROM jobs WHERE id='job_1'").get();
    expect(job).toEqual({ session_id: null });
    expect(db.prepare("SELECT content FROM memories WHERE id='mem_user'").get()).toEqual({
      content: 'I prefer pnpm',
    });
  });

  it('reports nothing deleted for an unknown conversation', () => {
    const { sessions } = fresh();
    expect(sessions.delete('ses_missing')).toEqual({
      deleted: false,
      messages: 0,
      detachedJobs: 0,
    });
  });
});

describe('transcript persistence and response recovery', () => {
  it('keeps conversations and transcripts across a restart', () => {
    const { config, db, sessions } = fresh();
    const conversation = sessions.create({ title: 'persisted' });
    sessions.addMessage(conversation.id, 'user', 'first question');
    sessions.addMessage(conversation.id, 'assistant', 'first answer');
    db.close();

    const reopened = openDb(config);
    open.push(reopened);
    const after = new SessionService(reopened);
    expect(after.get(conversation.id)?.title).toBe('persisted');
    expect(after.messages(conversation.id).map((m) => m.content)).toEqual([
      'first question',
      'first answer',
    ]);
  });

  it('reports a blank rename as no rename at all', () => {
    const { sessions } = fresh();
    const conversation = sessions.create({ title: 'Original' });
    expect(sessions.rename(conversation.id, '   ')).toBeNull();
    expect(sessions.get(conversation.id)?.title).toBe('Original');
  });

  it('recovers interrupted responses without reordering the sidebar', () => {
    const { sessions } = fresh();
    const older = sessions.create({ title: 'older' });
    sessions.addMessage(older.id, 'assistant', 'half an ans', { status: 'streaming' });
    const newer = sessions.create({ title: 'newer' });
    sessions.addMessage(newer.id, 'user', 'a finished question');
    const orderBefore = sessions.conversations({}).map((entry) => entry.id);

    expect(sessions.recoverInterruptedMessages()).toBe(1);

    expect(sessions.conversations({}).map((entry) => entry.id)).toEqual(orderBefore);
  });

  it('derives the title from redacted text, never the raw message', () => {
    // The title is durable and is rendered in the sidebar, returned by the
    // conversations API, indexed by search and copied into event payloads, so a
    // title built from raw content persists exactly what the body just scrubbed.
    const { sessions } = fresh();
    const conversation = sessions.create();
    const secret = `ghp_${'A'.repeat(36)}`;
    const message = sessions.addMessage(conversation.id, 'user', `${secret} is failing, why?`);

    expect(message.content).not.toContain(secret);
    expect(sessions.get(conversation.id)?.title ?? '').not.toContain(secret);
  });

  it('reads the newest messages once a conversation is longer than the window', () => {
    // `messages()` used to take the FIRST rows, so past the limit the UI
    // rendered a frozen prefix while every new answer was written beyond it,
    // and "edit last" found its last user message mid-transcript.
    const { sessions } = fresh();
    const conversation = sessions.create();
    for (let index = 0; index < 12; index++) {
      sessions.addMessage(conversation.id, 'user', `question ${index}`);
    }

    const window = sessions.messages(conversation.id, 5);
    expect(window.map((message) => message.content)).toEqual([
      'question 7',
      'question 8',
      'question 9',
      'question 10',
      'question 11',
    ]);
    expect(sessions.lastMessage(conversation.id)?.content).toBe('question 11');
    expect(sessions.lastUserMessage(conversation.id)?.content).toBe('question 11');
  });

  it('marks an in-flight response interrupted instead of faking completion', () => {
    const { config, db, sessions } = fresh();
    const conversation = sessions.create();
    const done = sessions.addMessage(conversation.id, 'assistant', 'finished answer');
    const inFlight = sessions.addMessage(conversation.id, 'assistant', 'half an ans', {
      status: 'streaming',
      metadata: { executionId: 'tex_interrupted' },
    });
    db.close();

    const reopened = openDb(config);
    open.push(reopened);
    const after = new SessionService(reopened);
    expect(after.recoverInterruptedMessages()).toBe(1);

    // What actually arrived is kept, labelled honestly.
    const recovered = after.getMessage(inFlight.id);
    expect(recovered?.status).toBe('interrupted');
    expect(recovered?.content).toBe('half an ans');
    expect(recovered?.metadata.executionId).toBe('tex_interrupted');
    expect(after.getMessage(done.id)?.status).toBe('complete');
    // An interrupted turn never re-enters the model's context as a real answer.
    expect(after.recentMessages(conversation.id).map((m) => m.id)).toEqual([done.id]);
  });

  it('stores Markdown as inert data, and redacts secrets from the transcript', () => {
    const { sessions } = fresh();
    const conversation = sessions.create();
    const markdown = '# Title\n\n<img src=x onerror=alert(1)>\n\n```js\nconst a = 1;\n```';
    const stored = sessions.addMessage(conversation.id, 'assistant', markdown);
    // Content is persisted verbatim: it is data. Escaping is the renderer's job,
    // and the renderer never injects raw HTML.
    expect(stored.content).toBe(markdown);

    const secret = sessions.addMessage(
      conversation.id,
      'user',
      'my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(secret.content).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('deriveConversationTitle', () => {
  it('names a conversation from the first useful message without a model call', () => {
    expect(deriveConversationTitle('  Explain   DNSSEC\nplease  ')).toBe('Explain DNSSEC please');
    expect(deriveConversationTitle('```js\ncode only\n```')).toBe('New conversation');
    expect(deriveConversationTitle('')).toBe('New conversation');
    const long = deriveConversationTitle('x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('existing sessions migrate into conversations', () => {
  it('titles pre-migration sessions from their transcript and keeps job links', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conv-migration-'));
    homes.push(home);
    const config = loadConfig({ home });

    const before = new DatabaseSync(config.dbPath);
    before.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf8'));
    for (const version of [2, 3, 4, 5, 6]) before.exec(MIGRATIONS.get(version) as string);
    before.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '6');
    before
      .prepare(
        'INSERT INTO sessions (id, state, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      )
      .run('ses_old', '{}', 'active', '2026-01-01', '2026-01-01');
    before
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?,?,?,?,?)`,
      )
      .run('msg_old', 'ses_old', 'user', 'Why did the launcher exit with code 1?', '2026-01-01');
    before
      .prepare(
        `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
          config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('prj_old', 'legacy', home, 'main', '{}', '{}', 0, '{}', '2026-01-01', '2026-01-01');
    before
      .prepare(
        `INSERT INTO jobs (id, session_id, project_id, request, goal, acceptance, stage, status,
          created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('job_old', 'ses_old', 'prj_old', 'r', 'g', '[]', 'done', 'completed', '2026-01-01', 'x');
    before.close();

    const db = openDb(config);
    open.push(db);
    const sessions = new SessionService(db);

    // The stored conversation survives, gains a name, and stays active.
    const migrated = sessions.get('ses_old');
    expect(migrated?.title).toBe('Why did the launcher exit with code 1?');
    expect(migrated?.status).toBe('active');
    expect(migrated?.pinned).toBe(false);
    expect(sessions.messages('ses_old')).toHaveLength(1);
    expect(sessions.messages('ses_old')[0]?.status).toBe('complete');

    // And the existing Job stays linked to it.
    const summary = sessions.conversations().find((c) => c.id === 'ses_old');
    expect(summary?.jobIds).toEqual(['job_old']);
  });
});
