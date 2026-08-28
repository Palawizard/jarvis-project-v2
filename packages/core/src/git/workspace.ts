import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { untrustedProcessEnv } from '../agents/spawn.js';
import { createLogger } from '../logger.js';

const exec = promisify(execFile);
const log = createLogger('git');
const disabledHooksPath = path.join(process.cwd(), `.jarvis-no-git-hooks-${randomUUID()}`);
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
// Git refuses NUL/dev/null as an exclude file, so point it at a path that
// simply does not exist: a missing excludes file contributes no patterns.
const disabledExcludesPath = path.join(process.cwd(), `.jarvis-no-git-excludes-${randomUUID()}`);
export const trustedGitArgs = (cwd: string, args: string[]) => [
  '--no-replace-objects',
  `--work-tree=${fs.realpathSync.native(path.resolve(cwd))}`,
  '-c',
  'core.bare=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  `core.hooksPath=${disabledHooksPath}`,
  '-c',
  `core.attributesFile=${NULL_DEVICE}`,
  // Untracked work hidden from status is unreviewed work. `core.excludesFile`
  // is candidate-writable and never appears in a reviewed diff, so it is
  // pinned away here; `<git-common-dir>/info/exclude` has no such switch and is
  // handled by hiddenExcludedFiles below.
  '-c',
  `core.excludesFile=${disabledExcludesPath}`,
  ...args,
];

/**
 * Git runs candidate-reachable code of its own: a `filter` attribute bound to a
 * tracked path makes `status`, `add` and `checkout` execute the configured
 * driver. Hooks and fsmonitor are disabled above, and a candidate that plants a
 * filter anyway already holds a shell in its worktree -- but it must not also
 * inherit this process's environment, which carries provider credentials and
 * control tokens the agent env allowlist exists to withhold.
 */
export const trustedGitEnv = (): NodeJS.ProcessEnv => ({
  ...untrustedProcessEnv(),
  GIT_TERMINAL_PROMPT: '0',
  // The one attribute source `core.attributesFile` cannot disable. Writing it
  // needs administrator rights, so this is not a candidate-reachable path --
  // but the guarantee should be true rather than nearly true.
  GIT_ATTR_NOSYSTEM: '1',
});

/**
 * The one synchronous shape for spawning Git. Two consecutive reviews found the
 * same hazard re-introduced by a caller that built its own invocation, so the
 * trusted arguments and the sanitized environment are applied here rather than
 * left for each call site to remember. Returns raw bytes: callers that want
 * text decode it themselves, and callers reading blobs must not.
 */
