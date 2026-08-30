import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type JarvisConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { ProjectService, type Project } from '../projects/service.js';
import { JobLifecycle } from './lifecycle.js';
import type { JobStage } from './machine.js';
import { JobService, type Job } from './service.js';

const roots: string[] = [];
const open: Db[] = [];
let config: JarvisConfig;
let db: Db;
let jobs: JobService;
let projects: ProjectService;
let lifecycle: JobLifecycle;
let running = new Set<string>();

afterEach(() => {
  for (const handle of open.splice(0)) {
    try {
      handle.close();
    } catch {
      // Already closed.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A real git repository. Built once per file and copied per test: spawning git
 * for every repository is by far the most expensive thing here, and it slows
 * the whole parallel suite down.
 */
let template: string | null = null;
let templateRoot: string | null = null;

afterAll(() => {
  if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
});

function repo(name: string): string {
  if (!template) {
    // Deliberately not in `roots`, which is emptied after every test.
    templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-jobrepo-template-'));
    const source = path.join(templateRoot, 'template');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# fixture\n');
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'initial');
    template = source;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-jobrepo-${name}-`));
  roots.push(dir);
  const root = path.join(dir, name);
  fs.cpSync(template, root, { recursive: true });
  return root;
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-joblifecycle-'));
  roots.push(home);
  config = loadConfig({ home });
  db = openDb(config);
  open.push(db);
  const bus = new EventBus(db);
  jobs = new JobService(db, bus);
  projects = new ProjectService(db);
  running = new Set<string>();
  lifecycle = new JobLifecycle({
    jobs,
    projects,
    pipeline: { isRunning: (id: string) => running.has(id) } as never,
    config,
  });
});

/** Legal routes from `queued` to each stage a test needs, per the state machine. */
const ROUTES: Partial<Record<JobStage, JobStage[]>> = {
  planning: ['planning'],
  implementing: ['planning', 'implementing'],
  verifying: ['planning', 'implementing', 'verifying'],
  reviewing: ['planning', 'implementing', 'verifying', 'reviewing'],
  paused: ['planning', 'paused'],
  awaiting_user: ['planning', 'implementing', 'verifying', 'reviewing', 'awaiting_user'],
  completed: ['planning', 'implementing', 'verifying', 'reviewing', 'awaiting_user', 'completed'],
  failed: ['planning', 'failed'],
  cancelled: ['planning', 'cancelled'],
};

function job(project: Project, patch: Partial<Job> = {}): Job {
  const created = jobs.create({
    projectId: project.id,
    request: 'Fix the launcher',
    acceptance: ['it exits cleanly'],
  });
  const { stage, status: _status, ...fields } = patch;
  if (Object.keys(fields).length) jobs.patch(created.id, fields);
  // Walk the declared machine rather than forcing a stage the pipeline could
  // never reach: an impossible fixture proves nothing about the real rules.
  for (const step of stage ? (ROUTES[stage] ?? [stage]) : []) {
    jobs.transition(created.id, step);
  }
  return jobs.get(created.id) as Job;
}

describe('job archiving', () => {
  it('hides a finished Job from history without losing any evidence', async () => {
    const project = await projects.register({ rootPath: repo('archive') });
    const finished = job(project, { stage: 'completed', status: 'completed' });

    jobs.setArchived(finished.id, true);
    expect(jobs.list({ archived: 'active' }).map((j) => j.id)).not.toContain(finished.id);
    expect(jobs.list({ archived: 'archived' }).map((j) => j.id)).toContain(finished.id);
    expect(jobs.get(finished.id)?.archivedAt).toBeTruthy();

    // Reversible.
    jobs.setArchived(finished.id, false);
    expect(jobs.list({ archived: 'active' }).map((j) => j.id)).toContain(finished.id);
  });

  it('refuses to archive work that is still moving', async () => {
    const project = await projects.register({ rootPath: repo('busy') });
    const live = job(project, { stage: 'implementing', status: 'running' });
    expect(() => jobs.setArchived(live.id, true)).toThrow(/only a finished job/);
  });
});

describe('retry as a new Job', () => {
  it('creates a successor that carries the request and links its predecessor', async () => {
    const project = await projects.register({ rootPath: repo('retry') });
    const failed = job(project, {
      stage: 'failed',
      status: 'failed',
      baseRef: 'oldbase',
      headRef: 'oldhead',
      reviewedHead: 'oldhead',
    });

    const next = jobs.retryAsNew(failed.id);
    expect(next.id).not.toBe(failed.id);
    expect(next.predecessorJobId).toBe(failed.id);
    expect(next.request).toBe(failed.request);
    expect(next.acceptance).toEqual(failed.acceptance);
    // A fresh candidate: no stale reviewed evidence is resurrected.
    expect(next.baseRef).toBeNull();
    expect(next.headRef).toBeNull();
    expect(next.reviewedHead).toBeNull();
    expect(next.stage).toBe('queued');
    // The original stays exactly as it was, as history.
    expect(jobs.get(failed.id)?.stage).toBe('failed');
  });

  it('refuses to re-run a validation-only Job pinned to an immutable candidate', async () => {
    const project = await projects.register({ rootPath: repo('validation') });
    const pinned = job(project, { stage: 'completed', status: 'completed', validationOnly: true });
    expect(() => jobs.retryAsNew(pinned.id)).toThrow(/validation-only/);
  });
});

describe('job deletion eligibility', () => {
  it('refuses while the Job is still active, and says to cancel first', async () => {
    const project = await projects.register({ rootPath: repo('active') });
    const live = job(project, { stage: 'implementing', status: 'running' });

    const plan = lifecycle.deletionPlan(live.id);
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toContain('cancel it');
    await expect(lifecycle.delete(live.id)).rejects.toThrow(/cancel it/);
    expect(jobs.get(live.id)).toBeTruthy();
  });

  it('allows abandoning a paused or awaiting_user candidate, and says what goes', async () => {
    const project = await projects.register({ rootPath: repo('abandon') });
    for (const stage of ['paused', 'awaiting_user'] as const) {
      const candidate = job(project, { stage, status: stage, branch: 'jarvis/job_x' });
      const plan = lifecycle.deletionPlan(candidate.id);
      expect(plan.eligible).toBe(true);
      expect(plan.reason).toContain('never applied');
      expect(plan.removes).toContain('candidate branch');
      expect(plan.preserves).toContain('the repository itself');
    }
  });

  it('never hard-deletes an applied candidate, and offers Archive instead', async () => {
    const project = await projects.register({ rootPath: repo('applied') });
    const applied = job(project, { stage: 'completed', status: 'completed' });
    db.prepare(
      `INSERT INTO reviews (id, job_id, provider, verdict, findings, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('rev_1', applied.id, 'claude', 'approve', '[]', 'now');
    db.prepare(
      `INSERT INTO candidate_applications (id, job_id, project_id, status, review_id,
        verification_cycle, candidate_base, candidate_head, approved_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('app_1', applied.id, project.id, 'applied', 'rev_1', 0, 'base', 'head', 'now', 'now');

    const plan = lifecycle.deletionPlan(applied.id);
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toMatch(/immutable/i);
    expect(plan.reason).toMatch(/archive/i);
    expect(plan.removes).toEqual([]);
    await expect(lifecycle.delete(applied.id)).rejects.toThrow(/immutable/i);

    // The evidence is intact — a cascade must not have reached it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidate_applications').get()).toEqual({ n: 1 });
    // Archiving is still available.
    expect(jobs.setArchived(applied.id, true)?.archivedAt).toBeTruthy();
  });

  it('never hard-deletes a Job carrying a self-upgrade transaction', async () => {
    const project = await projects.register({ rootPath: repo('upgrade'), isSelf: true });
    const upgraded = job(project, { stage: 'completed', status: 'completed' });
    db.prepare(
      `INSERT INTO reviews (id, job_id, provider, verdict, findings, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('rev_u', upgraded.id, 'claude', 'approve', '[]', 'now');
    db.prepare(
      `INSERT INTO candidate_applications (id, job_id, project_id, status, review_id,
        verification_cycle, candidate_base, candidate_head, approved_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('app_u', upgraded.id, project.id, 'applied', 'rev_u', 0, 'base', 'head', 'now', 'now');
    db.prepare(
      `INSERT INTO upgrade_transactions (id, job_id, application_id, status, repository, branch,
        previous_sha, candidate_sha, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('upg_1', upgraded.id, 'app_u', 'activated', '/repo', 'main', 'old', 'new', 'now', 'now');

    expect(lifecycle.deletionPlan(upgraded.id).eligible).toBe(false);
    await expect(lifecycle.delete(upgraded.id)).rejects.toThrow(/immutable|archive/i);
  });

  it('refuses to delete a Job the pipeline is still executing in this process', async () => {
    const project = await projects.register({ rootPath: repo('inflight') });
    const paused = job(project, { stage: 'paused', status: 'paused' });
    running.add(paused.id);
    await expect(lifecycle.delete(paused.id)).rejects.toThrow(/still running/);
  });
});

describe('job deletion cleanup', () => {
  it('removes disposable rows and artifacts and leaves an auditable tombstone', async () => {
    const project = await projects.register({ rootPath: repo('cleanup') });
    const conversationId = 'ses_owner';
    db.prepare(
      'INSERT INTO sessions (id, state, status, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run(conversationId, '{}', 'active', 'now', 'now');
    const doomed = jobs.create({
      projectId: project.id,
      request: 'disposable work',
      acceptance: [],
      sessionId: conversationId,
    });
    jobs.transition(doomed.id, 'planning');
    jobs.transition(doomed.id, 'failed');
    db.prepare(
      `INSERT INTO reviews (id, job_id, provider, verdict, findings, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('rev_del', doomed.id, 'claude', 'request_changes', '[]', 'now');

    const artifacts = path.join(config.artifactsDir, doomed.id);
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, 'shot.png'), 'x');

    const tombstone = await lifecycle.delete(doomed.id, 'no longer needed');

    expect(jobs.get(doomed.id)).toBeNull();
    expect(fs.existsSync(artifacts)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reviews').get()).toEqual({ n: 0 });
    // The tombstone keeps the conversation card renderable and records the act.
    expect(tombstone).toMatchObject({
      id: doomed.id,
      sessionId: conversationId,
      goal: doomed.goal,
      reason: 'no longer needed',
    });
    expect(jobs.tombstone(doomed.id)?.goal).toBe(doomed.goal);
    expect(jobs.tombstonesForSession(conversationId).map((t) => t.id)).toEqual([doomed.id]);
    // The repository itself is untouched.
    expect(fs.existsSync(path.join(project.rootPath, 'README.md'))).toBe(true);
  });
});

describe('stale job detection', () => {
  it('reports a paused Job as current while the target still matches its base', async () => {
    const root = repo('current');
    const project = await projects.register({ rootPath: root });
    const worktree = path.join(config.worktreesDir, 'job_current');
    fs.mkdirSync(worktree, { recursive: true });
    const head = git(root, 'rev-parse', 'HEAD');
    const paused = job(project, {
      stage: 'paused',
      status: 'paused',
      baseRef: head,
      worktreePath: worktree,
    });

    const report = await lifecycle.staleness(paused.id);
    expect(report.stale).toBe(false);
    expect(report.reason).toBe('current');
  });

  it('detects that the target advanced past the paused candidate, naming both SHAs', async () => {
    const root = repo('advanced');
    const project = await projects.register({ rootPath: root });
    const worktree = path.join(config.worktreesDir, 'job_stale');
    fs.mkdirSync(worktree, { recursive: true });
    const base = git(root, 'rev-parse', 'HEAD');
    const paused = job(project, {
      stage: 'paused',
      status: 'paused',
      baseRef: base,
      worktreePath: worktree,
    });

    // Exactly what a Jarvis self-update does to an older paused Job.
    fs.writeFileSync(path.join(root, 'NEW.md'), 'moved on\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'target advanced');
    const head = git(root, 'rev-parse', 'HEAD');

    const report = await lifecycle.staleness(paused.id);
    expect(report.stale).toBe(true);
    expect(report.reason).toBe('base_advanced');
    expect(report.jobBase).toBe(base);
    expect(report.targetHead).toBe(head);
    expect(report.detail).toContain(base.slice(0, 8));
    expect(report.detail).toContain(head.slice(0, 8));

    // Restarting as a new Job is the offered way out, and it starts from scratch
    // against the current target while remembering where it came from.
    const restarted = jobs.retryAsNew(paused.id);
    expect(restarted.predecessorJobId).toBe(paused.id);
    expect(restarted.baseRef).toBeNull();
  });

  it('reports a missing worktree, project or checkpoint instead of resuming blindly', async () => {
    const root = repo('missing');
    const project = await projects.register({ rootPath: root });

    const noCheckpoint = job(project, { stage: 'paused', status: 'paused' });
    expect((await lifecycle.staleness(noCheckpoint.id)).reason).toBe('no_checkpoint');

    const goneWorktree = job(project, {
      stage: 'paused',
      status: 'paused',
      baseRef: git(root, 'rev-parse', 'HEAD'),
      worktreePath: path.join(config.worktreesDir, 'never_created'),
    });
    expect((await lifecycle.staleness(goneWorktree.id)).reason).toBe('worktree_missing');

    expect((await lifecycle.staleness('job_nope')).reason).toBe('job_missing');
  });
});
