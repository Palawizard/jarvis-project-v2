import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registeredRoot } from './workspace.js';

export class GitObjectError extends Error {}

const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * The only environment a trusted object read gets: an allowlist of what Git
 * needs in order to start, so nothing this process inherited -- no `GIT_*`
 * variable a candidate build could have exported, no credential, no control
 * token -- reaches the child.
 */
const INHERITED = ['PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'];

/**
 * Read one committed blob by exact commit id, through a throwaway bare Git
 * directory the parent builds itself.
 *
 * The whole point is structural rather than a list of settings to neutralise.
 * The temporary directory contains a `HEAD`, a `config` this function wrote,
 * an empty `refs/`, and one `objects/info/alternates` entry pointing at the
 * repository's content-addressed object store. That is the entire repository
 * Git can see. There is no work tree, no index, no candidate `config`, no
 * per-worktree config, no `info/exclude`, no `info/attributes`, no `.git`
 * hooks directory and no `refs/replace`, because none of them was copied in --
 * so no value a candidate can write to any of them is an input to the bytes
 * this returns. Global and system configuration are switched off as sources
 * too, and the environment is rebuilt from the allowlist above.
 *
 * The one input that necessarily remains is the object database itself: a
 * candidate writes to it every time it commits, and Git follows an
 * `objects/info/alternates` chain transitively, so the set of stores in play is
 * not fixed either. That is not answered by excluding anything -- it is
 * answered by verifying the object id of every object read, which this function
 * does for the commit, each tree on the path, and the blob. Git's own reads are
 * not enough: it checks a commit and its root tree, but trees below the root
 * and every `cat-file blob` are returned without a signature check, and packed
 * objects are not verified at all.
 */
