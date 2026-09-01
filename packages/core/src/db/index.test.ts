import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { MIGRATIONS, SCHEMA_VERSION, openDb } from './index.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('migrates v1 to the current version without losing existing data', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-'));
    homes.push(home);
    const config = loadConfig({ home });
    const v1 = new DatabaseSync(config.dbPath);
    v1.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v1.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    v1.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_keep', 'preserved', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    v1.prepare(
      `INSERT INTO memories (id, scope, kind, content, source_type, content_hash, created_at,
        updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('mem_keep', 'user', 'fact', 'survives migration', 'user_explicit', 'hash', 'now', 'now');
    v1.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });
    expect(migrated.prepare("SELECT name FROM projects WHERE id='prj_keep'").get()).toEqual({
      name: 'preserved',
    });
    expect(migrated.prepare("SELECT content FROM memories WHERE id='mem_keep'").get()).toEqual({
      content: 'survives migration',
    });
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
             ('candidate_applications','upgrade_transactions','routing_decisions',
              'tool_executions','tool_grants') ORDER BY name`,
        )
        .all(),
    ).toHaveLength(5);
    migrated.close();
  });

  it('migrates v2 to v5 and keeps the jobs and memories already there', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-v3-'));
    homes.push(home);
    const config = loadConfig({ home });
    const v2 = new DatabaseSync(config.dbPath);
    v2.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v2.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    v2.exec(MIGRATIONS.get(2) as string);
    v2.prepare("UPDATE schema_meta SET value='2' WHERE key='schema_version'").run();
    v2.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_v2', 'kept', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    v2.prepare(
      `INSERT INTO jobs (id, project_id, request, goal, stage, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('job_v2', 'prj_v2', 'do it', 'do it', 'awaiting_user', 'awaiting_user', 'now', 'now');
    v2.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });
    expect(migrated.prepare("SELECT stage FROM jobs WHERE id='job_v2'").get()).toEqual({
      stage: 'awaiting_user',
    });
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM tool_executions').get()).toEqual({ n: 0 });
    migrated.close();
  });

  it('migrates populated v3 state and expires unverifiable pending approvals', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-v3-'));
    homes.push(home);
    const config = loadConfig({ home });
    fs.mkdirSync(home, { recursive: true });
    const legacy = new DatabaseSync(config.dbPath);
    legacy.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    legacy.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    legacy.exec(MIGRATIONS.get(2) as string);
    legacy.exec(MIGRATIONS.get(3) as string);
    legacy.prepare("UPDATE schema_meta SET value='3' WHERE key='schema_version'").run();
    legacy
      .prepare(
        `INSERT INTO projects (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('prj_v3', 'v3', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    legacy
      .prepare(
        `INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('job_v3', 'prj_v3', 'keep', 'keep', 'awaiting_user', 'awaiting_user', 'now', 'now');
    legacy
      .prepare(
        `INSERT INTO memories (id,scope,kind,content,source_type,content_hash,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('mem_v3', 'project', 'fact', 'preserved v3 memory', 'test', 'v3hash', 'now', 'now');
    legacy
      .prepare(
        `INSERT INTO tool_executions
          (id,tool_name,risk,actor,decision,status,reason,input,requested_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'tex_v3',
        'legacy.sensitive',
        'sensitive',
        'user',
        'confirm',
        'pending_approval',
        'sensitive needs your confirmation',
        '{}',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    legacy
      .prepare(
        `INSERT INTO agent_runs (id,job_id,provider,role,cwd,status,started_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('run_v3', 'job_v3', 'claude', 'reviewer', home, 'completed', 'now');
    legacy
      .prepare(
        `INSERT INTO reviews (id,job_id,run_id,provider,verdict,summary,findings,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('rev_v3', 'job_v3', 'run_v3', 'claude', 'approve', 'kept', '[]', 'now');
    legacy
      .prepare(
        `INSERT INTO verifications
          (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('ver_v3', 'job_v3', 0, 'test', 'test', home, 0, 'passed', '', 1, 'now');
    legacy
      .prepare(
        `INSERT INTO visual_qa
          (id,job_id,project_id,route,viewport,status,console_errors,network_failures,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('shot_v3', 'job_v3', 'prj_v3', '/', 'desktop', 'captured', '[]', '[]', 'now');
    legacy
      .prepare(
        `INSERT INTO tool_grants
          (id,tool_name,actor,created_at) VALUES (?,?,?,?)`,
      )
      .run('grant_v3', 'legacy.sensitive', 'user', 'now');
    legacy.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({
      value: String(SCHEMA_VERSION),
    });
    expect(migrated.prepare("SELECT content FROM memories WHERE id='mem_v3'").get()).toEqual({
      content: 'preserved v3 memory',
    });
    expect(
      migrated
        .prepare(
          "SELECT status,input_validated,definition_revision,input_hash,originating_actor,reason_code FROM tool_executions WHERE id='tex_v3'",
        )
        .get(),
    ).toEqual({
      status: 'expired',
      input_validated: 0,
      definition_revision: null,
      input_hash: null,
      originating_actor: 'user',
      reason_code: 'legacy',
    });
    for (const [table, id] of [
      ['agent_runs', 'run_v3'],
      ['reviews', 'rev_v3'],
      ['verifications', 'ver_v3'],
      ['visual_qa', 'shot_v3'],
      ['tool_grants', 'grant_v3'],
    ]) {
      expect(migrated.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id=?`).get(id)).toEqual({
        n: 1,
      });
    }
    expect(
      migrated
        .prepare("SELECT revoked_at,risk,definition_revision FROM tool_grants WHERE id='grant_v3'")
        .get(),
    ).toEqual({ revoked_at: 'now', risk: null, definition_revision: null });
    migrated.close();
  });

  it('migrates realistic populated v4 state and revokes legacy grants without integrity metadata', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-v4-'));
    homes.push(home);
    const config = loadConfig({ home });
    fs.mkdirSync(home, { recursive: true });
    const v4 = new DatabaseSync(config.dbPath);
    v4.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v4.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    for (const version of [2, 3, 4]) v4.exec(MIGRATIONS.get(version) as string);
    v4.prepare("UPDATE schema_meta SET value='4' WHERE key='schema_version'").run();
    v4.prepare(
      `INSERT INTO projects (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_v4', 'v4', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    v4.prepare(
      `INSERT INTO jobs (id,project_id,request,goal,stage,status,head_ref,reviewed_head,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'job_v4',
      'prj_v4',
      'keep',
      'keep',
      'awaiting_user',
      'awaiting_user',
      'abc',
      'abc',
      'now',
      'now',
    );
    v4.prepare(
      `INSERT INTO tool_grants (id,tool_name,actor,project_id,note,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('grant_v4', 'calendar.write', 'user', 'prj_v4', 'legacy permission', 'now');
    v4.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({
      value: String(SCHEMA_VERSION),
    });
    expect(
      migrated.prepare("SELECT stage,head_ref,reviewed_head FROM jobs WHERE id='job_v4'").get(),
    ).toEqual({
      stage: 'awaiting_user',
      head_ref: 'abc',
      reviewed_head: 'abc',
    });
    expect(
      migrated
        .prepare("SELECT revoked_at,risk,definition_revision FROM tool_grants WHERE id='grant_v4'")
        .get(),
    ).toEqual({
      revoked_at: 'now',
      risk: null,
      definition_revision: null,
    });
    migrated.close();
  });

  it('adds project analysis columns to a v8 database without disturbing its projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-'));
    homes.push(home);
    const config = loadConfig({ home });
    const v8 = new DatabaseSync(config.dbPath);
    v8.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v8.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    for (const version of [2, 3, 4, 5, 6, 7, 8]) v8.exec(MIGRATIONS.get(version) as string);
    v8.prepare("UPDATE schema_meta SET value='8' WHERE key='schema_version'").run();
    v8.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        aliases, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_old', 'legacy', home, 'main', '{}', '{}', 0, '["old"]', '{}', 'now', 'now');
    v8.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });
    // The project survives, and reads back as "never analysed" — which is what
    // it is, rather than an error.
    expect(
      migrated.prepare("SELECT name, profile, analysis FROM projects WHERE id='prj_old'").get(),
    ).toEqual({ name: 'legacy', profile: null, analysis: null });
    migrated.close();
  });

  it('keeps every Job when a v9 database already holds a duplicate origin link', () => {
    // Migration 10 adds a unique index over `origin_message_id`. A database
    // written before it could hold two Jobs for one chat message — that is the
    // bug the index exists to make impossible — and a unique index cannot be
    // built over them. The migration detaches the later LINK, never the Job:
    // both worktrees, both histories and both rows survive, because the
    // alternative is a migration that throws and leaves the database unopenable.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-'));
    homes.push(home);
    const config = loadConfig({ home });
    const v9 = new DatabaseSync(config.dbPath);
    v9.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v9.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    for (const version of [2, 3, 4, 5, 6, 7, 8, 9]) v9.exec(MIGRATIONS.get(version) as string);
    v9.prepare("UPDATE schema_meta SET value='9' WHERE key='schema_version'").run();
    v9.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        aliases, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_x', 'legacy', home, 'main', '{}', '{}', 0, '[]', '{}', 'now', 'now');
    const job = v9.prepare(
      `INSERT INTO jobs (id, project_id, request, goal, acceptance, stage, status,
        fix_cycles, review_fix_cycles, visual_fix_cycles, validation_only,
        origin_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const id of ['job_first', 'job_duplicate', 'job_unrelated']) {
      job.run(
        id,
        'prj_x',
        'fix the login bug',
        'fix the login bug',
        '[]',
        'queued',
        'pending',
        0,
        0,
        0,
        0,
        id === 'job_unrelated' ? null : 'msg_one',
        'now',
        'now',
      );
    }
    v9.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });
    // All three Jobs are still there.
    expect(migrated.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 3 });
    // The first keeps the link; the later duplicate loses only the link.
    expect(
      migrated
        .prepare('SELECT id FROM jobs WHERE origin_message_id = ? ORDER BY id')
        .all('msg_one'),
    ).toEqual([{ id: 'job_first' }]);
    // And the index is live, so the state it just cleaned up cannot come back.
    expect(() =>
      migrated
        .prepare('UPDATE jobs SET origin_message_id = ? WHERE id = ?')
        .run('msg_one', 'job_duplicate'),
    ).toThrow(/UNIQUE|constraint/i);
    migrated.close();
  });

  it('converges a fresh database and a migrated one on the same projects columns', () => {
    const columns = (config: ReturnType<typeof loadConfig>) => {
      const db = openDb(config);
      const names = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[])
        .map((row) => row.name)
        .sort();
      db.close();
      return names;
    };

    const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fresh-'));
    homes.push(freshHome);
    const fresh = columns(loadConfig({ home: freshHome }));

    const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-legacy-'));
    homes.push(legacyHome);
    const legacyConfig = loadConfig({ home: legacyHome });
    const v1 = new DatabaseSync(legacyConfig.dbPath);
    v1.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
    v1.prepare('INSERT INTO schema_meta(key,value) VALUES (?,?)').run('schema_version', '1');
    v1.close();

    expect(columns(legacyConfig)).toEqual(fresh);
    expect(fresh).toContain('profile');
    expect(fresh).toContain('analysis');
  });

  it('fails closed on a newer unknown schema', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-future-'));
    homes.push(home);
    const config = loadConfig({ home });
    openDb(config).close();
    const future = new DatabaseSync(config.dbPath);
    future.prepare("UPDATE schema_meta SET value='99' WHERE key='schema_version'").run();
    future.close();
    expect(() => openDb(config)).toThrow('unsupported database schema version 99');
  });
});
