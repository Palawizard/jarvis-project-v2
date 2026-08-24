import type { Db } from '../db/index.js';
import { nowIso } from '../ids.js';
import { FIXTURE_PAUSED_JOB_ID, type VisualFixtureProfile } from '../visualqa/surfaces.js';

/** Env var through which the trusted parent asks a candidate for fixture state. */
export const CANDIDATE_FIXTURE_ENV = 'JARVIS_CANDIDATE_QA_FIXTURES';

const PROFILES: readonly VisualFixtureProfile[] = ['paused-job'];

/**
 * Which fixture profiles this process was asked to seed.
 *
 * The request is not authority: it is honoured only inside a candidate runtime,
 * which owns an isolated JARVIS_HOME and a throwaway database. On the real
 * runtime this always returns nothing, whatever the environment claims.
 */
export function requestedCandidateFixtures(
  env: NodeJS.ProcessEnv = process.env,
): VisualFixtureProfile[] {
  if (env.JARVIS_CANDIDATE_RUNTIME !== '1') return [];
  const requested = (env[CANDIDATE_FIXTURE_ENV] ?? '').split(',').map((item) => item.trim());
  return PROFILES.filter((profile) => requested.includes(profile));
}

/**
 * Seed deterministic Visual-QA-only state into the candidate's own database.
 *
 * Nothing is ever copied from the real ~/.jarvis: every value below is a
 * literal written here. The synthetic Job is inert — it has no worktree and no
 * pipeline, so nothing starts and no provider runs.
 */
export function seedCandidateFixtures(
  db: Db,
  opts: { projectId: string | null; env?: NodeJS.ProcessEnv },
): VisualFixtureProfile[] {
  const profiles = requestedCandidateFixtures(opts.env ?? process.env);
  if (profiles.length === 0 || !opts.projectId) return [];
  const seeded: VisualFixtureProfile[] = [];
  for (const profile of profiles) {
    if (profile === 'paused-job') {
      seedPausedJob(db, opts.projectId);
      seeded.push(profile);
    }
  }
  return seeded;
}

function seedPausedJob(db: Db, projectId: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT OR REPLACE INTO jobs (id, session_id, project_id, request, goal, acceptance, stage,
      status, error, branch, worktree_path, base_ref, head_ref, fix_cycles, review_fix_cycles,
      visual_fix_cycles, resume_stage, pause_reason, validation_only, created_at, updated_at)
     VALUES (?,NULL,?,?,?,?,'paused','paused',NULL,?,NULL,?,?,0,0,0,'verifying',?,0,?,?)`,
  ).run(
    FIXTURE_PAUSED_JOB_ID,
    projectId,
    'Visual QA fixture: paused job detail surface',
    'Show a clearer short explanation next to the Resume button',
    JSON.stringify(['The paused explanation is readable next to Resume']),
    'jarvis/visual-qa-fixture',
    '0'.repeat(40),
    '1'.repeat(40),
    'Verification infrastructure is temporarily unavailable.',
    now,
    now,
  );
}