export function trustedGitSync(
  cwd: string,
  args: string[],
  maxBuffer = 32 * 1024 * 1024,
  input?: string | Buffer,
): Buffer {
  return execFileSync('git', trustedGitArgs(cwd, args), {
    cwd,
    env: trustedGitEnv(),
    ...(input === undefined ? {} : { input }),
    maxBuffer,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** The asynchronous counterpart, so no caller has to assemble the shape itself. */
export async function trustedGitAsync(
  cwd: string,
  args: string[],
  maxBuffer = 32 * 1024 * 1024,
): Promise<string> {
  const { stdout } = await exec('git', trustedGitArgs(cwd, args), {
    cwd,
    env: trustedGitEnv(),
    maxBuffer,
  });
  return stdout.trim();
}

/**
 * Git's empty tree. Passing it as the attribute source means no worktree
 * `.gitattributes` can bind a `filter` driver for that one invocation. Only
 * safe for reads: it would also disable legitimate eol normalisation, so it
 * must never be used for `add` or `checkout`.
 *
 * Requires Git >= 2.40 and a SHA-1 repository. Neither holds on an exotic host,
 * and there every guarded read fails rather than silently losing the guard:
 * planning pauses as infrastructure and activation reports inspection required.
 */
export const NO_TREE_ATTRIBUTES = '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
    const { stdout } = await exec('git', trustedGitArgs(cwd, args), {
      cwd,
      env: trustedGitEnv(),
      maxBuffer: 32 * 1024 * 1024,
    });
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
    const { stdout } = await exec('git', trustedGitArgs(cwd, args), {
      cwd,
      env: trustedGitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(`git ${args[0]} failed`, 'git_command_failed', err.stderr || err.message);
  }
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', trustedGitArgs(cwd, args), {
      cwd,
      env: trustedGitEnv(),
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
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

/**
 * Resolves the registered checkout that owns `dir` by walking up to the nearest
 * `.git` entry, which is a directory in a primary checkout and a file in a
 * linked worktree.
 *
 * Git cannot answer this question for us. `core.worktree` is candidate-writable
 * and moves Git's idea of the work tree, and the trusted invocation pins
 * `--work-tree` precisely so it cannot, which leaves `rev-parse --show-toplevel`
 * echoing back whatever it was handed. Reading the filesystem keeps the
 * identity checks that compare this root against the caller's expected path
 * meaningful, and keeps a project registered at a subdirectory resolving to the
 * repository that actually contains it.
 */
export function registeredRoot(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function repoStatus(dir: string): Promise<RepoStatus> {
  if (!fs.existsSync(dir)) {
    return { isRepo: false, root: null, branch: null, head: null, dirty: false, dirtyFiles: [] };
  }
  const root = registeredRoot(dir);
  if (!root) {
    return { isRepo: false, root: null, branch: null, head: null, dirty: false, dirtyFiles: [] };
  }
  try {
    // A `.git` entry is not proof of a usable repository; make Git confirm it
    // before any caller treats the rest of this record as authoritative.
    await git(root, ['rev-parse', '--git-dir']);
  } catch {
    return { isRepo: false, root: null, branch: null, head: null, dirty: false, dirtyFiles: [] };
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  const head = await git(root, ['rev-parse', 'HEAD']).catch(() => null);
  // A failed status command is never evidence of a clean tree. Mutation callers
  // must fail closed rather than risk overwriting work Git could not inspect.
  const porcelain = await git(root, [
    NO_TREE_ATTRIBUTES,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  const dirtyFiles = porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const hidden of await hiddenExcludedFiles(root)) {
    // Reported like an untracked entry so every existing dirty check sees it.
    if (!dirtyFiles.includes(`?? ${hidden}`)) dirtyFiles.push(`?? ${hidden}`);
  }
  return {
    isRepo: true,
    root: path.resolve(root),
    branch,
    head,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

/**
 * Untracked files hidden behind `<git-common-dir>/info/exclude`.
 *
 * `.gitignore` is tracked, so hiding work behind it changes a reviewed diff.
 * `info/exclude` is neither tracked nor per-worktree: a candidate can write it
 * from its own job worktree and silently drop planted files out of
 * `status --untracked-files=all`, which every clean-tree check depends on.
 * Git offers no switch to disable it, so the patterns are applied deliberately
 * to find what they are concealing and the results are reported as dirty.
 *
 * Git's own default file contains only comments, so an untouched repository
 * costs one `existsSync` and one small read.
 */
async function hiddenExcludedFiles(root: string): Promise<string[]> {
  let exclude: string;
  try {
    const common = await git(root, ['rev-parse', '--git-common-dir']);
    exclude = path.resolve(root, common, 'info', 'exclude');
    const patterns = fs
      .readFileSync(exclude, 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    if (!patterns) return [];
  } catch {
    // No exclude file, or an unreadable one: nothing is being hidden by it.
    return [];
  }
  const hidden = await git(root, [
    NO_TREE_ATTRIBUTES,
    'ls-files',
    '--others',
    '--ignored',
    `--exclude-from=${exclude}`,
  ]);
  return hidden
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
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
        if (existing.head !== baseRef) {
          throw new GitError(
            `uncheckpointed planning worktree HEAD changed (${baseRef} -> ${existing.head})`,
            'recovery_head_mismatch',
          );
        }
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
      '--no-ext-diff',
      '--no-textconv',
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
    const expectedHead = opts.expectedHead ?? opts.baseRef;
    if (status.head !== expectedHead) {
      throw new GitError(
        `recovery HEAD changed (${expectedHead} -> ${status.head})`,
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
    deleted: string[];
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
    const uncommitted = (await git(worktreePath, [NO_TREE_ATTRIBUTES, 'status', '--porcelain']))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Keep paths literal and unambiguous. In particular, Git's default rename
    // display can synthesize "{old => new}" paths that do not exist and must
    // never become Visual-QA catalog inputs.
    const numstat = await gitRaw(worktreePath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '--no-renames',
      '-z',
      baseRef,
    ]);
    // Deletions must be distinguishable: a removed view is a changed rendered
    // path that no candidate catalog can legitimately still map.
    const nameStatus = await gitRaw(worktreePath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '--no-renames',
      '-z',
      baseRef,
    ]);
    const records = nameStatus.split('\0').filter(Boolean);
    const deleted: string[] = [];
    for (let index = 0; index + 1 < records.length; index += 2) {
      if (records[index]?.startsWith('D')) deleted.push(records[index + 1] as string);
    }

    const files = numstat
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const firstTab = record.indexOf('\t');
        const secondTab = record.indexOf('\t', firstTab + 1);
        const added = record.slice(0, firstTab);
        const removed = record.slice(firstTab + 1, secondTab);
        return {
          path: record.slice(secondTab + 1),
          added: Number(added) || 0,
          removed: Number(removed) || 0,
        };
      });

    const MAX_DIFF = 220_000; // ~60k tokens; reviewer prompt caps it further
    let diff = await git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', baseRef]);
    const diffTruncated = diff.length > MAX_DIFF;
    if (diffTruncated)
      diff = `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated at ${MAX_DIFF} characters]`;

    return { head, commits, files, deleted, diff, diffTruncated, uncommitted };
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

  /** Preserve validation-only provenance: exact materialized HEAD and source tree, no residue. */
  async validateMaterializedCandidate(
    worktreePath: string,
    baseRef: string,
    expectedHead: string,
    sourceRef: string,
  ) {
    const changes = await this.validateCandidate(worktreePath, baseRef, expectedHead);
    const [candidateTree, sourceTree] = await Promise.all([
      git(worktreePath, ['rev-parse', `${changes.head}^{tree}`]),
      git(worktreePath, ['rev-parse', `${sourceRef}^{tree}`]),
    ]);
    if (candidateTree !== sourceTree) {
      throw new GitError(
        'validation-only candidate no longer matches its pinned source tree',
        'candidate_tree_mismatch',
      );
    }
    return changes;
  }

  /** Validate both repositories and prove that applying the reviewed commit is FF-only. */
  async preflightFastForward(opts: {
    targetRoot: string;
    worktreePath: string;
    baseRef: string;
    expectedHead: string;
  }): Promise<FastForwardPreflight> {
    if (!/^[0-9a-f]{40}$/.test(opts.expectedHead)) {
      throw new GitError('candidate HEAD must be an exact SHA', 'candidate_head_invalid');
    }
    // `.git/info/attributes` is shared by linked worktrees and remains active
    // even with an explicit tree attribute source. Reject it before any status
    // or candidate inspection can bind a configured driver.
    await rejectSharedAttributes(opts.targetRoot);
    await rejectSharedAttributes(opts.worktreePath);
    // Inspect committed attribute data before status/diff: those commands can
    // themselves invoke a required checkout filter if rejection comes later.
    const targetHeadBeforeInspection = await git(opts.targetRoot, ['rev-parse', 'HEAD']);
    rejectCheckoutFilters(opts.targetRoot, targetHeadBeforeInspection);
    rejectCheckoutFilters(opts.targetRoot, opts.expectedHead);
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
    // Bind the already-inspected names to the identities validation established.
    if (target.head !== targetHeadBeforeInspection || changes.head !== opts.expectedHead) {
      throw new GitError(
        'candidate identity changed during application preflight',
        'identity_race',
      );
    }

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
      await rejectSharedAttributes(preflight.targetRoot);
      await git(preflight.targetRoot, [
        `--attr-source=${preflight.candidateHead}`,
        'merge',
        '--ff-only',
        preflight.candidateHead,
      ]);
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
    const dirty = await git(worktreePath, [NO_TREE_ATTRIBUTES, 'status', '--porcelain']);
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

/** Refuse every executable checkout filter in both trees before moving HEAD. */
function rejectCheckoutFilters(repo: string, sha: string): void {
  const paths = trustedGitSync(repo, ['ls-tree', '-r', '-z', '--name-only', sha], 64 * 1024 * 1024);
  const attributes = trustedGitSync(
    repo,
    [`--attr-source=${sha}`, 'check-attr', '-z', '--stdin', 'filter'],
    64 * 1024 * 1024,
    paths,
  )
    .toString('utf8')
    .split('\0');
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const [file, , value] = attributes.slice(index, index + 3);
    if (value !== 'unspecified' && value !== 'unset') {
      throw new GitError(`checkout filter is prohibited for ${file}`, 'checkout_filter_prohibited');
    }
  }
}

async function rejectSharedAttributes(repo: string): Promise<void> {
  const common = await git(repo, ['rev-parse', '--git-common-dir']);
  if (fs.existsSync(path.resolve(repo, common, 'info', 'attributes'))) {
    throw new GitError(
      'shared Git info attributes are prohibited during candidate application',
      'shared_attributes_prohibited',
    );
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
