import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import { loadConfig, type JarvisConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { GitWorkspace } from '../git/workspace.js';
import { nowIso } from '../ids.js';
import { JobService } from '../jobs/service.js';
import { ProjectService, type Project } from '../projects/service.js';
import { ReviewEngine } from '../review/engine.js';
import { serializeVisualReview } from '../visualqa/reviewer.js';
import { VerificationEngine } from '../verification/engine.js';
import { CandidateApplicationService } from './service.js';

let home: string;
let repo: string;
let config: JarvisConfig;
let db: Db;
let bus: EventBus;
let jobs: JobService;
let projects: ProjectService;
let project: Project;
let service: CandidateApplicationService;
let workspace: GitWorkspace;

const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-application-'));
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  config = loadConfig({ home });
  db = openDb(config);
  bus = new EventBus(db);
  jobs = new JobService(db, bus);
  projects = new ProjectService(db);
  project = await projects.register({ name: 'fixture', rootPath: repo });
  const verification = new VerificationEngine(db, config.artifactsDir, bus);
  const review = new ReviewEngine(db, {} as AgentRegistry, bus, config);
  service = new CandidateApplicationService(
    db,
    bus,
    jobs,
    projects,
    verification,
    review,
    config.worktreesDir,
    config.artifactsDir,
  );
  workspace = new GitWorkspace(config.worktreesDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function candidate(
  options: {
    verification?: 'passed' | 'failed';
    review?: 'approve' | 'request_changes';
  } = {},
) {
  const job = jobs.create({ projectId: project.id, request: 'Add the candidate file.' });
  jobs.transition(job.id, 'planning');
  const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: job.id });
  fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'reviewed\n');
  const head = await workspace.commitPending(worktree.path, 'candidate');
  if (!head) throw new Error('candidate commit missing');
  jobs.patch(job.id, {
    branch: worktree.branch,
    worktreePath: worktree.path,
    baseRef: worktree.baseRef,
    headRef: head,
    reviewedHead: head,
  });
  jobs.transition(job.id, 'implementing');
  jobs.transition(job.id, 'verifying');
  const verificationStatus = options.verification ?? 'passed';
  db.prepare(
    `INSERT INTO verifications (id, job_id, cycle, name, command, cwd, exit_code, status,
      output, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `ver_${job.id}`,
    job.id,
    0,
    'test',
    'fixture test',
    worktree.path,
    verificationStatus === 'passed' ? 0 : 1,
    verificationStatus,
    '',
    1,
    nowIso(),
  );
  jobs.transition(job.id, 'reviewing');
  const reviewId = `rev_${job.id}`;
  db.prepare(
    `INSERT INTO reviews
      (id, job_id, provider, verdict, summary, findings, head_ref, blocking, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    reviewId,
    job.id,
    'fixture',
    options.review ?? 'approve',
    'fixture review',
    '[]',
    head,
    options.review === 'request_changes' ? 1 : 0,
    nowIso(),
  );
  jobs.transition(job.id, 'awaiting_user');
  const prepared = jobs.get(job.id);
  if (!prepared) throw new Error('prepared job missing');
  return { job: prepared, worktree, head };
}

