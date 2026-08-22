import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

export type Db = DatabaseSync;

const SCHEMA_VERSION = '1';

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

  const current = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined;
  if (!current) {
    db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      SCHEMA_VERSION,
    );
  } else if (current.value !== SCHEMA_VERSION) {
    log.warn('schema version mismatch', { found: current.value, expected: SCHEMA_VERSION });
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
