import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { loadConfig } from '../config.js';
import { nowIso } from '../ids.js';
import { FIXTURE_PAUSED_JOB_ID } from '../visualqa/surfaces.js';
import {
  CANDIDATE_FIXTURE_ENV,
  requestedCandidateFixtures,
  seedCandidateFixtures,
} from './fixtures.js';

function db(): Db {
  const database = openDb(loadConfig({ dbPath: ':memory:' }));
  const now = nowIso();
  database
    .prepare(
      `INSERT INTO projects (id, name, root_path, default_branch, stack, commands, is_self,
        config, created_at, updated_at) VALUES ('prj_self','jarvis','C:/repo','main','{}','{}',1,'{}',?,?)`,
    )
    .run(now, now);
  return database;
}

const candidateEnv = {
  JARVIS_CANDIDATE_RUNTIME: '1',
  [CANDIDATE_FIXTURE_ENV]: 'paused-job',
} as NodeJS.ProcessEnv;

function pausedJob(database: Db) {
  return database.prepare('SELECT * FROM jobs WHERE id=?').get(FIXTURE_PAUSED_JOB_ID) as
    Record<string, unknown> | undefined;
}

describe('candidate visual QA fixtures', () => {
  it('seeds the paused job only inside a candidate runtime', () => {
    const database = db();
    expect(seedCandidateFixtures(database, { projectId: 'prj_self', env: candidateEnv })).toEqual([
      'paused-job',
    ]);
    expect(pausedJob(database)).toBeTruthy();
  });

  it('never seeds the real runtime, whatever the environment claims', () => {
    for (const env of [
      { [CANDIDATE_FIXTURE_ENV]: 'paused-job' },
      { JARVIS_CANDIDATE_RUNTIME: '0', [CANDIDATE_FIXTURE_ENV]: 'paused-job' },
      { JARVIS_CANDIDATE_RUNTIME: 'true', [CANDIDATE_FIXTURE_ENV]: 'paused-job' },
    ] as NodeJS.ProcessEnv[]) {
      const database = db();
      expect(seedCandidateFixtures(database, { projectId: 'prj_self', env })).toEqual([]);
      expect(pausedJob(database)).toBeUndefined();
      expect(requestedCandidateFixtures(env)).toEqual([]);
    }
  });

  it('refuses to seed when the trusted parent asked for nothing', () => {
    const database = db();
    const env = { JARVIS_CANDIDATE_RUNTIME: '1' } as NodeJS.ProcessEnv;
    expect(seedCandidateFixtures(database, { projectId: 'prj_self', env })).toEqual([]);
    expect(pausedJob(database)).toBeUndefined();
  });

  it('ignores unknown fixture profile names', () => {
    const database = db();
    const env = {
      JARVIS_CANDIDATE_RUNTIME: '1',
      [CANDIDATE_FIXTURE_ENV]: 'drop-tables,paused-job-extra',
    } as NodeJS.ProcessEnv;
    expect(seedCandidateFixtures(database, { projectId: 'prj_self', env })).toEqual([]);
    expect(pausedJob(database)).toBeUndefined();
  });

  it('renders a real paused job: paused state, resumeStage and pauseReason', () => {
    const database = db();
    seedCandidateFixtures(database, { projectId: 'prj_self', env: candidateEnv });
    const row = pausedJob(database) as Record<string, unknown>;
    expect(row.stage).toBe('paused');
    expect(row.status).toBe('paused');
    expect(row.resume_stage).toBe('verifying');
    expect(row.pause_reason).toBe('Verification infrastructure is temporarily unavailable.');
    // Inert by construction: no worktree means no pipeline and no provider run.
    expect(row.worktree_path).toBeNull();
  });

  it('uses only synthetic values — no real job id, branch or sha', () => {
    const database = db();
    seedCandidateFixtures(database, { projectId: 'prj_self', env: candidateEnv });
    const row = pausedJob(database) as Record<string, unknown>;
    expect(row.id).toBe(FIXTURE_PAUSED_JOB_ID);
    expect(row.branch).toBe('jarvis/visual-qa-fixture');
    expect(row.base_ref).toBe('0'.repeat(40));
    expect(row.head_ref).toBe('1'.repeat(40));
  });

  it('is idempotent across repeated candidate boots', () => {
    const database = db();
    seedCandidateFixtures(database, { projectId: 'prj_self', env: candidateEnv });
    seedCandidateFixtures(database, { projectId: 'prj_self', env: candidateEnv });
    const count = database.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it('does nothing when the candidate has no self project yet', () => {
    const database = db();
    expect(seedCandidateFixtures(database, { projectId: null, env: candidateEnv })).toEqual([]);
    expect(pausedJob(database)).toBeUndefined();
  });
});
