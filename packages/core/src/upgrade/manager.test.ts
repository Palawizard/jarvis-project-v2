import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { GitWorkspace } from '../git/workspace.js';
import { nowIso } from '../ids.js';
import { JobService } from '../jobs/service.js';
import { ProjectService } from '../projects/service.js';
import { UpgradeManager } from './manager.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.JARVIS_SUPERVISED;
  delete process.env.JARVIS_UPGRADE_REQUEST_PATH;
  delete process.env.JARVIS_UPGRADE_SOCKET;
  delete process.env.JARVIS_UPGRADE_TOKEN_HASH;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('self-upgrade activation publication', () => {
  it('atomically accepts one concurrent activation and never persists the human token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-upgrade-claim-'));
    roots.push(home);
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (args: string[], cwd = repo) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);

    const config = loadConfig({ home });
    const db = openDb(config);
    const bus = new EventBus(db);
    const jobs = new JobService(db, bus);
    const projects = new ProjectService(db);
    const project = await projects.register({ rootPath: repo, isSelf: true });
    const job = jobs.create({ projectId: project.id, request: 'upgrade' });
    const workspace = new GitWorkspace(config.worktreesDir);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: job.id });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'candidate\n');
    const candidateSha = await workspace.commitPending(worktree.path, 'candidate');
    if (!candidateSha) throw new Error('candidate commit missing');
    jobs.patch(job.id, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      headRef: candidateSha,
    });
    const now = nowIso();
    db.prepare(
      `INSERT INTO reviews (id,job_id,provider,verdict,summary,findings,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('review', job.id, 'fixture', 'approve', 'approved', '[]', now);
    db.prepare(
      `INSERT INTO candidate_applications
        (id,job_id,project_id,status,review_id,verification_cycle,candidate_base,candidate_head,
         method,approved_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'application',
      job.id,
      project.id,
      'approved',
      'review',
      0,
      worktree.baseRef,
      candidateSha,
      'ff-only',
      now,
      now,
    );
    const rollbackRef = 'refs/jarvis/rollback/upgrade-claim';
    git(['update-ref', rollbackRef, worktree.baseRef]);
    db.prepare(
      `INSERT INTO upgrade_transactions
        (id,job_id,application_id,status,repository,branch,previous_sha,candidate_sha,rollback_ref,
         created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'upgrade-claim',
      job.id,
      'application',
      'preflight_passed',
      repo,
      'main',
      worktree.baseRef,
      candidateSha,
      rollbackRef,
      now,
      now,
    );

    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\jarvis-upgrade-test-${randomUUID()}`
        : path.join(home, 'upgrade.sock');
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.setEncoding('utf8');
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk;
        if (!pending.includes('\n')) return;
        if (pending.startsWith('ack\n')) return socket.end();
        socket.write('{"accepted":true}\n');
        pending = '';
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    const token = 'human-activation-token-0123456789abcdef';
    const requestPath = path.join(home, 'state', 'activate.json');
    process.env.JARVIS_SUPERVISED = '1';
    process.env.JARVIS_UPGRADE_REQUEST_PATH = requestPath;
    process.env.JARVIS_UPGRADE_SOCKET = endpoint;
    process.env.JARVIS_UPGRADE_TOKEN_HASH = createHash('sha256').update(token).digest('hex');
    const manager = new UpgradeManager(db, bus, jobs, projects, {} as never, config);
    const outcomes = await Promise.allSettled([
      manager.requestActivation(job.id, token),
      manager.requestActivation(job.id, token),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(connections).toBe(1);
    const transaction = manager.getForJob(job.id);
    expect(transaction?.status).toBe('activation_requested');
    const resultPath = path.join(config.home, 'upgrades', 'upgrade-claim-result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        status: 'activated',
        transactionId: 'upgrade-claim',
        repository: repo,
        branch: 'main',
        previousSha: worktree.baseRef,
        candidateSha,
        headAfter: candidateSha,
      }),
    );
    expect(manager.getForJob(job.id)?.status).toBe('inspection_required');
    expect(
      db.prepare("SELECT status FROM candidate_applications WHERE id='application'").get(),
    ).toEqual({ status: 'approved' });
    expect(git(['rev-parse', 'HEAD'])).toBe(worktree.baseRef);
    expect(fs.existsSync(requestPath)).toBe(false);
    expect(
      fs.existsSync(path.dirname(requestPath))
        ? fs
            .readdirSync(path.dirname(requestPath))
            .map((name) => fs.readFileSync(path.join(path.dirname(requestPath), name), 'utf8'))
            .join('\n')
        : '',
    ).not.toContain(token);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
});
