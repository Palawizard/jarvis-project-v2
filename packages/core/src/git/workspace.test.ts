import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { GitWorkspace, repoStatus, GitError } from './workspace.js';

let home: string;
let repo: string;
let worktreesDir: string;
let workspace: GitWorkspace;

const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-git-'));
  repo = path.join(home, 'repo');
  worktreesDir = path.join(home, 'worktrees');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Pin line endings so byte-for-byte content assertions hold on Windows too.
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# original\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial']);
  workspace = new GitWorkspace(worktreesDir);
});

afterEach(() => {
  // Release worktree handles before removing the tree.
  try {
    git(['worktree', 'prune']);
  } catch {
    /* repo may already be gone */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('repo status', () => {
  it('detects a clean repository', async () => {
    const status = await repoStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.dirty).toBe(false);
    expect(status.branch).toBe('main');
    expect(status.head).toHaveLength(40);
  });

  it('detects uncommitted work', async () => {
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'work in progress');
    const status = await repoStatus(repo);
    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles.length).toBe(1);
  });

  it('reports a non-repository without throwing', async () => {
    const status = await repoStatus(home);
    expect(status.isRepo).toBe(false);
  });
});

describe('worktree isolation', () => {
  it('creates an isolated worktree on its own branch', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_iso' });
    expect(fs.existsSync(worktree.path)).toBe(true);
    expect(worktree.branch).toBe('jarvis/job_iso');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path)).toBe('jarvis/job_iso');
    // The user's checkout is untouched.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('NEVER destroys uncommitted user work', async () => {
    const scratch = path.join(repo, 'important-unsaved.txt');
    fs.writeFileSync(scratch, 'hours of unsaved work');
    fs.writeFileSync(path.join(repo, 'README.md'), '# locally edited\n');

    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_dirty' });

    // The dirty state is preserved exactly.
    expect(fs.readFileSync(scratch, 'utf8')).toBe('hours of unsaved work');
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# locally edited\n');
    // And the user is told what was excluded rather than it happening silently.
    expect(worktree.warnings.join(' ')).toMatch(/uncommitted/i);
    // The worktree branches from committed HEAD, so it has the original content.
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf8')).toBe('# original\n');
    expect(fs.existsSync(path.join(worktree.path, 'important-unsaved.txt'))).toBe(false);
  });

  it('gives concurrent jobs separate checkouts', async () => {
    const a = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_a' });
    const b = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_b' });
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);

    fs.writeFileSync(path.join(a.path, 'only-a.txt'), 'a');
    expect(fs.existsSync(path.join(b.path, 'only-a.txt'))).toBe(false);
  });

  it('refuses to reuse an existing worktree path', async () => {
    await workspace.createWorktree({ repoRoot: repo, jobId: 'job_dup' });
    await expect(workspace.createWorktree({ repoRoot: repo, jobId: 'job_dup' })).rejects.toThrow(
      GitError,
    );
  });

  it('fails explicitly on a non-repository', async () => {
    await expect(
      workspace.createWorktree({ repoRoot: home, jobId: 'job_x' }),
    ).rejects.toMatchObject({
      code: 'not_a_repo',
    });
  });

  it('fails explicitly when the repository has no commits', async () => {
    const empty = path.join(home, 'empty');
    fs.mkdirSync(empty);
    execFileSync('git', ['init', '-q'], { cwd: empty });
    await expect(
      workspace.createWorktree({ repoRoot: empty, jobId: 'job_e' }),
    ).rejects.toMatchObject({
      code: 'no_commits',
    });
  });
});

describe('collecting the candidate change', () => {
  it('captures commits, per-file stats and a diff', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_diff' });
    fs.writeFileSync(path.join(worktree.path, 'feature.ts'), 'export const answer = 42;\n');
    fs.writeFileSync(path.join(worktree.path, 'README.md'), '# original\n\nNow documented.\n');
    git(['add', '-A'], worktree.path);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add feature'],
      worktree.path,
    );

    const changes = await workspace.collectChanges(worktree.path, worktree.baseRef);
    expect(changes.commits).toHaveLength(1);
    expect(changes.commits[0]?.subject).toBe('add feature');
    expect(changes.commits[0]?.sha).toHaveLength(40);
    expect(changes.files.map((f) => f.path).sort()).toEqual(['README.md', 'feature.ts']);
    expect(changes.diff).toContain('export const answer = 42;');
  });

  it('commits work an agent left uncommitted', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_pending' });
    fs.writeFileSync(path.join(worktree.path, 'untracked.ts'), 'export const x = 1;\n');

    const sha = await workspace.commitPending(worktree.path, 'jarvis: agent output');
    expect(sha).toHaveLength(40);

    const changes = await workspace.collectChanges(worktree.path, worktree.baseRef);
    expect(changes.uncommitted).toHaveLength(0);
    expect(changes.files.some((f) => f.path === 'untracked.ts')).toBe(true);
  });

  it('returns null when there is nothing to commit', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_noop' });
    expect(await workspace.commitPending(worktree.path, 'nothing')).toBeNull();
  });

  it('binds approval to a clean reviewed HEAD', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_identity' });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'reviewed\n');
    const reviewedHead = await workspace.commitPending(worktree.path, 'reviewed candidate');
    if (!reviewedHead) throw new Error('setup failed');

    await expect(
      workspace.validateCandidate(worktree.path, worktree.baseRef, reviewedHead),
    ).resolves.toMatchObject({ head: reviewedHead, uncommitted: [] });

    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'mutated\n');
    await expect(
      workspace.validateCandidate(worktree.path, worktree.baseRef, reviewedHead),
    ).rejects.toThrow('uncommitted changes');
    await workspace.commitPending(worktree.path, 'post-review mutation');
    await expect(
      workspace.validateCandidate(worktree.path, worktree.baseRef, reviewedHead),
    ).rejects.toThrow('HEAD changed after review');
  });

  it('truncates an enormous diff instead of blowing up the reviewer prompt', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_big' });
    fs.writeFileSync(path.join(worktree.path, 'big.txt'), 'x'.repeat(400_000));
    await workspace.commitPending(worktree.path, 'big file');

    const changes = await workspace.collectChanges(worktree.path, worktree.baseRef);
    expect(changes.diffTruncated).toBe(true);
    expect(changes.diff).toContain('[diff truncated');
    expect(changes.diff.length).toBeLessThan(260_000);
  });
});

describe('cleanup', () => {
  it('removes a worktree and its branch', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_clean' });
    await workspace.removeWorktree(repo, worktree.path, { deleteBranch: worktree.branch });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(await workspace.listWorktrees(repo)).not.toContain(worktree.path);
  });
});
