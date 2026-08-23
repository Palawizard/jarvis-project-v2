import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const exec = promisify(execFile);
const log = createLogger('git');

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args[0]} failed`,
      'git_command_failed',
      (err.stderr || err.message || '').trim(),
    );
  }
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(`git ${args[0]} failed`, 'git_command_failed', err.stderr || err.message);
  }
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const errors: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new GitError(
              `git ${args[0]} failed`,
              'git_command_failed',
              Buffer.concat(errors).toString().trim(),
            ),
          ),
    );
    child.stdin.end(input);
  });
}

export interface RepoStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  /** Uncommitted changes in the user's primary working tree. */
  dirty: boolean;
  dirtyFiles: string[];
}

export async function repoStatus(dir: string): Promise<RepoStatus> {
  if (!fs.existsSync(dir)) {
    return { isRepo: false, root: null, branch: null, head: null, dirty: false, dirtyFiles: [] };
  }
  let root: string;
  try {
    root = await git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return { isRepo: false, root: null, branch: null, head: null, dirty: false, dirtyFiles: [] };
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  const head = await git(root, ['rev-parse', 'HEAD']).catch(() => null);
  // A failed status command is never evidence of a clean tree. Mutation callers
  // must fail closed rather than risk overwriting work Git could not inspect.
  const porcelain = await git(root, ['status', '--porcelain']);
  const dirtyFiles = porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    isRepo: true,
    root: path.resolve(root),
    branch,
    head,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

export interface Worktree {
  path: string;
  branch: string;
  baseRef: string;
}

export interface FastForwardPreflight {
  targetRoot: string;
  targetBranch: string;
  targetHead: string;
  candidateBase: string;
  candidateHead: string;
}

/**
 * Isolated workspace manager.
 *
 * Safety rules, enforced here rather than by convention:
 *  1. The user's primary working tree is NEVER modified — no checkout, no stash,
 *     no reset. We only read its HEAD.
 *  2. Uncommitted user work is never a blocker and never destroyed; the worktree
 *     branches from the last commit, and we report what was left behind.
 *  3. Each job gets its own worktree directory, so concurrent workers can never
 *     write to the same checkout.
 */
export class GitWorkspace {
  constructor(private readonly worktreesDir: string) {}

  async createWorktree(opts: {
    repoRoot: string;
    jobId: string;
    branchPrefix?: string;
    baseRef?: string;
  }): Promise<Worktree & { warnings: string[] }> {
    const status = await repoStatus(opts.repoRoot);
    if (!status.isRepo || !status.root) {
      throw new GitError(`${opts.repoRoot} is not a git repository`, 'not_a_repo');
    }
    if (!status.head) {
      throw new GitError(
        'repository has no commits yet; make an initial commit before running jobs',
        'no_commits',
      );
    }

    const baseRef = opts.baseRef
      ? await this.resolveCommit(status.root, opts.baseRef)
      : status.head;
    const warnings: string[] = [];
    if (status.dirty) {
      // Explicitly NOT an error: we branch from HEAD and leave their work alone.
      warnings.push(
        `Working tree has ${status.dirtyFiles.length} uncommitted change(s). ` +
          `The worktree branches from committed HEAD (${status.head.slice(0, 8)}); ` +
          `uncommitted work stays untouched in your checkout and is NOT included.`,
      );
    }

    const branch = `${opts.branchPrefix ?? 'jarvis'}/${opts.jobId}`;
    const target = path.join(this.worktreesDir, opts.jobId);

    if (fs.existsSync(target)) {
      const existing = await repoStatus(target);
      const existingBranch = existing.isRepo
        ? await git(target, ['branch', '--show-current']).catch(() => '')
        : '';
      if (
        existing.root &&
        existing.head &&
        !existing.dirty &&
        existingBranch === branch &&
        (await repositoryIdentity(status.root)) === (await repositoryIdentity(target))
      ) {
        await requireAncestor(target, baseRef, existing.head, 'recovery_base_mismatch');
        warnings.push(`Recovered the existing job worktree at ${target}.`);
        return { path: target, branch, baseRef, warnings };
      }
      throw new GitError(`worktree path already exists: ${target}`, 'worktree_exists');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });

    try {
      await git(status.root, ['worktree', 'add', '-b', branch, target, baseRef]);
    } catch (error) {
      // Leave no half-created directory behind.
      fs.rmSync(target, { recursive: true, force: true });
      throw error instanceof GitError
        ? new GitError(
            `could not create worktree: ${error.detail ?? error.message}`,
            'worktree_create_failed',
            error.detail,
          )
        : error;
    }

    log.info('worktree created', { branch, target, base: baseRef });
    return { path: target, branch, baseRef, warnings };
  }

  async resolveCommit(repoRoot: string, ref: string): Promise<string> {
    const status = await repoStatus(repoRoot);
    if (!status.isRepo || !status.root || !samePath(status.root, repoRoot)) {
      throw new GitError(
        'repository identity does not match the registered project',
        'repository_mismatch',
      );
    }
    return git(status.root, ['rev-parse', '--verify', `${ref}^{commit}`]).catch(() => {
      throw new GitError(
        `commit does not exist in the registered repository: ${ref}`,
        'commit_missing',
      );
    });
  }

  async validateCandidateSource(repoRoot: string, baseRef: string, sourceRef: string) {
    const baseSha = await this.resolveCommit(repoRoot, baseRef);
    const sourceSha = await this.resolveCommit(repoRoot, sourceRef);
    await requireAncestor(repoRoot, baseSha, sourceSha, 'candidate_source_base_mismatch');
    return { baseSha, sourceSha };
  }

  /** Materialize an immutable base->source delta without checking out or moving the source ref. */
  async materializeCandidate(
    worktreePath: string,
    baseSha: string,
    sourceSha: string,
  ): Promise<string> {
    const status = await repoStatus(worktreePath);
    if (!status.isRepo || !status.root || status.head !== baseSha || status.dirty) {
      throw new GitError(
        'candidate import worktree is not a clean checkout of the requested base',
        'candidate_import_state',
      );
    }
    await requireAncestor(worktreePath, baseSha, sourceSha, 'candidate_source_base_mismatch');
    const patch = await gitRaw(worktreePath, [
      'diff',
      '--binary',
      '--full-index',
      '--find-renames',
      baseSha,
      sourceSha,
      '--',
    ]);
    if (patch) await gitWithInput(worktreePath, ['apply', '--index', '--binary', '-'], patch);
    await this.commitPending(
      worktreePath,
      `jarvis: materialize candidate ${sourceSha.slice(0, 12)}`,
    );
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    const [candidateTree, sourceTree] = await Promise.all([
      git(worktreePath, ['rev-parse', `${head}^{tree}`]),
      git(worktreePath, ['rev-parse', `${sourceSha}^{tree}`]),
    ]);
    if (candidateTree !== sourceTree) {
      throw new GitError(
        'materialized candidate tree does not exactly match the pinned source',
        'candidate_parity',
      );
    }
    return head;
  }

  async validateRecoveryWorkspace(opts: {
    repoRoot: string;
    worktreePath: string;
    baseRef: string;
    expectedHead?: string | null;
    allowDirty?: boolean;
  }): Promise<RepoStatus> {
    if (!fs.existsSync(opts.worktreePath)) {
      throw new GitError('recovery worktree is missing', 'recovery_worktree_missing');
    }
    const status = await repoStatus(opts.worktreePath);
    if (!status.isRepo || !status.root || !status.head) {
      throw new GitError('recovery worktree is not a Git repository', 'recovery_not_a_repo');
    }
    if (
      (await repositoryIdentity(opts.repoRoot)) !== (await repositoryIdentity(opts.worktreePath))
    ) {
      throw new GitError(
        'recovery worktree belongs to another repository',
        'recovery_repository_mismatch',
      );
    }
    await requireAncestor(opts.worktreePath, opts.baseRef, status.head, 'recovery_base_mismatch');
    if (opts.expectedHead && status.head !== opts.expectedHead) {
      throw new GitError(
        `recovery HEAD changed (${opts.expectedHead} -> ${status.head})`,
        'recovery_head_mismatch',
      );
    }
    if (status.dirty && !opts.allowDirty) {
      throw new GitError(
        `recovery worktree is dirty: ${status.dirtyFiles.join(', ')}`,
        'recovery_dirty',
      );
    }
    return status;
  }

  async removeWorktree(
    repoRoot: string,
    worktreePath: string,
    opts: { deleteBranch?: string } = {},
  ): Promise<void> {
    const status = await repoStatus(repoRoot);
    if (!status.root) return;
    await git(status.root, ['worktree', 'remove', '--force', worktreePath]).catch((e: unknown) => {
      log.warn('worktree remove failed', { worktreePath, error: String(e) });
    });
    await git(status.root, ['worktree', 'prune']).catch(() => undefined);
    if (opts.deleteBranch) {
      await git(status.root, ['branch', '-D', opts.deleteBranch]).catch(() => undefined);
    }
  }

  /** Everything the reviewer needs about what the worker actually changed. */
  async collectChanges(
    worktreePath: string,
    baseRef: string,
  ): Promise<{
    head: string;
    commits: { sha: string; subject: string }[];
    files: { path: string; added: number; removed: number }[];
    diff: string;
    diffTruncated: boolean;
    uncommitted: string[];
  }> {
    const head = await git(worktreePath, ['rev-parse', 'HEAD']);
    const logOut = await git(worktreePath, ['log', '--format=%H %s', `${baseRef}..HEAD`]);
    const commits = logOut
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));

    // Include uncommitted worker changes: agents do not always commit.
    const uncommitted = (await git(worktreePath, ['status', '--porcelain']))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const numstat = await git(worktreePath, ['diff', '--numstat', baseRef]);
    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [added = '0', removed = '0', file = ''] = line.split('\t');
        return { path: file, added: Number(added) || 0, removed: Number(removed) || 0 };
      });

    const MAX_DIFF = 220_000; // ~60k tokens; reviewer prompt caps it further
    let diff = await git(worktreePath, ['diff', baseRef]);
    const diffTruncated = diff.length > MAX_DIFF;
    if (diffTruncated)
      diff = `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated at ${MAX_DIFF} characters]`;

    return { head, commits, files, diff, diffTruncated, uncommitted };
  }

  /** Fail closed unless the candidate is a clean, optionally expected Git identity. */
  async validateCandidate(worktreePath: string, baseRef: string, expectedHead?: string) {
    const changes = await this.collectChanges(worktreePath, baseRef);
    if (changes.uncommitted.length) {
      throw new Error(`candidate has uncommitted changes: ${changes.uncommitted.join(', ')}`);
    }
    if (expectedHead && changes.head !== expectedHead) {
      throw new Error(`candidate HEAD changed after review (${expectedHead} -> ${changes.head})`);
    }
    await requireAncestor(worktreePath, baseRef, changes.head, 'candidate_base_mismatch');
    return changes;
  }

  /** Validate both repositories and prove that applying the reviewed commit is FF-only. */
  async preflightFastForward(opts: {
    targetRoot: string;
    worktreePath: string;
    baseRef: string;
    expectedHead: string;
  }): Promise<FastForwardPreflight> {
    const target = await repoStatus(opts.targetRoot);
    if (!target.isRepo || !target.root || !samePath(target.root, opts.targetRoot)) {
      throw new GitError(
        'target repository identity does not match the registered project',
        'target_identity',
      );
    }
    if (!target.head) throw new GitError('target repository has no HEAD', 'target_head_missing');
    if (!target.branch || target.branch === 'HEAD') {
      throw new GitError('target repository is in detached HEAD state', 'target_branch_unknown');
    }
    if (target.dirty) {
      throw new GitError(
        `target working tree is dirty: ${target.dirtyFiles.join(', ')}`,
        'target_dirty',
      );
    }

    const changes = await this.validateCandidate(
      opts.worktreePath,
      opts.baseRef,
      opts.expectedHead,
    );
    if ((await repositoryIdentity(target.root)) !== (await repositoryIdentity(opts.worktreePath))) {
      throw new GitError(
        'candidate does not belong to the target repository',
        'repository_mismatch',
      );
    }
    await requireAncestor(target.root, target.head, changes.head, 'target_diverged');

    return {
      targetRoot: target.root,
      targetBranch: target.branch,
      targetHead: target.head,
      candidateBase: opts.baseRef,
      candidateHead: changes.head,
    };
  }

  /** Re-runs preflight immediately before the only target mutation. */
  async fastForward(opts: {
    targetRoot: string;
    worktreePath: string;
    baseRef: string;
    expectedHead: string;
  }): Promise<FastForwardPreflight & { targetHeadAfter: string }> {
    const preflight = await this.preflightFastForward(opts);
    if (preflight.targetHead !== preflight.candidateHead) {
      await git(preflight.targetRoot, ['merge', '--ff-only', preflight.candidateHead]);
    }
    const after = await repoStatus(preflight.targetRoot);
    if (
      after.head !== preflight.candidateHead ||
      after.dirty ||
      after.branch !== preflight.targetBranch
    ) {
      throw new GitError(
        'target state did not match the reviewed candidate after fast-forward',
        'target_postcondition_failed',
      );
    }
    return { ...preflight, targetHeadAfter: after.head };
  }

  /** Commit whatever the worker left uncommitted, so the candidate is a real ref. */
  async commitPending(worktreePath: string, message: string): Promise<string | null> {
    const dirty = await git(worktreePath, ['status', '--porcelain']);
    if (!dirty.trim()) return null;
    await git(worktreePath, ['add', '-A']);
    await git(worktreePath, [
      '-c',
      'user.name=Jarvis',
      '-c',
      'user.email=jarvis@localhost',
      'commit',
      '-m',
      message,
    ]);
    return git(worktreePath, ['rev-parse', 'HEAD']);
  }

  async listWorktrees(repoRoot: string): Promise<string[]> {
    const out = await git(repoRoot, ['worktree', 'list', '--porcelain']).catch(() => '');
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
  }
}

async function repositoryIdentity(dir: string): Promise<string> {
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  return canonicalPath(path.isAbsolute(common) ? common : path.resolve(dir, common));
}

async function requireAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
  code: string,
): Promise<void> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  } catch {
    throw new GitError(`${ancestor} is not an ancestor of ${descendant}`, code);
  }
}

function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

function canonicalPath(value: string): string {
  const resolved = fs.realpathSync.native(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
