import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 11;

/**
 * A LIKE pattern for a term a human typed.
 *
 * `%` and `_` are wildcards in LIKE, so searching for "100%" or "a_b" silently
 * matched far more than was asked. The values were always parameterised, so
 * this is a matching bug rather than an injection one. `~` is the escape
 * character because it needs no escaping in a TypeScript string or in SQL.
 */
export const LIKE_ESCAPE = '~';
export const likeTerm = (value: string): string =>
  `%${value.replace(/[~%_]/g, (char) => LIKE_ESCAPE + char)}%`;

export const MIGRATIONS = new Map<number, string>([
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
  [
    3,
    `CREATE TABLE tool_executions (
      id           TEXT PRIMARY KEY,
      tool_name    TEXT NOT NULL,
      risk         TEXT NOT NULL,
      actor        TEXT NOT NULL,
      decision     TEXT NOT NULL,
      status       TEXT NOT NULL,
      reason       TEXT NOT NULL DEFAULT '',
      session_id   TEXT,
      project_id   TEXT,
      job_id       TEXT,
      agent_run_id TEXT,
      input        TEXT,
      result       TEXT,
      error        TEXT,
      grant_id     TEXT,
      approved_by  TEXT,
      requested_at TEXT NOT NULL,
      started_at   TEXT,
      finished_at  TEXT,
      duration_ms  INTEGER,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX idx_tool_executions_status ON tool_executions(status, requested_at DESC);
    CREATE INDEX idx_tool_executions_tool ON tool_executions(tool_name, requested_at DESC);
    CREATE INDEX idx_tool_executions_job ON tool_executions(job_id, requested_at DESC);

    CREATE TABLE tool_grants (
      id         TEXT PRIMARY KEY,
      tool_name  TEXT NOT NULL,
      actor      TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      note       TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX idx_tool_grants_lookup ON tool_grants(tool_name, actor, revoked_at);`,
  ],
  [
    4,
    `ALTER TABLE tool_executions ADD COLUMN definition_revision TEXT;
    ALTER TABLE tool_executions ADD COLUMN input_hash TEXT;
    ALTER TABLE tool_executions ADD COLUMN input_validated INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tool_executions ADD COLUMN parent_execution_id TEXT REFERENCES tool_executions(id);
    UPDATE tool_executions
      SET status='expired', error='approval predates canonical input integrity metadata; create a new request',
          finished_at=updated_at
      WHERE status='pending_approval';

    ALTER TABLE jobs ADD COLUMN resume_stage TEXT;
    ALTER TABLE jobs ADD COLUMN pause_reason TEXT;
    ALTER TABLE jobs ADD COLUMN review_fix_cycles INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN visual_fix_cycles INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN last_provider TEXT;
    ALTER TABLE jobs ADD COLUMN resume_session_id TEXT;
    ALTER TABLE jobs ADD COLUMN reviewed_head TEXT;
    ALTER TABLE jobs ADD COLUMN visual_head TEXT;
    ALTER TABLE jobs ADD COLUMN candidate_base_sha TEXT;
    ALTER TABLE jobs ADD COLUMN candidate_source_sha TEXT;
    ALTER TABLE jobs ADD COLUMN validation_only INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN visual_qa_config TEXT;

    ALTER TABLE reviews ADD COLUMN head_ref TEXT;
    ALTER TABLE reviews ADD COLUMN blocking INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE visual_qa ADD COLUMN scenario_name TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE visual_qa ADD COLUMN head_ref TEXT;
    ALTER TABLE visual_qa ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE verifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'check';
    ALTER TABLE verifications ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX idx_tool_executions_parent ON tool_executions(parent_execution_id);
    CREATE INDEX idx_reviews_head ON reviews(job_id, head_ref);
    CREATE INDEX idx_visualqa_head ON visual_qa(job_id, head_ref);`,
  ],
  [
    5,
    `ALTER TABLE tool_grants ADD COLUMN risk TEXT;
    ALTER TABLE tool_grants ADD COLUMN definition_revision TEXT;
    UPDATE tool_grants SET revoked_at=COALESCE(revoked_at, created_at)
      WHERE risk IS NULL OR definition_revision IS NULL;

    ALTER TABLE verifications ADD COLUMN failure_kind TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE jobs ADD COLUMN repair_kind TEXT;
    ALTER TABLE jobs ADD COLUMN repair_checkpoint TEXT;
    ALTER TABLE jobs ADD COLUMN restart_reason TEXT;

    CREATE TABLE human_control (
      id              TEXT PRIMARY KEY CHECK (id = 'primary'),
      credential_hash TEXT,
      paired_at       TEXT,
      updated_at      TEXT NOT NULL
    );`,
  ],
  [6, `ALTER TABLE jobs ADD COLUMN visual_qa_plan TEXT;`],
  [
    7,
    // Conversations. The `sessions`/`messages` tables stay in place on purpose:
    // renaming them would rewrite every existing row and every foreign key for
    // an aesthetic gain, and the product-level name is what actually matters.
    `ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN archived_at TEXT;
    ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
    ALTER TABLE messages ADD COLUMN job_id TEXT;
    ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';

    ALTER TABLE projects ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN archived_at TEXT;

    ALTER TABLE jobs ADD COLUMN archived_at TEXT;
    ALTER TABLE jobs ADD COLUMN predecessor_job_id TEXT;
    ALTER TABLE jobs ADD COLUMN origin_message_id TEXT;

    -- Every pre-existing session becomes a named conversation. Deterministic and
    -- local: the first user message is the title, exactly as a new one is named.
    UPDATE sessions SET title = (
      SELECT substr(trim(replace(replace(m.content, char(10), ' '), char(13), ' ')), 1, 60)
        FROM messages m
        WHERE m.session_id = sessions.id AND m.role = 'user' AND trim(m.content) <> ''
        ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1
    ) WHERE title IS NULL OR trim(title) = '';
    UPDATE sessions SET status = 'active' WHERE status NOT IN ('active','archived');

    -- A deleted Job leaves a readable trace so a conversation card that still
    -- references it renders a tombstone instead of breaking.
    CREATE TABLE job_tombstones (
      id         TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      goal       TEXT NOT NULL,
      reason     TEXT NOT NULL DEFAULT '',
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX idx_job_tombstones_session ON job_tombstones(session_id);

    CREATE INDEX idx_sessions_activity ON sessions(status, updated_at DESC);
    CREATE INDEX idx_jobs_session ON jobs(session_id, created_at DESC);`,
  ],
  [
    8,
    `ALTER TABLE tool_executions ADD COLUMN originating_actor TEXT;
    ALTER TABLE tool_executions ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'legacy';
    UPDATE tool_executions SET originating_actor=actor WHERE originating_actor IS NULL;`,
  ],
  [
    9,
    // Project analysis. Two additive columns and nothing else: existing rows
    // read back as "never analysed", which is exactly what they are.
    // `profile` holds the bounded structured result plus its analysedCommit;
    // `analysis` holds only the transient run state, so a failed run can never
    // damage the last good profile.
    `ALTER TABLE projects ADD COLUMN profile TEXT;
    ALTER TABLE projects ADD COLUMN analysis TEXT;`,
  ],
  [
    10,
    // ONE JOB PER CHAT MESSAGE, enforced by the database rather than by whoever
    // happens to call `create`.
    //
    // Retry accepts an interrupted message and crash recovery marks one
    // interrupted on restart, so a crash between creating a Job and settling the
    // assistant row left a Retry button that would route the same sentence again
    // and open a second worktree. `JobService.create` now returns the Job an
    // origin message already has; this index is what makes that a guarantee
    // instead of a check two concurrent writers can both pass.
    //
    // Existing rows are preserved. A duplicate can only have come from the bug
    // above, and detaching the later link keeps the Job, its worktree and its
    // history intact -- the alternative, a migration that fails on a unique
    // violation, would leave the database unopenable.
    `UPDATE jobs SET origin_message_id = NULL
      WHERE origin_message_id IS NOT NULL
        AND rowid NOT IN (
          SELECT min(rowid) FROM jobs
           WHERE origin_message_id IS NOT NULL
           GROUP BY origin_message_id
        );

    CREATE UNIQUE INDEX IF NOT EXISTS jobs_origin_message
      ON jobs(origin_message_id) WHERE origin_message_id IS NOT NULL;`,
  ],
  [
    11,
    // Interactive Visual QA outcome, recorded per Job.
    //
    // Additive and nullable: every existing Job keeps its evidence, its plan and
    // its history, and reads back as NULL, which the approval path treats
    // exactly as it did before this column existed.
    `ALTER TABLE jobs ADD COLUMN visual_qa_status TEXT;`,
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