describe('candidate application', () => {
  it('approves, then cleanly fast-forwards the target', async () => {
    const prepared = await candidate();
    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
    expect(git(['rev-parse', 'HEAD'])).not.toBe(prepared.head);

    const applied = await service.apply(prepared.job.id);
    expect(applied.status).toBe('applied');
    expect(applied.targetHeadBefore).toBe(prepared.worktree.baseRef);
    expect(applied.targetHeadAfter).toBe(prepared.head);
    expect(git(['rev-parse', 'HEAD'])).toBe(prepared.head);
    expect(fs.readFileSync(path.join(repo, 'candidate.txt'), 'utf8')).toBe('reviewed\n');
    expect(jobs.get(prepared.job.id)?.stage).toBe('completed');
  });

  it('rejects visual approval when captured pixels no longer match their identity', async () => {
    const prepared = await candidate();
    projects.update(project.id, {
      config: {
        visualQa: {
          required: true,
          scenarios: [{ name: 'default', route: '/', viewports: ['desktop'] }],
        },
      },
    });
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    const original = Buffer.from('reviewed pixels');
    const digest = createHash('sha256').update(original).digest('hex');
    const screenshotPath = path.join(config.artifactsDir, `visual-${digest}.png`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, original);
    db.prepare(
      `INSERT INTO visual_qa
        (id,job_id,project_id,scenario_name,route,viewport,screenshot_path,console_errors,
         network_failures,status,reviewed_by,review_findings,head_ref,cycle,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'shot_integrity',
      prepared.job.id,
      project.id,
      'default',
      '/',
      'desktop',
      screenshotPath,
      '[]',
      '[]',
      'captured',
      'codex',
      JSON.stringify({
        verdict: 'pass',
        reviewedEvidence: [{ shotId: 'shot_integrity', sha256: digest }],
        findings: [],
      }),
      prepared.head,
      0,
      nowIso(),
    );
    fs.writeFileSync(screenshotPath, 'different pixels');
    await expect(service.approve(prepared.job.id)).rejects.toThrow(
      'required visual review is missing, failed, or contains blocking findings',
    );
  });

  it('blocks a dirty target without mutating it', async () => {
    const prepared = await candidate();
    await service.approve(prepared.job.id);
    fs.writeFileSync(path.join(repo, 'local.txt'), 'do not overwrite');
    const before = git(['rev-parse', 'HEAD']);
    await expect(service.apply(prepared.job.id)).rejects.toThrow('target working tree is dirty');
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8')).toBe('do not overwrite');
    expect(service.getForJob(prepared.job.id)?.status).toBe('failed');
  });

  it('blocks a target that advanced on a divergent commit', async () => {
    const prepared = await candidate();
    await service.approve(prepared.job.id);
    fs.writeFileSync(path.join(repo, 'other.txt'), 'independent\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'independent target']);
    const before = git(['rev-parse', 'HEAD']);
    await expect(service.apply(prepared.job.id)).rejects.toThrow('is not an ancestor');
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(service.getForJob(prepared.job.id)?.status).toBe('failed');
  });

  it('blocks a candidate changed after review', async () => {
    const prepared = await candidate();
    await service.approve(prepared.job.id);
    fs.writeFileSync(path.join(prepared.worktree.path, 'candidate.txt'), 'changed\n');
    await workspace.commitPending(prepared.worktree.path, 'post-review change');
    await expect(service.apply(prepared.job.id)).rejects.toThrow('HEAD changed after review');
    expect(git(['rev-parse', 'HEAD'])).toBe(prepared.worktree.baseRef);
  });

  it.each([
    [{ verification: 'failed' as const }, 'Deterministic verification failed'],
    [{ review: 'request_changes' as const }, 'Independent review did not approve'],
  ])('rejects approval with failed evidence %#', async (options, message) => {
    const prepared = await candidate(options);
    await expect(service.approve(prepared.job.id)).rejects.toThrow(message);
    expect(service.getForJob(prepared.job.id)).toBeNull();
  });

  it('is idempotent after application', async () => {
    const prepared = await candidate();
    await service.approve(prepared.job.id);
    const first = await service.apply(prepared.job.id);
    const second = await service.apply(prepared.job.id);
    expect(second).toEqual(first);
    expect(
      bus
        .list({ jobId: prepared.job.id })
        .filter((event) => event.type === 'candidate.apply.completed'),
    ).toHaveLength(1);
  });

  it('fails closed after a restart during application', async () => {
    const prepared = await candidate();
    const approved = await service.approve(prepared.job.id);
    db.prepare("UPDATE candidate_applications SET status='applying' WHERE id=?").run(approved.id);
    expect(service.recoverInterrupted()).toBe(1);
    expect(service.getForJob(prepared.job.id)?.status).toBe('inspection_required');
    await expect(service.apply(prepared.job.id)).rejects.toThrow('inspect it before retrying');
  });
});

const PLANNED_SCENARIO = {
  name: 'job-detail-paused',
  route: '/',
  viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
};

const CHANGED_SURFACE_PLAN = {
  source: 'changed_surface',
  required: true,
  scenarios: [PLANNED_SCENARIO],
  reasons: ['apps/web/src/views/JobDetail.tsx -> job-detail-paused'],
  fixtures: ['paused-job'],
};

/** Project defaults the reproduced job must NOT be judged against. */
function projectDefaults() {
  projects.update(project.id, {
    config: {
      visualQa: {
        required: true,
        scenarios: [
          { name: 'chat-workspace', route: '/', viewports: ['desktop', 'mobile'] },
          { name: 'tools', route: '/', viewports: ['desktop', 'mobile'] },
        ],
      },
    },
  });
}

function setPlan(jobId: string, plan: unknown) {
  db.prepare('UPDATE jobs SET visual_qa_plan=? WHERE id=?').run(
    typeof plan === 'string' ? plan : JSON.stringify(plan),
    jobId,
  );
}

/** Content-addressed screenshots plus one shared strict review, as the pipeline persists them. */
function seedVisualEvidence(
  jobId: string,
  head: string,
  shots: { name: string; route: string; viewport: 'desktop' | 'mobile' }[],
  options: {
    verdict?: 'pass' | 'needs_fix';
    corrupt?: boolean;
    /** Overrides the durable blob to reproduce legacy/hostile persisted rows. */
    review?: (rows: { id: string; sha256: string }[]) => unknown;
  } = {},
) {
  const rows = shots.map((shot, index) => {
    const bytes = Buffer.from(`pixels ${shot.name} ${shot.viewport} ${index}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const screenshotPath = path.join(config.artifactsDir, `visual-${sha256}.png`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, bytes);
    return { ...shot, id: `shot_${index}_${shot.viewport}`, sha256, screenshotPath };
  });
  // Exactly what VisualReviewer persists: the runtime review, canonicalized by
  // the production serializer.
  const runtime = {
    verdict: options.verdict ?? ('pass' as const),
    reviewedEvidence: rows.map((row) => ({ shotId: row.id, sha256: row.sha256 })),
    findings: [],
    provider: 'codex' as const,
    model: 'gpt-5-codex',
  };
  const review = options.review
    ? JSON.stringify(options.review(rows))
    : serializeVisualReview(runtime);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO visual_qa
        (id,job_id,project_id,scenario_name,route,viewport,screenshot_path,console_errors,
         network_failures,status,reviewed_by,review_findings,head_ref,cycle,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id,
      jobId,
      project.id,
      row.name,
      row.route,
      row.viewport,
      row.screenshotPath,
      '[]',
      '[]',
      'captured',
      'codex',
      review,
      head,
      0,
      nowIso(),
    );
    if (options.corrupt) fs.writeFileSync(row.screenshotPath, 'different pixels');
  }
  return rows;
}

const PLANNED_SHOTS = [
  { name: 'job-detail-paused', route: '/', viewport: 'desktop' as const },
  { name: 'job-detail-paused', route: '/', viewport: 'mobile' as const },
];

const DEFAULT_SHOTS = [
  { name: 'chat-workspace', route: '/', viewport: 'desktop' as const },
  { name: 'chat-workspace', route: '/', viewport: 'mobile' as const },
  { name: 'tools', route: '/', viewport: 'desktop' as const },
  { name: 'tools', route: '/', viewport: 'mobile' as const },
];

const VISUAL_REJECTED = 'required visual review is missing, failed, or contains blocking findings';

describe('approval validates the persisted visual QA plan', () => {
  it('approves changed-surface evidence without demanding project-default scenarios', async () => {
    const prepared = await candidate();
    projectDefaults();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS);

    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
    expect(approved.candidateHead).toBe(prepared.head);
  });

  it('approves an explicit no-evidence-required plan with no captures at all', async () => {
    // A self candidate that changes no rendered UI persists an empty plan
    // recording required:false; approval must read that instead of inheriting
    // the project's standing required:true and demanding a visualHead.
    const prepared = await candidate();
    projectDefaults();
    setPlan(prepared.job.id, {
      source: 'changed_surface',
      plannerSource: 'candidate_catalog',
      plannerHead: prepared.head,
      required: false,
      scenarios: [],
      reasons: ['no changed rendered self UI'],
      fixtures: [],
    });

    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
    expect(jobs.get(prepared.job.id)?.visualHead).toBeNull();
  });

  it('still rejects an empty scenario list while evidence is required', async () => {
    const prepared = await candidate();
    projectDefaults();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, { source: 'changed_surface', required: true, scenarios: [] });
    await expect(service.approve(prepared.job.id)).rejects.toThrow(
      'persisted visual QA plan is malformed',
    );
  });

  it('A: rejects when only project-default evidence exists for a planned job', async () => {
    const prepared = await candidate();
    projectDefaults();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, DEFAULT_SHOTS);
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });

  it('B: rejects when a planned viewport is missing', async () => {
    const prepared = await candidate();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS.slice(0, 1));
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });

  it('C: rejects when visualHead is stale', async () => {
    const prepared = await candidate();
    jobs.patch(prepared.job.id, { visualHead: prepared.worktree.baseRef });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS);
    await expect(service.approve(prepared.job.id)).rejects.toThrow(
      'visual evidence identity is stale',
    );
  });

  it('D: rejects a needs_fix visual verdict', async () => {
    const prepared = await candidate();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS, { verdict: 'needs_fix' });
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });

  it('E: rejects an invalid content-addressed screenshot', async () => {
    const prepared = await candidate();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS, { corrupt: true });
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });

  it.each([
    ['unparseable', 'not json'],
    ['wrong shape', JSON.stringify({ source: 'changed_surface', scenarios: 'all of them' })],
    ['empty scenarios', JSON.stringify({ source: 'changed_surface', scenarios: [] })],
  ])('F: fails closed on a malformed plan (%s)', async (_label, raw) => {
    const prepared = await candidate();
    projectDefaults();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, raw);
    seedVisualEvidence(prepared.job.id, prepared.head, DEFAULT_SHOTS);
    await expect(service.approve(prepared.job.id)).rejects.toThrow(
      'persisted visual QA plan is malformed',
    );
    expect(service.getForJob(prepared.job.id)).toBeNull();
  });

  it('F2: a malformed plan survives unrelated job patches instead of decaying to null', async () => {
    const prepared = await candidate();
    projectDefaults();
    setPlan(prepared.job.id, 'not json');
    // Any bookkeeping write used to rewrite the column from the lenient parse.
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    const row = db
      .prepare('SELECT visual_qa_plan FROM jobs WHERE id=?')
      .get(prepared.job.id) as Record<string, unknown>;
    expect(row.visual_qa_plan).toBe('not json');
    seedVisualEvidence(prepared.job.id, prepared.head, DEFAULT_SHOTS);
    await expect(service.approve(prepared.job.id)).rejects.toThrow(
      'persisted visual QA plan is malformed',
    );
  });

  it('G: legacy pre-plan jobs still use project defaults', async () => {
    const prepared = await candidate();
    projectDefaults();
    expect(jobs.get(prepared.job.id)?.visualQaPlan).toBeNull();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    seedVisualEvidence(prepared.job.id, prepared.head, DEFAULT_SHOTS);
    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
  });
});

