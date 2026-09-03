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

  it('resolves a subdirectory to the repository that contains it', async () => {
    const nested = path.join(repo, 'packages', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'index.ts'), 'export const x = 1;\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'nested']);

    const status = await repoStatus(nested);

    // Registering a project at a subdirectory must describe the whole
    // repository, not treat every file outside the subdirectory as deleted.
    expect(status.isRepo).toBe(true);
    expect(status.root).toBe(fs.realpathSync.native(repo));
    expect(status.dirty).toBe(false);
    expect(status.dirtyFiles).toEqual([]);
  });

  it('detects untracked work hidden by shared info excludes', async () => {
    const common = git(['rev-parse', '--git-common-dir']);
    const info = path.resolve(repo, common, 'info');
    fs.mkdirSync(info, { recursive: true });
    // Neither tracked nor per-worktree, so hiding work here never shows up in
    // a reviewed diff the way a .gitignore change would.
    fs.writeFileSync(path.join(info, 'exclude'), '# comment\nplanted.js\n');
    fs.writeFileSync(path.join(repo, 'planted.js'), 'throw new Error("unreviewed");\n');

    const status = await repoStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles.join(' ')).toContain('planted.js');
  });

  it('detects untracked work hidden by a configured excludes file', async () => {
    const excludes = path.join(home, 'candidate-excludes');
    fs.writeFileSync(excludes, 'planted.js\n');
    git(['config', 'core.excludesFile', excludes]);
    fs.writeFileSync(path.join(repo, 'planted.js'), 'throw new Error("unreviewed");\n');

    const status = await repoStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles.join(' ')).toContain('planted.js');
  });

  it('stays clean when the default comment-only info exclude is present', async () => {
    const common = git(['rev-parse', '--git-common-dir']);
    const info = path.resolve(repo, common, 'info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'exclude'), '# git ls-files --others --exclude-from=..\n#\n');

    const status = await repoStatus(repo);

    expect(status.dirty).toBe(false);
    expect(status.dirtyFiles).toEqual([]);
  });

  it('detects uncommitted work', async () => {
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'work in progress');
    const status = await repoStatus(repo);
    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles.length).toBe(1);
  });

  it('detects untracked work hidden by repository status configuration', async () => {
    git(['config', 'status.showUntrackedFiles', 'no']);
    fs.writeFileSync(path.join(repo, 'hidden-runtime.js'), 'throw new Error("unreviewed");\n');

    const status = await repoStatus(repo);

    expect(status.dirty).toBe(true);
    expect(status.dirtyFiles.some((file) => file.includes('hidden-runtime.js'))).toBe(true);
  });

  it('does not hand the parent environment to a Git filter driver', async () => {
    // A `filter` attribute makes Git execute the configured driver. An agent
    // holding a shell in a worktree can plant one; it must not thereby read the
    // credentials the untrusted-process allowlist exists to withhold.
    process.env.JARVIS_CONTROL_TOKEN = 'control-token-must-not-leak';
    try {
      const captured = path.join(home, 'captured.txt');
      const driver = path.join(home, 'driver.mjs');
      fs.writeFileSync(
        driver,
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(captured)}, String(process.env.JARVIS_CONTROL_TOKEN)); process.stdin.pipe(process.stdout);\n`,
      );
      fs.writeFileSync(path.join(repo, '.gitattributes'), 'README.md filter=harvest\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'attributes']);
      git(['config', 'filter.harvest.clean', `node ${JSON.stringify(driver)}`]);
      // Invalidate the index stat cache so Git must re-hash and run the driver.
      fs.writeFileSync(path.join(repo, 'README.md'), fs.readFileSync(path.join(repo, 'README.md')));

      await repoStatus(repo);

      const leaked = fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8') : '';
      expect(leaked).not.toContain('control-token-must-not-leak');
    } finally {
      delete process.env.JARVIS_CONTROL_TOKEN;
    }
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

  it('recovers the same validated job worktree after a planning interruption', async () => {
    const first = await workspace.createWorktree({ repoRoot: repo, jobId: 'resume-planning' });
    const second = await workspace.createWorktree({ repoRoot: repo, jobId: 'resume-planning' });

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(second.warnings.join(' ')).toContain('Recovered');
  });

  it('preserves but refuses an uncheckpointed descendant after a planning crash', async () => {
    const first = await workspace.createWorktree({ repoRoot: repo, jobId: 'poison-planning' });
    fs.writeFileSync(path.join(first.path, 'poison.txt'), 'untrusted descendant\n');
    git(['add', '-A'], first.path);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'poison planning recovery'],
      first.path,
    );

    await expect(
      workspace.createWorktree({ repoRoot: repo, jobId: 'poison-planning' }),
    ).rejects.toMatchObject({ code: 'recovery_head_mismatch' });
    expect(fs.readFileSync(path.join(first.path, 'poison.txt'), 'utf8')).toContain('untrusted');
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

  it('refuses to reuse an ambiguous existing worktree', async () => {
    const existing = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_dup' });
    fs.writeFileSync(path.join(existing.path, 'unexpected.txt'), 'ambiguous');
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

  it('reports rename endpoints as literal paths', async () => {
    const source = path.join(repo, 'Command.tsx');
    fs.writeFileSync(source, 'export const Command = true;\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'add command']);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_rename' });
    fs.renameSync(source.replace(repo, worktree.path), path.join(worktree.path, 'Chat.tsx'));
    await workspace.commitPending(worktree.path, 'rename command to chat');

    const paths = (await workspace.collectChanges(worktree.path, worktree.baseRef)).files.map(
      (file) => file.path,
    );
    expect(paths.sort()).toEqual(['Chat.tsx', 'Command.tsx']);
    expect(paths.join(' ')).not.toContain('{');
  });

  it('ignores candidate-controlled diff drivers when reading the change', async () => {
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'job_textconv' });
    // A candidate can write .gitattributes and tamper with repository config; a
    // diff driver must never turn a trusted read into candidate code execution.
    fs.writeFileSync(path.join(worktree.path, '.gitattributes'), '*.tsx diff=evil\n');
    fs.writeFileSync(path.join(worktree.path, 'View.tsx'), 'export const real = 1;\n');
    git(['config', 'diff.evil.textconv', 'node -e "console.log(\'PWNED\')"'], worktree.path);
    git(['config', 'diff.evil.command', 'node -e "console.log(\'PWNED\')"'], worktree.path);
    await workspace.commitPending(worktree.path, 'add view');

    const changes = await workspace.collectChanges(worktree.path, worktree.baseRef);
    expect(changes.diff).toContain('export const real = 1;');
    expect(changes.diff).not.toContain('PWNED');
    expect(changes.files.map((f) => f.path)).toContain('View.tsx');
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

describe('immutable candidate materialization', () => {
  it('reproduces the pinned source tree including deletes, binary bytes, and modes', async () => {
    fs.writeFileSync(path.join(repo, 'deleted.txt'), 'remove me\n');
    fs.writeFileSync(path.join(repo, 'mode.sh'), '#!/bin/sh\necho base\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'candidate base']);
    const base = git(['rev-parse', 'HEAD']);

    git(['switch', '-qc', 'candidate-source']);
    fs.rmSync(path.join(repo, 'deleted.txt'));
    fs.writeFileSync(path.join(repo, 'added.txt'), 'added\n');
    fs.writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 255, 1, 2, 128, 13, 10]));
    fs.writeFileSync(path.join(repo, 'mode.sh'), '#!/bin/sh\necho source\n');
    // Windows has no on-disk executable bit, so the index needs it set explicitly;
    // on Linux core.filemode is live and the working tree must match, or the
    // switch below sees a dirty mode change.
    fs.chmodSync(path.join(repo, 'mode.sh'), 0o755);
    git(['add', '-A']);
    git(['update-index', '--chmod=+x', 'mode.sh']);
    git(['commit', '-qm', 'candidate source']);
    const source = git(['rev-parse', 'HEAD']);
    const sourceRefBefore = git(['rev-parse', 'candidate-source']);
    git(['switch', '-q', 'main']);

    await expect(workspace.validateCandidateSource(repo, base, source)).resolves.toEqual({
      baseSha: base,
      sourceSha: source,
    });
    const worktree = await workspace.createWorktree({
      repoRoot: repo,
      jobId: 'job_import',
      baseRef: base,
    });
    const materialized = await workspace.materializeCandidate(worktree.path, base, source);

    expect(git(['rev-parse', `${materialized}^{tree}`], worktree.path)).toBe(
      git(['rev-parse', `${source}^{tree}`]),
    );
    expect(fs.existsSync(path.join(worktree.path, 'deleted.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(worktree.path, 'added.txt'), 'utf8')).toBe('added\n');
    expect(fs.readFileSync(path.join(worktree.path, 'binary.bin'))).toEqual(
      Buffer.from([0, 255, 1, 2, 128, 13, 10]),
    );
    expect(git(['ls-tree', 'HEAD', 'mode.sh'], worktree.path)).toMatch(/^100755 /);
    expect(git(['rev-parse', 'candidate-source'])).toBe(sourceRefBefore);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('rejects a source outside the registered repository and an unrelated base', async () => {
    const foreign = path.join(home, 'foreign');
    fs.mkdirSync(foreign);
    execFileSync('git', ['init', '-q'], { cwd: foreign });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: foreign });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: foreign });
    fs.writeFileSync(path.join(foreign, 'foreign.txt'), 'foreign');
    execFileSync('git', ['add', '-A'], { cwd: foreign });
    execFileSync('git', ['commit', '-qm', 'foreign'], { cwd: foreign });
    const foreignSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: foreign,
      encoding: 'utf8',
    }).trim();
    await expect(
      workspace.validateCandidateSource(repo, git(['rev-parse', 'HEAD']), foreignSha),
    ).rejects.toMatchObject({ code: 'commit_missing' });

    const base = git(['rev-parse', 'HEAD']);
    git(['switch', '--orphan', 'unrelated']);
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated');
    git(['add', '-A']);
    git(['commit', '-qm', 'unrelated source']);
    const unrelated = git(['rev-parse', 'HEAD']);
    git(['switch', '-q', 'main']);
    await expect(workspace.validateCandidateSource(repo, base, unrelated)).rejects.toMatchObject({
      code: 'candidate_source_base_mismatch',
    });
  });
});

describe('candidate application', () => {
  it('fast-forwards a clean candidate to its exact reviewed commit', async () => {
    const base = git(['rev-parse', 'HEAD']);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'apply-clean' });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'candidate\n');
    const candidate = await workspace.commitPending(worktree.path, 'candidate');
    if (!candidate) throw new Error('setup failed');

    await expect(
      workspace.fastForward({
        targetRoot: repo,
        worktreePath: worktree.path,
        baseRef: base,
        expectedHead: candidate,
      }),
    ).resolves.toMatchObject({ targetHeadAfter: candidate });
    expect(git(['rev-parse', 'HEAD'])).toBe(candidate);
  });

  it('updates the registered checkout instead of a configured worktree decoy', async () => {
    const base = git(['rev-parse', 'HEAD']);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'worktree-decoy' });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'candidate\n');
    const candidate = await workspace.commitPending(worktree.path, 'candidate');
    if (!candidate) throw new Error('setup failed');
    const decoy = path.join(home, 'decoy');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'README.md'), '# original\n');
    git(['config', 'core.worktree', decoy], worktree.path);

    await workspace.fastForward({
      targetRoot: repo,
      worktreePath: worktree.path,
      baseRef: base,
      expectedHead: candidate,
    });

    expect(fs.readFileSync(path.join(repo, 'candidate.txt'), 'utf8')).toBe('candidate\n');
    expect(fs.existsSync(path.join(decoy, 'candidate.txt'))).toBe(false);
  });

  it.each(['smudge', 'process'])(
    'rejects a candidate %s filter without running it',
    async (kind) => {
      const base = git(['rev-parse', 'HEAD']);
      const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: `filter-${kind}` });
      fs.writeFileSync(path.join(worktree.path, '.gitattributes'), 'payload.txt filter=evil\n');
      fs.writeFileSync(path.join(worktree.path, 'payload.txt'), 'candidate\n');
      git(['add', '-A'], worktree.path);
      git(['commit', '-qm', `candidate ${kind} filter`], worktree.path);
      const candidate = git(['rev-parse', 'HEAD'], worktree.path);
      const marker = path.join(home, `${kind}-ran`);
      const driver = path.join(home, `${kind}.mjs`);
      fs.writeFileSync(
        driver,
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); process.stdin.pipe(process.stdout);\n`,
      );
      git(['config', `filter.evil.${kind}`, `node ${JSON.stringify(driver)}`], worktree.path);
      git(['config', 'filter.evil.required', 'true'], worktree.path);

      await expect(
        workspace.fastForward({
          targetRoot: repo,
          worktreePath: worktree.path,
          baseRef: base,
          expectedHead: candidate,
        }),
      ).rejects.toMatchObject({ code: 'checkout_filter_prohibited' });
      expect(fs.existsSync(marker)).toBe(false);
      expect(git(['rev-parse', 'HEAD'])).toBe(base);
    },
  );

  it('rejects shared info attributes before moving the target', async () => {
    const base = git(['rev-parse', 'HEAD']);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: 'shared-attributes' });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'candidate\n');
    const candidate = await workspace.commitPending(worktree.path, 'candidate');
    if (!candidate) throw new Error('setup failed');
    const common = git(['rev-parse', '--git-common-dir']);
    const info = path.resolve(repo, common, 'info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'attributes'), 'candidate.txt filter=evil\n');

    await expect(
      workspace.fastForward({
        targetRoot: repo,
        worktreePath: worktree.path,
        baseRef: base,
        expectedHead: candidate,
      }),
    ).rejects.toMatchObject({ code: 'shared_attributes_prohibited' });
    expect(git(['rev-parse', 'HEAD'])).toBe(base);
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
