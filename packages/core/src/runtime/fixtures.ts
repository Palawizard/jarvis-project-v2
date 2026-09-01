import type { Db } from '../db/index.js';
import { nowIso } from '../ids.js';
import {
  FIXTURE_ANALYSED_PROJECT_ID,
  FIXTURE_ANALYSIS_FAILED_PROJECT_ID,
  FIXTURE_CHAT_ID,
  FIXTURE_PAUSED_JOB_ID,
  VISUAL_FIXTURE_PROFILES,
  type VisualFixtureProfile,
} from '../visualqa/surfaces.js';
import { PROJECT_PROFILE_VERSION } from '../projects/profile.js';

/** Env var through which the trusted parent asks a candidate for fixture state. */
export const CANDIDATE_FIXTURE_ENV = 'JARVIS_CANDIDATE_QA_FIXTURES';

const PROFILES: readonly VisualFixtureProfile[] = VISUAL_FIXTURE_PROFILES;

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
    if (profile === 'chat-workspace') {
      seedChatWorkspace(db, opts.projectId);
      seeded.push(profile);
    }
    if (profile === 'project-analysis') {
      seedProjectAnalysis(db, opts.projectId);
      seeded.push(profile);
    }
  }
  return seeded;
}

function seedChatWorkspace(db: Db, projectId: string): void {
  const now = nowIso();
  const earlier = '2026-08-24T09:30:00.000Z';
  db.prepare(
    `INSERT OR REPLACE INTO sessions
      (id,title,project_id,state,status,pinned,created_at,updated_at)
     VALUES (?, 'Jarvis conversation workspace', ?, ?, 'active', 1, ?, ?)`,
  ).run(
    FIXTURE_CHAT_ID,
    projectId,
    JSON.stringify({
      goal: 'Review the conversational workspace',
      constraints: ['Keep human approval boundaries explicit'],
      decisions: ['Jobs run in the background'],
      unresolved: [],
      entities: ['Jarvis'],
      activeJobIds: ['job_qafixture_active', 'job_qafixture_attention'],
      artifacts: [],
    }),
    earlier,
    now,
  );
  db.prepare(
    `INSERT OR REPLACE INTO sessions
      (id,title,project_id,state,status,pinned,created_at,updated_at)
     VALUES ('session_qafixture_other','A deliberately very long conversation title that tests sidebar overflow safely',NULL,'{}','active',0,?,?)`,
  ).run(earlier, earlier);
  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO messages
      (id,session_id,role,content,status,job_id,metadata,created_at)
     VALUES (?,?,?,?,'complete',?,?,?)`,
  );
  insertMessage.run(
    'msg_qafixture_user',
    FIXTURE_CHAT_ID,
    'user',
    'Explain the conversation and Job architecture.',
    null,
    '{}',
    earlier,
  );
  insertMessage.run(
    'msg_qafixture_assistant',
    FIXTURE_CHAT_ID,
    'assistant',
    '## One workspace, two layers\n\n- Conversations keep the transcript.\n- **Durable memory** remains separate.\n\n> Jobs are linked background work.\n### Audit linkage\n\n```ts\nconst authority = "human";\n```\n\n| Capability | Authority |\n| --- | --- |\n| Chat | Read-only agent |\n| Activation | Human + supervisor |',
    'job_qafixture_active',
    JSON.stringify({
      jobIds: ['job_qafixture_active', 'job_qafixture_attention'],
      executionId: 'tex_qafixture_agent_confirmation',
      tool: 'memory.purge',
    }),
    now,
  );
  const insertJob = db.prepare(
    `INSERT OR REPLACE INTO jobs
      (id,session_id,project_id,request,goal,acceptance,stage,status,pause_reason,
       branch,base_ref,head_ref,created_at,updated_at)
     VALUES (?,?,?,?,?,'[]',?,?,?,?,?,?,?,?)`,
  );
  insertJob.run(
    'job_qafixture_active',
    FIXTURE_CHAT_ID,
    projectId,
    'Create a Jarvis Job to improve mobile navigation.',
    'Improve the mobile conversation navigation',
    'implementing',
    'running',
    null,
    'jarvis/qa-active',
    '0'.repeat(40),
    null,
    earlier,
    now,
  );
  insertJob.run(
    'job_qafixture_attention',
    FIXTURE_CHAT_ID,
    projectId,
    'Prepare the reviewed candidate.',
    'Review the conversational assistant candidate',
    'awaiting_user',
    'awaiting_user',
    'Candidate is ready for your decision.',
    'jarvis/qa-attention',
    '0'.repeat(40),
    '1'.repeat(40),
    earlier,
    now,
  );
  const insertExecution = db.prepare(
    `INSERT OR REPLACE INTO tool_executions
      (id,tool_name,risk,definition_revision,actor,originating_actor,decision,status,
       reason_code,reason,session_id,project_id,parent_execution_id,input,input_hash,
       input_validated,error,requested_at,finished_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insertExecution.run(
    'tex_qafixture_agent_denial',
    'memory.purge',
    'destructive',
    'visual-qa-fixture',
    'agent',
    'agent',
    'deny',
    'denied',
    'actor_risk_ceiling',
    'agent destructive actions require explicit human escalation',
    FIXTURE_CHAT_ID,
    projectId,
    null,
    JSON.stringify({ id: 'mem_qafixture_target' }),
    null,
    1,
    'agent risk ceiling',
    now,
    now,
    now,
  );
  insertExecution.run(
    'tex_qafixture_agent_confirmation',
    'memory.purge',
    'destructive',
    'visual-qa-fixture',
    'user',
    'agent',
    'confirm',
    'pending_approval',
    'confirmation_required',
    'agent-originated escalation requires one-time human confirmation',
    FIXTURE_CHAT_ID,
    projectId,
    'tex_qafixture_agent_denial',
    JSON.stringify({ id: 'mem_qafixture_target' }),
    'visual-qa-fixture',
    1,
    null,
    now,
    null,
    now,
  );
}

/**
 * Two synthetic projects, one per analysis state.
 *
 * They borrow the self project's `root_path` — a real repository — because the
 * stale indicator is a comparison against a real HEAD. Pointing them at a
 * non-existent path made `profileStaleness` return `head: null`, which is
 * `stale: false`, so the "out of date" badge and its explanation were
 * unreachable in the captured evidence and the scenario silently photographed a
 * state it was not there to test. The analysed commit below exists in no
 * repository, so against a real HEAD it is always stale.
 */
function seedProjectAnalysis(db: Db, selfProjectId: string): void {
  const now = nowIso();
  const selfRow = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(selfProjectId) as
    { root_path?: string } | undefined;
  const rootPath = selfRow?.root_path ?? '/qafixture/project';
  const insert = (
    id: string,
    name: string,
    profile: string | null,
    analysis: string | null,
  ): void => {
    db.prepare(
      `INSERT OR REPLACE INTO projects (id, name, root_path, default_branch, stack, commands,
        dev_url, summary, is_self, aliases, archived_at, config, profile, analysis, created_at,
        updated_at)
       VALUES (?,?,?,?,?,?,NULL,?,0,?,NULL,'{}',?,?,?,?)`,
    ).run(
      id,
      name,
      rootPath,
      'main',
      JSON.stringify({
        languages: ['typescript'],
        frameworks: ['react', 'hono'],
        packageManager: 'pnpm',
        hasTests: true,
      }),
      JSON.stringify({ install: 'pnpm install', test: 'pnpm test', build: 'pnpm build' }),
      'Visual QA fixture project.',
      JSON.stringify(['qafixture']),
      profile,
      analysis,
      now,
      now,
    );
  };

  insert(
    FIXTURE_ANALYSED_PROJECT_ID,
    'qafixture-analysed',
    JSON.stringify({
      version: PROJECT_PROFILE_VERSION,
      purpose: 'A local-first assistant that plans, runs and reviews coding jobs on this machine.',
      architecture:
        'A pnpm monorepo: a core domain package owning SQLite persistence, a Hono HTTP and SSE ' +
        'orchestrator, and a React single-page UI served by Vite.',
      languages: ['typescript'],
      frameworks: ['react', 'hono', 'vite'],
      modules: [
        { name: 'core', path: 'packages/core', purpose: 'domain logic and SQLite persistence' },
        { name: 'orchestrator', path: 'apps/orchestrator', purpose: 'HTTP and SSE surface' },
        { name: 'web', path: 'apps/web', purpose: 'React operator interface' },
      ],
      entrypoints: ['apps/web/src/main.tsx', 'apps/orchestrator/src/server.ts'],
      importantPaths: ['packages/core/src/db', 'packages/core/src/tools'],
      testStrategy: 'Vitest unit tests beside the source; Playwright drives the browser surfaces.',
      buildWorkflow: 'pnpm install, then pnpm dev for the whole stack.',
      deploymentNotes: 'Runs locally under an external supervisor that owns activation.',
      conventions: ['Every capability goes through the tool permission boundary.'],
      integrations: ['Claude Code CLI', 'Codex CLI'],
      dataStores: ['SQLite at ~/.jarvis/jarvis.db'],
      risks: ['Migrations must preserve existing memories, jobs and projects.'],
      inspectFirst: ['CLAUDE.md', 'packages/core/src/jarvis.ts'],
      memorable: ['Jarvis memory is canonical; provider sessions are not product memory.'],
      analyzedAt: '2026-08-24T09:30:00.000Z',
      analyzedCommit: 'a'.repeat(40),
      provider: 'claude',
      model: 'sonnet',
      memoryIds: [],
    }),
    null,
  );

  insert(
    FIXTURE_ANALYSIS_FAILED_PROJECT_ID,
    'qafixture-analysis-failed',
    null,
    JSON.stringify({
      status: 'failed',
      startedAt: '2026-08-24T09:30:00.000Z',
      finishedAt: '2026-08-24T09:33:00.000Z',
      error: 'Provider usage limit reached before the analysis finished.',
      provider: 'claude',
    }),
  );
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
