import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from './index.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('migrates v1 to the current version without losing existing data', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-'));
    homes.push(home);
    const config = loadConfig({ home });
    const db = openDb(config);
    db.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_keep', 'preserved', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    db.prepare(
      `INSERT INTO memories (id, scope, kind, content, source_type, content_hash, created_at,
        updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('mem_keep', 'user', 'fact', 'survives migration', 'user_explicit', 'hash', 'now', 'now');
    db.close();

    const v1 = new DatabaseSync(config.dbPath);
    v1.exec(
      `DROP TABLE tool_grants;
       DROP TABLE tool_executions;
       DROP TABLE routing_decisions;
       DROP TABLE upgrade_transactions;
       DROP TABLE candidate_applications;
       UPDATE schema_meta SET value='1' WHERE key='schema_version';`,
    );
    v1.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: '3' });
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

  it('migrates v2 to v3 and keeps the jobs and memories already there', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-migration-v3-'));
    homes.push(home);
    const config = loadConfig({ home });
    const db = openDb(config);
    db.prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('prj_v2', 'kept', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    db.prepare(
      `INSERT INTO jobs (id, project_id, request, goal, stage, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('job_v2', 'prj_v2', 'do it', 'do it', 'awaiting_user', 'awaiting_user', 'now', 'now');
    db.close();

    const v2 = new DatabaseSync(config.dbPath);
    v2.exec(
      `DROP TABLE tool_grants;
       DROP TABLE tool_executions;
       UPDATE schema_meta SET value='2' WHERE key='schema_version';`,
    );
    v2.close();

    const migrated = openDb(config);
    expect(
      migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get(),
    ).toEqual({ value: '3' });
    expect(migrated.prepare("SELECT stage FROM jobs WHERE id='job_v2'").get()).toEqual({
      stage: 'awaiting_user',
    });
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM tool_executions').get()).toEqual({ n: 0 });
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
