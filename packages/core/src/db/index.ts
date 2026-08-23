import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

export type Db = DatabaseSync;

const SCHEMA_VERSION = 2;

const MIGRATIONS = new Map<number, string>([
  [
    2,
    `CREATE TABLE candidate_applications (
      id                 TEXT PRIMARY KEY,
      job_id             TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status             TEXT NOT NULL,
      review_id          TEXT NOT NULL REFERENCES reviews(id),
      verification_cycle INTEGER NOT NULL,
      candidate_base     TEXT NOT NULL,
      candidate_head     TEXT NOT NULL,
      target_root        TEXT,
      target_branch      TEXT,
      target_head_before TEXT,
      target_head_after  TEXT,
      method             TEXT NOT NULL DEFAULT 'ff-only',
      failure            TEXT,
      approved_at        TEXT NOT NULL,
      started_at         TEXT,
      completed_at       TEXT,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX idx_candidate_applications_status ON candidate_applications(status, updated_at);

    CREATE TABLE upgrade_transactions (
      id                 TEXT PRIMARY KEY,
      job_id             TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      application_id     TEXT NOT NULL REFERENCES candidate_applications(id) ON DELETE CASCADE,
      status             TEXT NOT NULL,
      repository         TEXT NOT NULL,
      branch             TEXT NOT NULL,
      previous_sha       TEXT NOT NULL,
      candidate_sha      TEXT NOT NULL,
      rollback_ref       TEXT,
      activation_at      TEXT,
      healthcheck_result TEXT,
      rollback_sha       TEXT,
      failure            TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      completed_at       TEXT
    );
    CREATE INDEX idx_upgrade_transactions_job ON upgrade_transactions(job_id, created_at);
    CREATE INDEX idx_upgrade_transactions_status ON upgrade_transactions(status, updated_at);

    CREATE TABLE routing_decisions (
      id                    TEXT PRIMARY KEY,
      job_id                TEXT REFERENCES jobs(id) ON DELETE CASCADE,
      run_id                TEXT,
      role                  TEXT NOT NULL,
      provider              TEXT,
      model                 TEXT,
      reason                TEXT NOT NULL,
      avoid_provider        TEXT,
      explicit_preference   TEXT,
      provider_availability TEXT NOT NULL DEFAULT '[]',
      task_profile          TEXT,
      created_at            TEXT NOT NULL
    );
    CREATE INDEX idx_routing_decisions_job ON routing_decisions(job_id, created_at);`,
  ],
]);

function schemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from both src (tsx/strip-types) and dist (schema.sql copied by build).
  for (const candidate of [
    path.join(here, 'schema.sql'),
    path.join(here, '..', '..', 'src', 'db', 'schema.sql'),
  ]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error('schema.sql not found next to db/index.js');
}

/**
 * Open (and migrate) the Jarvis database.
 *
 * Failure here is fatal but explicit: callers surface it rather than silently
 * degrading to an in-memory database, which would lose durable memory.
 */
export function openDb(config: JarvisConfig = getConfig()): Db {
  if (config.dbPath !== ':memory:') {
    ensureDirs(config);
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(config.dbPath);

  // PRAGMAs must run outside the schema file: node:sqlite rejects some of them
  // inside a multi-statement exec on certain builds.
  db.exec('PRAGMA foreign_keys = ON');
  if (config.dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(schemaSql());

  let current = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as
    { value: string } | undefined;
  if (!current) {
    db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?)').run('schema_version', '1');
    current = { value: '1' };
  }

  const found = Number(current.value);
  if (
    !Number.isInteger(found) ||
    String(found) !== current.value ||
    found < 1 ||
    found > SCHEMA_VERSION
  ) {
    db.close();
    throw new Error(
      `unsupported database schema version ${current.value}; expected 1-${SCHEMA_VERSION}`,
    );
  }
  for (let version = found + 1; version <= SCHEMA_VERSION; version++) {
    const sql = MIGRATIONS.get(version);
    if (!sql) {
      db.close();
      throw new Error(`missing database migration for schema version ${version}`);
    }
    try {
      transaction(db, () => {
        db.exec(sql);
        db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(
          String(version),
          'schema_version',
        );
      });
      log.info('database migrated', { from: version - 1, to: version });
    } catch (error) {
      db.close();
      throw new Error(
        `database migration ${version - 1}->${version} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Restrict the DB file: it holds personal memory.
  if (config.dbPath !== ':memory:') {
    try {
      fs.chmodSync(config.dbPath, 0o600);
    } catch {
      /* no POSIX permissions on this platform */
    }
  }
  return db;
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