export function readCommittedBlob(opts: {
  /** Canonical repository the parent registered, not a candidate worktree. */
  repoRoot: string;
  commit: string;
  filePath: string;
  maxBytes: number;
}): { blobSha: string; bytes: Buffer } {
  if (!OBJECT_ID.test(opts.commit)) {
    throw new GitObjectError('commit is not an exact object id');
  }
  let alternate: string;
  try {
    alternate = objectStorePath(opts.repoRoot);
  } catch (error) {
    if (error instanceof GitObjectError) throw error;
    // A vanished or unreadable repository path must fail closed like every other
    // provenance failure, not escape as an unhandled filesystem error.
    throw new GitObjectError(
      `object store could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let gitDir: string;
  try {
    gitDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'jarvis-objects-'));
  } catch (error) {
    throw new GitObjectError(
      `temporary Git directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    try {
      fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
      fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/jarvis-object-read\n');
      fs.writeFileSync(
        path.join(gitDir, 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tbare = true\n',
      );
      fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${alternate}\n`);
    } catch (error) {
      // Planning infrastructure like every other failure here: pause the job
      // rather than let a raw filesystem error escape the stage.
      throw new GitObjectError(
        `temporary Git directory could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Walk the chain from the commit down, verifying every link. Git checks
    // object ids when it parses a commit and its root tree, but the trees
    // *below* the root are read without a signature check -- so resolving the
    // catalog with `ls-tree` would take the blob's address out of an object
    // nothing had verified, and a candidate that rewrites one subtree in place
    // chooses the bytes while every later check still agrees. Reading each
    // object and recomputing its own id is what makes the exact commit id
    // actually determine the catalog bytes.
    const commit = readVerifiedObject(gitDir, opts.commit, 'commit', 64 * 1024);
    const root = /^tree ([0-9a-f]{40})\n/.exec(commit.toString('utf8'));
    if (!root) throw new GitObjectError(`${opts.commit} has no readable root tree`);

    const segments = opts.filePath.split('/');
    let treeSha = root[1] as string;
    let blobSha = '';
    for (const [index, segment] of segments.entries()) {
      const entry = treeEntry(
        readVerifiedObject(gitDir, treeSha, 'tree', 64 * 1024 * 1024),
        segment,
      );
      if (!entry) throw new GitObjectError(`is missing at ${opts.filePath}`);
      if (index === segments.length - 1) {
        if (entry.mode !== '100644' && entry.mode !== '100755') {
          throw new GitObjectError(`is not a regular file at ${opts.filePath}`);
        }
        // Git resolves an abbreviated id, so an id short of 40 hex would still
        // name an object -- just not necessarily this one.
        if (!OBJECT_ID.test(entry.sha)) {
          throw new GitObjectError(`is not an exact object id at ${opts.filePath}`);
        }
        blobSha = entry.sha;
      } else {
        if (entry.mode !== '40000') {
          throw new GitObjectError(`is missing at ${opts.filePath}`);
        }
        treeSha = entry.sha;
      }
    }

    const size = Number(run(gitDir, ['cat-file', '-s', blobSha], 1024).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitObjectError(`${blobSha} has no readable size`);
    }
    if (size > opts.maxBytes) throw new GitObjectError('blob exceeds the byte limit');
    const bytes = run(gitDir, ['cat-file', 'blob', blobSha], opts.maxBytes + 1);
    // A short read would silently truncate the bytes the digest is taken over.
    if (bytes.length !== size) throw new GitObjectError(`${blobSha} was read incompletely`);
    verifyObjectId(bytes, 'blob', blobSha);
    return { blobSha, bytes };
  } finally {
    try {
      fs.rmSync(gitDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Losing a temporary directory must never replace the error being thrown,
      // which is the one that says why planning failed.
    }
  }
}

/**
 * Recompute an object's own id over the bytes returned and refuse a mismatch.
 * This is the check the whole module terminates on: a rewritten loose object, a
 * forged pack, a store reached through the `objects/info/alternates` chain Git
 * follows transitively, and a redirected object directory all fail here, so
 * none of them needs to be enumerated or excluded.
 */
function verifyObjectId(body: Buffer, type: 'commit' | 'tree' | 'blob', expected: string): void {
  let actual: string;
  try {
    actual = createHash('sha1').update(`${type} ${body.length}\u0000`).update(body).digest('hex');
  } catch (error) {
    // A host without SHA-1 (an OpenSSL FIPS provider) must pause the job as
    // planning infrastructure like every other failure here, not crash the stage.
    throw new GitObjectError(
      `object id could not be computed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actual !== expected) {
    throw new GitObjectError(`${expected} failed content-address verification`);
  }
}

/** Read one object's body and prove it is the object that was asked for. */
function readVerifiedObject(
  gitDir: string,
  sha: string,
  type: 'commit' | 'tree' | 'blob',
  maxBuffer: number,
): Buffer {
  if (!OBJECT_ID.test(sha)) throw new GitObjectError(`${sha} is not an exact object id`);
  const body = run(gitDir, ['cat-file', type, sha], maxBuffer);
  verifyObjectId(body, type, sha);
  return body;
}

/**
 * One entry from a raw tree object: `<mode> <name>` then NUL then the binary
 * object id. Parsed here rather than through `ls-tree` so the bytes being read
 * are the same ones the id was verified over.
 */
function treeEntry(tree: Buffer, name: string): { mode: string; sha: string } | null {
  let found: { mode: string; sha: string } | null = null;
  let offset = 0;
  while (offset < tree.length) {
    const space = tree.indexOf(0x20, offset);
    const nul = tree.indexOf(0x00, space + 1);
    // The id is 20 bytes, so the entry needs every byte through `nul + 20`.
    if (space < 0 || nul < 0 || nul + 21 > tree.length) {
      throw new GitObjectError('tree object is malformed');
    }
    const entry = tree.toString('utf8', space + 1, nul);
    if (entry === name) {
      // Git resolves a duplicated name to the first entry but checks the last
      // one out, which would let the plan and the photographed build disagree.
      if (found) throw new GitObjectError(`tree object names ${name} more than once`);
      found = {
        mode: tree.toString('utf8', offset, space),
        sha: tree.toString('hex', nul + 1, nul + 21),
      };
    }
    offset = nul + 21;
  }
  return found;
}

function run(gitDir: string, args: string[], maxBuffer: number): Buffer {
  const env: NodeJS.ProcessEnv = {
    // Older Git finds the global config through the home directory rather than
    // GIT_CONFIG_GLOBAL, so both routes are pointed at the throwaway directory.
    HOME: gitDir,
    USERPROFILE: gitDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: path.join(gitDir, 'absent-config'),
    GIT_CONFIG_GLOBAL: path.join(gitDir, 'absent-config'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  for (const key of INHERITED) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  try {
    // The single Git spawn in this module. It deliberately shares nothing with
    // the worktree shape, which pins a work tree and inherits an environment
    // this read must not have.
    // eslint-disable-next-line no-restricted-syntax
    return execFileSync('git', ['--git-dir', gitDir, ...args], {
      cwd: gitDir,
      env,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOBUFS' || /maxBuffer/i.test(detail)) {
      throw new GitObjectError('blob exceeds the byte limit');
    }
    throw new GitObjectError(`Git object read failed: ${detail}`);
  }
}

/**
 * The repository's object database, resolved from the filesystem alone. Asking
 * Git would mean running it inside the repository whose configuration this
 * whole module exists to keep out of the answer.
 */
function objectStorePath(repoRoot: string): string {
  const root = registeredRoot(repoRoot);
  if (!root) throw new GitObjectError(`${repoRoot} is not a Git checkout`);
  const dotGit = path.join(root, '.git');
  let gitDir = dotGit;
  if (fs.statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!pointer) throw new GitObjectError(`${root} has a malformed worktree pointer`);
    gitDir = path.resolve(root, pointer[1] as string);
    if (gitDir.includes('\n') || gitDir.includes('\r')) {
      throw new GitObjectError(`${root} has a malformed worktree pointer`);
    }
  }
  // A linked worktree's own directory holds only its HEAD and index; the shared
  // object store lives in the common directory it names.
  const commonFile = path.join(gitDir, 'commondir');
  let common = gitDir;
  if (fs.existsSync(commonFile)) {
    const pointer = fs.readFileSync(commonFile, 'utf8').trim();
    // An interior newline would inject a second alternates line of the
    // candidate's choosing. The hash chain above covers what that could reach,
    // but there is no reason to hand it the extra store.
    if (pointer.includes('\n') || pointer.includes('\r')) {
      throw new GitObjectError('commondir pointer is malformed');
    }
    common = path.resolve(gitDir, pointer);
  }
  const objects = path.join(common, 'objects');
  if (!fs.existsSync(objects)) throw new GitObjectError(`${repoRoot} has no object store`);
  return objects;
}
