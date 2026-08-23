import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { MIGRATIONS, openDb } from './index.js';

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
    ).toEqual({ value: '4' });
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

  it('migrates v2 to v4 and keeps the jobs and memories already there', () => {
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
    ).toEqual({ value: '4' });
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
      value: '4',
    });
    expect(migrated.prepare("SELECT content FROM memories WHERE id='mem_v3'").get()).toEqual({
      content: 'preserved v3 memory',
    });
    expect(
      migrated
        .prepare(
          "SELECT status,input_validated,definition_revision,input_hash FROM tool_executions WHERE id='tex_v3'",
        )
        .get(),
    ).toEqual({
      status: 'expired',
      input_validated: 0,
      definition_revision: null,
      input_hash: null,
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
    migrated.close();
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
