-- Jarvis local-first schema. SQLite dialect kept deliberately portable so the
-- product domain can migrate to PostgreSQL without a rewrite:
--   * no SQLite-only column types (TEXT/INTEGER/REAL only)
--   * JSON payloads stored as TEXT, parsed in the repository layer
--   * timestamps are ISO-8601 TEXT (UTC), not SQLite julian/unix helpers
-- The ONLY SQLite-specific pieces are the FTS5 index and the embedding BLOBs,
-- both of which live behind the retrieval interface (swap for tsvector/pgvector).
--
-- This file is the version-1 baseline and is re-executed (IF NOT EXISTS) on every
-- open. Tables added later belong in MIGRATIONS in db/index.ts and nowhere else,
-- or the migration would try to create a table this file just made.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- projects --
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  root_path      TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  stack          TEXT NOT NULL DEFAULT '{}',
  commands       TEXT NOT NULL DEFAULT '{}',
  dev_url        TEXT,
  summary        TEXT,
  is_self        INTEGER NOT NULL DEFAULT 0,
  config         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------- sessions --
-- A Jarvis interaction session. `state` is Layer 1 working memory: compact and
-- structured, NEVER a transcript.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  state           TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  consolidated_at TEXT
);

-- Layer 6: raw history archive. Not context by default.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- -------------------------------------------------------------------- jobs --
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request       TEXT NOT NULL,
  goal          TEXT NOT NULL,
  acceptance    TEXT NOT NULL DEFAULT '[]',
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT,
  branch        TEXT,
  worktree_path TEXT,
  base_ref      TEXT,
  head_ref      TEXT,
  fix_cycles    INTEGER NOT NULL DEFAULT 0,
  episode_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Append-only normalized event log. Powers live UI, restart recovery and audit.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  job_id     TEXT,
  session_id TEXT,
  run_id     TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);

-- --------------------------------------------------------------- agent runs --
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  model               TEXT,
  role                TEXT NOT NULL,
  external_session_id TEXT,
  cwd                 TEXT NOT NULL,
  status              TEXT NOT NULL,
  pid                 INTEGER,
  result              TEXT,
  error               TEXT,
  usage               TEXT NOT NULL DEFAULT '{}',
  context_pack_id     TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON agent_runs(job_id, started_at);

-- ------------------------------------------------------------ verification --
CREATE TABLE IF NOT EXISTS verifications (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cycle       INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  command     TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  exit_code   INTEGER,
  status      TEXT NOT NULL,
  output      TEXT NOT NULL DEFAULT '',
  output_path TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_job ON verifications(job_id, cycle);

-- ------------------------------------------------------------------ review --
CREATE TABLE IF NOT EXISTS reviews (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id     TEXT,
  provider   TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  findings   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_job ON reviews(job_id);

-- --------------------------------------------------------------- visual QA --
CREATE TABLE IF NOT EXISTS visual_qa (
  id                TEXT PRIMARY KEY,
  job_id            TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  route             TEXT NOT NULL,
  viewport          TEXT NOT NULL,
  screenshot_path   TEXT,
  console_errors    TEXT NOT NULL DEFAULT '[]',
  network_failures  TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL,
  error             TEXT,
  reviewed_by       TEXT,
  review_findings   TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visualqa_job ON visual_qa(job_id);

-- ------------------------------------------------------------------ memory --
-- One table for every durable memory layer. `scope` + `kind` separate them.
-- Layers 2/3/4/5 (user, project, episode, procedure) all live here so retrieval,
-- supersession and provenance have a single implementation.
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  scope_id       TEXT,
  kind           TEXT NOT NULL,
  subject        TEXT,
  content        TEXT NOT NULL,
  importance     REAL NOT NULL DEFAULT 0.5,
  confidence     REAL NOT NULL DEFAULT 0.7,
  source_type    TEXT NOT NULL,
  source_ref     TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active',
  supersedes     TEXT,
  superseded_by  TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  sensitivity    TEXT NOT NULL DEFAULT 'normal',
  content_hash   TEXT NOT NULL,
  metadata       TEXT NOT NULL DEFAULT '{}',
  valid_from     TEXT,
  valid_until    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(scope, scope_id, subject, status);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, status);

-- Lexical index (BM25). External-content FTS5 kept in sync by triggers so there
-- is exactly one copy of the text.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  subject, content,
  content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, subject, content) VALUES (new.rowid, new.subject, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content)
    VALUES ('delete', old.rowid, old.subject, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content)
    VALUES ('delete', old.rowid, old.subject, old.content);
  INSERT INTO memories_fts(rowid, subject, content) VALUES (new.rowid, new.subject, new.content);
END;

-- Embeddings are keyed by model so a model change is detectable and re-indexable
-- rather than silently mixing vector spaces.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  text_hash  TEXT NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON memory_embeddings(model);

-- Every context injection is recorded so "why did Jarvis use this?" is answerable.
CREATE TABLE IF NOT EXISTS context_packs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT,
  session_id    TEXT,
  run_id        TEXT,
  role          TEXT NOT NULL,
  query         TEXT NOT NULL DEFAULT '',
  budget_tokens INTEGER NOT NULL,
  used_tokens   INTEGER NOT NULL,
  rendered      TEXT NOT NULL,
  selections    TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packs_job ON context_packs(job_id);
