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