describe('approval reads the durable visual review the pipeline actually persists', () => {
  /** The exact object the pre-fix VisualReviewer wrote into review_findings. */
  function legacyRuntimeReview(rows: { id: string; sha256: string }[], extras: object = {}) {
    return {
      verdict: 'pass',
      reviewedEvidence: rows.map((row) => ({ shotId: row.id, sha256: row.sha256 })),
      findings: [],
      provider: 'codex',
      model: 'gpt-5-codex',
      ...extras,
    };
  }

  async function prepareVisual() {
    const prepared = await candidate();
    jobs.patch(prepared.job.id, { visualHead: prepared.head });
    setPlan(prepared.job.id, CHANGED_SURFACE_PLAN);
    return prepared;
  }

  it('H: approves evidence written through the production serializer', async () => {
    const prepared = await prepareVisual();
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS);
    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
  });

  it('I: approves the legacy v6 row that carried provider/model', async () => {
    const prepared = await prepareVisual();
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS, {
      review: (rows) => legacyRuntimeReview(rows),
    });
    const approved = await service.approve(prepared.job.id);
    expect(approved.status).toBe('approved');
  });

  it.each([
    ['unknown extra field', { randomAuthority: 'anything' }],
    ['non-string provider identity', { provider: { id: 'codex' } }],
    ['malformed findings', { findings: [{ severity: 'high' }] }],
  ])('J: rejects a legacy-looking row with %s', async (_label, extras) => {
    const prepared = await prepareVisual();
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS, {
      review: (rows) => legacyRuntimeReview(rows, extras),
    });
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });

  it.each([
    [
      'wrong screenshot id',
      (rows: { id: string; sha256: string }[]) =>
        rows.map((row, index) => ({
          shotId: index === 0 ? 'shot_other' : row.id,
          sha256: row.sha256,
        })),
    ],
    [
      'wrong sha',
      (rows: { id: string; sha256: string }[]) =>
        rows.map((row, index) => ({
          shotId: row.id,
          sha256: index === 0 ? 'f'.repeat(64) : row.sha256,
        })),
    ],
  ])('K: rejects reviewedEvidence with a %s', async (_label, evidence) => {
    const prepared = await prepareVisual();
    seedVisualEvidence(prepared.job.id, prepared.head, PLANNED_SHOTS, {
      review: (rows) => ({ ...legacyRuntimeReview(rows), reviewedEvidence: evidence(rows) }),
    });
    await expect(service.approve(prepared.job.id)).rejects.toThrow(VISUAL_REJECTED);
  });
});
