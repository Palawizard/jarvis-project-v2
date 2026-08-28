#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign as signBytes,
  timingSafeEqual,
} from 'node:crypto';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').trim();
const WINDOWS_JOB_RUNNER =
  process.platform === 'win32'
    ? Buffer.from(
        fs.readFileSync(new URL('./windows-job-runner.ps1', import.meta.url), 'utf8'),
        'utf16le',
      ).toString('base64')
    : '';
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NPM_CONFIG_USERCONFIG',
];
const SECRET_ENV_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_KEY|PRIVATE_KEY)(?:_|$)/i;
const SECRET_PATTERNS = [
  /\bJarvis human pairing token[^\r\n:]*:\s*[^\s]+/gi,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/gi,
];

/** Owned by the supervisor alone; a config may never pre-set or shadow them. */
const SUPERVISOR_OWNED_ENV = new Set([
  'JARVIS_SUPERVISED',
  'JARVIS_UPGRADE_REQUEST_PATH',
  'JARVIS_UPGRADE_SOCKET',
  'JARVIS_UPGRADE_TOKEN_HASH',
  'JARVIS_CANDIDATE_RUNTIME',
  'JARVIS_RUNTIME_NONCE',
]);
/**
 * Trust-boundary code that this process loaded at startup. An activation that
 * changes it does not change the running supervisor — see the drift note in
 * docs/self-development-and-visual-qa.md.
 */
const TRUST_BOUNDARY_FILES = ['supervisor.mjs', 'dev.mjs', 'windows-job-runner.ps1'];
const DISABLED_GIT_HOOKS = path.join(os.tmpdir(), `.jarvis-no-git-hooks-${randomUUID()}`);
// Git refuses NUL and /dev/null as an exclude file, so point it at a path that
// simply does not exist: a missing excludes file contributes no patterns.
const DISABLED_GIT_EXCLUDES = path.join(os.tmpdir(), `.jarvis-no-git-excludes-${randomUUID()}`);
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
/**
 * Git's empty tree: as an attribute source it means no worktree `.gitattributes`
 * can bind a `filter` driver for that invocation. Reads only -- `merge` and
 * `reset` need real attributes, and they already pin a specific commit instead.
 * Requires Git >= 2.40 and a SHA-1 repository, both of which activation already
 * fails closed on if absent.
 */
const NO_TREE_ATTRIBUTES = '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function trustedGitArgs(repo, args) {
  return [
    '--no-replace-objects',
    '--no-pager',
    `--work-tree=${fs.realpathSync(repo)}`,
    '-c',
    'core.bare=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'status.showUntrackedFiles=all',
    '-c',
    `core.hooksPath=${DISABLED_GIT_HOOKS}`,
    '-c',
    `core.attributesFile=${NULL_DEVICE}`,
    // Untracked work hidden from status is unreviewed work, and a candidate
    // build can write this config. `info/exclude` has no switch and is probed
    // by hiddenExcludedFiles instead.
    '-c',
    `core.excludesFile=${DISABLED_GIT_EXCLUDES}`,
    ...args,
  ];
}

/**
 * A `filter` attribute makes Git execute a configured driver, and the candidate
 * build can write `.git/config` in the live repository. Inheriting this
 * process's environment would hand that driver the operator's whole shell, so
 * Git gets the same allowlist every other untrusted command gets. The allowlist
 * carries no `GIT_*`, which also drops `GIT_ATTR_SOURCE` and friends.
 */
function trustedGitEnv() {
  return {
    ...untrustedEnv(),
    GIT_TERMINAL_PROMPT: '0',
    // The system attributes file is the one source `core.attributesFile` cannot
    // disable. It needs administrator rights to write, but claiming every
    // source is closed should be true rather than nearly true.
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function untrustedEnv(extra = {}) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (!SECRET_ENV_NAME.test(key)) env[key] = value;
  }
  return env;
}

function redactSecrets(value) {
  let output = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted:secret]');
  return output;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function signedEvidence(evidence, privateKey) {
  return {
    ...evidence,
    evidenceSignature: signBytes(
      null,
      Buffer.from(stableJson(evidence), 'utf8'),
      privateKey,
    ).toString('base64'),
  };
}

function gitRaw(repo, args, input) {
  // eslint-disable-next-line no-restricted-syntax -- this is the supervisor's own copy of the trusted shape
  return execFileSync('git', trustedGitArgs(repo, args), {
    cwd: repo,
    env: trustedGitEnv(),
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function git(repo, args) {
  return clean(gitRaw(repo, args).toString('utf8'));
}

function rejectCheckoutFilters(repo, sha) {
  const paths = gitRaw(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
  const attributes = gitRaw(
    repo,
    [`--attr-source=${sha}`, 'check-attr', '-z', '--stdin', 'filter'],
    paths,
  )
    .toString('utf8')
    .split('\0');
  for (let index = 0; index + 2 < attributes.length; index += 3) {
    const [file, , value] = attributes.slice(index, index + 3);
    if (value !== 'unspecified' && value !== 'unset') {
      throw new Error(`checkout filter is prohibited for ${file}`);
    }
  }
}

function infoAttributes(repo) {
  const commonDir = git(repo, ['rev-parse', '--git-common-dir']);
  return path.join(path.resolve(repo, commonDir), 'info', 'attributes');
}

function rejectSharedAttributes(repo) {
  if (fs.existsSync(infoAttributes(repo))) {
    throw new Error('shared Git info attributes are prohibited during activation');
  }
}

function quarantineSharedAttributes(repo, destination) {
  const source = infoAttributes(repo);
  if (fs.existsSync(source)) fs.renameSync(source, destination);
}

function infoExclude(repo) {
  const commonDir = git(repo, ['rev-parse', '--git-common-dir']);
  return path.join(path.resolve(repo, commonDir), 'info', 'exclude');
}

/**
 * Preflight requires a clean tree and `clean` refuses concealed files, so
 * anything `info/exclude` is hiding by the time the build has run was planted
 * by that build. Move the concealment and what it concealed aside, so the
 * candidate's own residue cannot block a rollback that is still possible.
 * Files are renamed into the quarantine, never deleted.
 */
function quarantinePlantedExcludes(repo, request) {
  const hidden = hiddenExcludedFiles(repo);
  if (hidden.length === 0) return;
  const source = infoExclude(repo);
  if (fs.existsSync(source)) {
    fs.renameSync(source, `${request.resultPath}.${randomUUID()}.candidate-info-exclude`);
  }
  const root = path.resolve(repo);
  for (const file of hidden) {
    const from = path.resolve(root, file);
    // Never follow a concealed path back out of the repository.
    if (from !== root && !from.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, `${request.resultPath}.${randomUUID()}.candidate-hidden-file`);
  }
  const remaining = hiddenExcludedFiles(repo);
  if (remaining.length > 0) {
    throw new Error(`concealed candidate files remain: ${remaining.join(', ')}`);
  }
}

/**
 * Build commands run candidate-authored code. `core.attributesFile` only
 * neutralises the *global* attributes file, so a build that writes
 * `.git/info/attributes` can still bind a `required` filter driver to a tracked
 * path and make every later `git status` fatal -- or execute the driver.
 * Preflight rejects a pre-existing file, so anything here was planted by the
 * build and is quarantined before the next Git command reads it.
 */
function quarantinePlantedAttributes(repo, request, { bestEffort = false } = {}) {
  try {
    quarantineSharedAttributes(
      repo,
      `${request.resultPath}.${randomUUID()}.candidate-info-attributes`,
    );
    // Same residue, different lever: a build can also hide what it planted from
    // every clean-tree check by writing `info/exclude`.
    quarantinePlantedExcludes(repo, request);
    // A rename that silently failed to remove the file would otherwise bless an
    // activation that leaves candidate-controlled attributes in the live repo.
    rejectSharedAttributes(repo);
  } catch (error) {
    // Only the activation catch tolerates this: it runs before the guarded state
    // read, so a repository too broken to locate its own Git directory must
    // still reach that read rather than throw out of the failure path.
    if (!bestEffort) throw error;
  }
}

/**
 * Reading repository state must never throw out of the activation failure path:
 * losing the exception there would kill the supervisor with the transaction
 * still marked processing and no signed evidence written at all.
 */
function safeState(repo) {
  try {
    return state(repo);
  } catch (error) {
    return {
      head: null,
      branch: null,
      clean: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Untracked files a candidate build hid behind `<git-common-dir>/info/exclude`.
 * `.gitignore` is tracked so hiding work there changes a reviewed diff, but
 * `info/exclude` is neither tracked nor per-worktree and Git offers no switch
 * to disable it. Apply its patterns deliberately to see what they conceal.
 */
function hiddenExcludedFiles(repo) {
  const exclude = path.resolve(
    repo,
    git(repo, ['rev-parse', '--git-common-dir']),
    'info',
    'exclude',
  );
  let contents;
  try {
    contents = fs.readFileSync(exclude, 'utf8');
  } catch {
    return [];
  }
  const patterns = contents
    .split(/\r?\n/)
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (!patterns) return [];
  return git(repo, [
    NO_TREE_ATTRIBUTES,
    'ls-files',
    '--others',
    '--ignored',
    `--exclude-from=${exclude}`,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function state(repo) {
  // `--work-tree` is pinned to `repo` by trustedGitArgs, so every read below
  // describes the registered checkout even when a candidate build left a
  // `core.worktree` pointing at a clean decoy.
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    branch: git(repo, ['symbolic-ref', '--short', 'HEAD']),
    // Runs immediately after the candidate build, whose code executes with this
    // repository as its cwd: it must not be able to bind a driver to this read,
    // nor hide what it left behind from it.
    clean:
      git(repo, [NO_TREE_ATTRIBUTES, 'status', '--porcelain=v1', '--untracked-files=all']) === '' &&
      hiddenExcludedFiles(repo).length === 0,
  };
}

function validateProcess(name, spec) {
  if (!spec || typeof spec.executable !== 'string' || !spec.executable.trim()) {
    throw new Error(`${name}.executable is required`);
  }
  if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) {
    throw new Error(`${name}.args must be an array of strings`);
  }
  if (
    spec.env !== undefined &&
    (typeof spec.env !== 'object' ||
      spec.env === null ||
      !Object.values(spec.env).every((value) => typeof value === 'string'))
  ) {
    throw new Error(`${name}.env values must be strings`);
  }
  return { executable: spec.executable, args: spec.args, env: spec.env ?? {} };
}

function validateHealthUrl(value) {
  const health = new URL(value);
  if (
    health.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(health.hostname) ||
    health.pathname !== '/health'
  ) {
    throw new Error('healthUrl must be a loopback http:// URL ending in /health');
  }
  return health.href;
}

function outsideRepository(repo, file, name) {
  const resolved = path.resolve(file);
  const relative = path.relative(repo, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(`${name} must be outside the target repository`);
  }
  return resolved;
}

/**
 * Non-secret operational configuration the operator wants the supervised Jarvis
 * to keep (provider selection, JARVIS_HOME, binary overrides…). Children still
 * get an otherwise bare platform environment.
 */
function validateRuntimeEnv(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('runtimeEnv must be an object');
  }
  const env = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error('runtimeEnv values must be strings');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid runtimeEnv name: ${name}`);
    }
    if (SECRET_ENV_NAME.test(name) || SUPERVISOR_OWNED_ENV.has(name)) {
      throw new Error(`runtimeEnv must not carry ${name}`);
    }
    env[name] = value;
  }
  return env;
}

function trustBoundaryDigest(repo) {
  const digest = createHash('sha256');
  for (const name of TRUST_BOUNDARY_FILES) {
    try {
      digest.update(fs.readFileSync(path.join(repo, 'scripts', name)));
    } catch {
      digest.update(`missing:${name}`);
    }
  }
  return digest.digest('hex');
}

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo = fs.realpathSync(raw.repository);
  // Asking Git would only echo the pinned `--work-tree` back. A registered
  // checkout is the directory that actually holds the `.git` entry.
  if (!fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`repository must be the Git root: ${repo}`);
  }
  if (!/^[0-9a-f]{64}$/.test(raw.activationTokenHash ?? '')) {
    throw new Error('activationTokenHash must be a lowercase SHA-256 hash');
  }
  return {
    repository: repo,
    requestFile: outsideRepository(repo, raw.requestFile, 'requestFile'),
    healthUrl: validateHealthUrl(raw.healthUrl),
    startCommand: validateProcess('startCommand', raw.startCommand),
    buildCommand: validateProcess('buildCommand', raw.buildCommand),
    activationTokenHash: raw.activationTokenHash,
    runtimeEnv: validateRuntimeEnv(raw.runtimeEnv),
    pollMs: Math.max(25, Number(raw.pollMs) || 250),
    healthTimeoutMs: Math.max(250, Number(raw.healthTimeoutMs) || 30_000),
    commandTimeoutMs: Math.max(1_000, Number(raw.commandTimeoutMs) || 10 * 60_000),
    once: raw.once === true,
  };
}

function validateRequest(raw, config) {
  if (raw?.approved !== true || raw.approvedBy !== 'user') {
    throw new Error('activation request is not explicitly user-approved');
  }
  if (typeof raw.activationToken !== 'string' || raw.activationToken.length < 32) {
    throw new Error('activation request is missing the out-of-band human token');
  }
  const expected = Buffer.from(config.activationTokenHash, 'hex');
  const supplied = createHash('sha256').update(raw.activationToken, 'utf8').digest();
  if (!timingSafeEqual(supplied, expected)) {
    throw new Error('activation request human token is invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.transactionId ?? '')) {
    throw new Error('transactionId must contain only letters, numbers, _ or -');
  }
  if (!/^[0-9a-f]{40}$/.test(raw.previousSha ?? '')) {
    throw new Error('previousSha must be a full lowercase Git SHA');
  }
  if (!/^[0-9a-f]{40}$/.test(raw.candidateSha ?? '')) {
    throw new Error('candidateSha must be a full lowercase Git SHA');
  }
  if (typeof raw.branch !== 'string' || !raw.branch.trim()) throw new Error('branch is required');
  if (fs.realpathSync(raw.repository) !== config.repository) {
    throw new Error('activation repository does not match supervisor configuration');
  }
  if (!/^refs\/jarvis\/rollback\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.rollbackRef ?? '')) {
    throw new Error('rollbackRef must be under refs/jarvis/rollback/');
  }
  if (typeof raw.resultPath !== 'string' || !raw.resultPath.trim()) {
    throw new Error('resultPath is required');
  }
  if (typeof raw.evidencePrivateKey !== 'string') {
    throw new Error('activation request is missing its one-shot evidence key');
  }
  const evidencePrivateKey = createPrivateKey(raw.evidencePrivateKey);
  if (evidencePrivateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('activation evidence key must be Ed25519');
  }
  const healthUrl = validateHealthUrl(raw.healthUrl);
  const buildCommand = validateProcess('buildCommand', raw.buildCommand);
  const startCommand = validateProcess('startCommand', raw.startCommand);
  if (healthUrl !== config.healthUrl) throw new Error('healthUrl does not match supervisor config');
  if (JSON.stringify(buildCommand) !== JSON.stringify(config.buildCommand)) {
    throw new Error('buildCommand does not match supervisor config');
  }
  if (JSON.stringify(startCommand) !== JSON.stringify(config.startCommand)) {
    throw new Error('startCommand does not match supervisor config');
  }
  return {
    transactionId: raw.transactionId,
    repository: config.repository,
    branch: raw.branch,
    previousSha: raw.previousSha,
    candidateSha: raw.candidateSha,
    rollbackRef: raw.rollbackRef,
    healthUrl,
    buildCommand,
    startCommand,
    resultPath: outsideRepository(config.repository, raw.resultPath, 'resultPath'),
    evidencePrivateKey,
  };
}

function preflight(request) {
  rejectSharedAttributes(request.repository);
  const current = state(request.repository);
  if (!current.clean) throw new Error('target repository is dirty');
  if (current.branch !== request.branch) {
    throw new Error(`target branch is ${current.branch}, expected ${request.branch}`);
  }
  if (current.head !== request.previousSha) {
    throw new Error(`target HEAD is ${current.head}, expected ${request.previousSha}`);
  }
  const candidate = git(request.repository, [
    'rev-parse',
    '--verify',
    `${request.candidateSha}^{commit}`,
  ]);
  if (candidate !== request.candidateSha) throw new Error('candidate identity is not exact');
  try {
    git(request.repository, [
      'merge-base',
      '--is-ancestor',
      request.previousSha,
      request.candidateSha,
    ]);
  } catch {
    throw new Error('candidate does not fast-forward from the expected current SHA');
  }
  rejectCheckoutFilters(request.repository, request.previousSha);
  rejectCheckoutFilters(request.repository, request.candidateSha);
  return current;
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await waitForExit(killer, 5_000);
  } else {
    try {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  if (!(await waitForExit(child, 3_000))) {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await waitForExit(child, 1_000);
  }
}

async function spawnProcess(spec, repo, supervised, stdio = 'inherit', runtimeEnv = {}) {
  const env = {
    ...untrustedEnv({ ...runtimeEnv, ...spec.env }),
    ...(supervised
      ? {
          JARVIS_SUPERVISED: '1',
          JARVIS_UPGRADE_REQUEST_PATH: supervised.requestFile,
          JARVIS_UPGRADE_SOCKET: supervised.upgradeSocket,
          JARVIS_UPGRADE_TOKEN_HASH: supervised.activationTokenHash,
        }
      : {}),
  };
  // The wrapper reads its target from a private short-lived file; stdin stays
  // the contained process's own channel. Mirrors spawnContained in @jarvis/core.
  const specPath =
    process.platform === 'win32'
      ? path.join(os.tmpdir(), `jarvis-contained-${randomUUID()}.json`)
      : null;
  const removeSpec = () => {
    if (specPath) {
      try {
        fs.rmSync(specPath, { force: true });
      } catch {
        /* the wrapper deletes it as soon as it has read it */
      }
    }
  };
  if (specPath) {
    fs.writeFileSync(
      specPath,
      JSON.stringify({ executable: spec.executable, args: spec.args, cwd: repo, shell: false }),
      { mode: 0o600 },
    );
  }
  const child =
    process.platform === 'win32'
      ? spawn(
          path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            WINDOWS_JOB_RUNNER,
          ],
          {
            cwd: repo,
            // Bootstrap-only; the wrapper drops it before creating the target.
            env: { ...env, JARVIS_CONTAINED_SPEC_PATH: specPath },
            stdio: Array.isArray(stdio)
              ? ['pipe', stdio[1] ?? 'inherit', stdio[2] ?? 'inherit']
              : ['pipe', stdio, stdio],
            shell: false,
            windowsHide: true,
          },
        )
      : spawn(spec.executable, spec.args, {
          cwd: repo,
          env,
          stdio,
          shell: false,
          detached: true,
          windowsHide: true,
        });
  if (process.platform === 'win32') {
    child.once('error', removeSpec);
    child.once('close', removeSpec);
    child.stdin.on('error', () => {
      /* spawn/early-exit errors are reported on the child itself */
    });
    // Nothing here writes a prompt, but the target still expects EOF on stdin.
    child.stdin.end();
  }
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    removeSpec();
    throw error;
  }
  return child;
}

async function runBuild(config) {
  const started = Date.now();
  const child = await spawnProcess(
    config.buildCommand,
    config.repository,
    null,
    ['ignore', 'pipe', 'pipe'],
    config.runtimeEnv,
  );
  let output = '';
  const append = (chunk) => {
    output = redactSecrets(`${output}${chunk}`).slice(-8_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopChild(child);
  }, config.commandTimeoutMs);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error: error.message }));
    child.once('close', (code) => resolve({ code }));
  });
  clearTimeout(timeout);
  await stopChild(child);
  if (timedOut) throw new Error(`build timed out after ${config.commandTimeoutMs}ms`);
  if (result.error) throw new Error(`build could not start: ${result.error}`);
  if (result.code !== 0) throw new Error(`build exited with code ${result.code}: ${output.trim()}`);
  return { durationMs: Date.now() - started, output: output.trim() };
}

async function waitForHealth(config, child, expectedSha) {
  const deadline = Date.now() + config.healthTimeoutMs;
  let lastError = 'healthcheck did not run';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Jarvis child exited before healthcheck (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (
        response.ok &&
        (body.status === 'ok' || body.ok === true) &&
        body.commit === expectedSha
      ) {
        return { checkedAt: new Date().toISOString(), body };
      }
      lastError = `HTTP ${response.status}; commit=${String(body.commit ?? 'missing')}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(config.pollMs);
  }
  throw new Error(`healthcheck failed: ${lastError}`);
}

function requireState(repo, head) {
  const current = state(repo);
  if (!current.clean || current.head !== head) {
    throw new Error(
      `repository changed during activation (HEAD ${current.head}, clean=${current.clean})`,
    );
  }
  return current;
}

async function startHealthy(config, sha) {
  const child = await spawnProcess(
    config.startCommand,
    config.repository,
    config,
    'inherit',
    config.runtimeEnv,
  );
  try {
    return { child, health: await waitForHealth(config, child, sha) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function createRequestInbox(config) {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\jarvis-upgrade-${randomUUID()}`
      : `${config.requestFile}.${randomUUID()}.sock`;
  const queued = [];
  const waiting = [];
  const sockets = new Set();
  const deliver = (message) => {
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let pending = '';
    let delivered = false;
    let acknowledge;
    socket.on('data', (chunk) => {
      pending += chunk;
      if (pending.length > 64 * 1024) {
        socket.end(
          `${JSON.stringify({ accepted: false, error: 'activation request is too large' })}\n`,
        );
        return;
      }
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!delivered) {
          delivered = true;
          deliver({
            raw: line,
            reject(error) {
              socket.end(`${JSON.stringify({ accepted: false, error })}\n`);
            },
            accept() {
              return new Promise((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('activation acknowledgement timed out')),
                  5_000,
                );
                acknowledge = () => {
                  clearTimeout(timer);
                  resolve();
                };
                socket.write(`${JSON.stringify({ accepted: true })}\n`);
              });
            },
          });
        } else if (line === 'ack') {
          acknowledge?.();
          socket.end();
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  return {
    endpoint,
    next(timeoutMs) {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => {
        const receive = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(receive);
          if (index >= 0) waiting.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        waiting.push(receive);
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true });
    },
  };
}

async function activate(config, request, currentChild) {
  const runtime = {
    ...config,
    healthUrl: request.healthUrl,
    buildCommand: request.buildCommand,
    startCommand: request.startCommand,
  };
  const evidence = {
    transactionId: request.transactionId,
    repository: request.repository,
    branch: request.branch,
    previousSha: request.previousSha,
    candidateSha: request.candidateSha,
    rollbackRef: request.rollbackRef,
    healthUrl: request.healthUrl,
    buildCommand: request.buildCommand,
    startCommand: request.startCommand,
    resultPath: request.resultPath,
    activationStartedAt: new Date().toISOString(),
    applicationMethod: 'git merge --ff-only',
  };

  try {
    preflight(request);
  } catch (error) {
    return {
      child: currentChild,
      evidence: {
        ...evidence,
        status: 'rejected',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      },
    };
  }

  const rollbackRef = request.rollbackRef;
  let existingRollback = null;
  try {
    existingRollback = git(config.repository, ['rev-parse', '--verify', rollbackRef]);
  } catch {
    // Missing is expected on the first activation attempt.
  }
  if (existingRollback && existingRollback !== request.previousSha) {
    return {
      child: currentChild,
      evidence: {
        ...evidence,
        status: 'rejected',
        error: `rollback ref conflicts: ${rollbackRef}`,
        finishedAt: new Date().toISOString(),
      },
    };
  }
  if (!existingRollback) {
    git(config.repository, ['update-ref', rollbackRef, request.previousSha, '0'.repeat(40)]);
  }

  await stopChild(currentChild);
  let child = null;
  try {
    preflight(request); // Close the approval-to-mutation TOCTOU window.
    git(config.repository, [
      `--attr-source=${request.candidateSha}`,
      'merge',
      '--ff-only',
      '--no-edit',
      request.candidateSha,
    ]);
    requireState(config.repository, request.candidateSha);
    evidence.build = await runBuild(runtime);
    quarantinePlantedAttributes(config.repository, request);
    requireState(config.repository, request.candidateSha);
    const started = await startHealthy(runtime, request.candidateSha);
    child = started.child;
    evidence.healthcheck = started.health;
    requireState(config.repository, request.candidateSha);
    // This process still runs the supervisor/launcher code it loaded at startup.
    // Say so instead of implying the activated one is already in force.
    const supervisorRestartRequired =
      trustBoundaryDigest(config.repository) !== config.trustBoundaryDigest;
    if (supervisorRestartRequired) {
      process.stdout.write(
        'Jarvis supervisor: the activated candidate changes supervisor/launcher code. ' +
          'The running supervisor is still the previous one; restart `pnpm dev` to adopt it.\n',
      );
    }
    return {
      child,
      evidence: {
        ...evidence,
        supervisorRestartRequired,
        status: 'activated',
        headAfter: request.candidateSha,
        finishedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    evidence.activationError = error instanceof Error ? error.message : String(error);
    await stopChild(child);
    child = null;
    // Before reading state, not after: a build that planted attributes and then
    // failed would otherwise make this very read fatal and block a rollback
    // that is actually still possible.
    quarantinePlantedAttributes(config.repository, request, { bestEffort: true });
    const failedState = safeState(config.repository);

    if (failedState.clean && failedState.head === request.candidateSha) {
      evidence.rollbackStartedAt = new Date().toISOString();
      try {
        git(config.repository, [
          `--attr-source=${request.previousSha}`,
          'reset',
          '--hard',
          request.previousSha,
        ]);
        requireState(config.repository, request.previousSha);
        evidence.rollbackBuild = await runBuild(runtime);
        quarantinePlantedAttributes(config.repository, request);
        requireState(config.repository, request.previousSha);
        const restarted = await startHealthy(runtime, request.previousSha);
        child = restarted.child;
        evidence.rollbackHealthcheck = restarted.health;
        return {
          child,
          evidence: {
            ...evidence,
            status: 'rolled_back',
            rollbackSha: request.previousSha,
            headAfter: request.previousSha,
            finishedAt: new Date().toISOString(),
          },
        };
      } catch (rollbackError) {
        return {
          child,
          evidence: {
            ...evidence,
            status: 'rollback_failed',
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            headAfter: safeState(config.repository).head,
            finishedAt: new Date().toISOString(),
          },
        };
      }
    }

    if (failedState.clean && failedState.head === request.previousSha) {
      try {
        const restarted = await startHealthy(runtime, request.previousSha);
        child = restarted.child;
        evidence.rollbackHealthcheck = restarted.health;
      } catch (restartError) {
        evidence.restartError =
          restartError instanceof Error ? restartError.message : String(restartError);
      }
      return {
        child,
        evidence: {
          ...evidence,
          status: 'activation_failed',
          headAfter: request.previousSha,
          finishedAt: new Date().toISOString(),
        },
      };
    }

    return {
      child: null,
      evidence: {
        ...evidence,
        status: 'rollback_blocked',
        error: `rollback requires clean HEAD ${request.candidateSha}; found ${failedState.head}, clean=${failedState.clean}${failedState.error ? `: ${failedState.error}` : ''}`,
        headAfter: failedState.head,
        finishedAt: new Date().toISOString(),
      },
    };
  }
}

async function main() {
  const configPath = process.argv[2] ?? process.env.JARVIS_SUPERVISOR_CONFIG;
  if (!configPath) throw new Error('usage: node scripts/supervisor.mjs <config.json>');
  const config = loadConfig(path.resolve(configPath));
  const processing = `${config.requestFile}.processing`;
  if (fs.existsSync(processing)) throw new Error(`ambiguous pending request: ${processing}`);
  const inbox = await createRequestInbox(config);
  config.upgradeSocket = inbox.endpoint;
  config.trustBoundaryDigest = trustBoundaryDigest(config.repository);

  let stopping = false;
  let child = null;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  const initialSha = state(config.repository).head;
  const started = await startHealthy(config, initialSha);
  child = started.child;
  process.stdout.write(`Jarvis supervisor ready at ${initialSha}\n`);

  try {
    while (!stopping) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Jarvis child exited unexpectedly (code ${child.exitCode})`);
      }
      const incoming = await inbox.next(config.pollMs);
      if (!incoming) continue;
      let request;
      try {
        if (fs.existsSync(processing)) throw new Error(`ambiguous pending request: ${processing}`);
        request = validateRequest(JSON.parse(incoming.raw), config);
        if (
          fs.existsSync(request.resultPath) ||
          fs.existsSync(`${config.requestFile}.${request.transactionId}.processed`)
        ) {
          throw new Error('activation transaction was already processed');
        }
        // The raw human bearer existed only in this process's memory. Persist
        // the validated token-free request before acknowledging the caller.
        const { evidencePrivateKey: _evidencePrivateKey, ...persistableRequest } = request;
        atomicJson(processing, persistableRequest);
        await incoming.accept();
      } catch (error) {
        const rejected = `${config.requestFile}.${Date.now()}.rejected`;
        fs.rmSync(processing, { force: true });
        incoming.reject(error instanceof Error ? error.message : String(error));
        atomicJson(rejected, {
          status: 'rejected',
          error: error instanceof Error ? error.message : String(error),
          rejectedAt: new Date().toISOString(),
        });
        if (config.once) stopping = true;
        continue;
      }
      const outcome = await activate(config, request, child);
      child = outcome.child;
      const evidenceFile = request.resultPath;
      if (fs.existsSync(evidenceFile)) throw new Error(`evidence already exists: ${evidenceFile}`);
      atomicJson(evidenceFile, signedEvidence(outcome.evidence, request.evidencePrivateKey));
      atomicJson(`${config.requestFile}.${request.transactionId}.processed`, {
        transactionId: request.transactionId,
        repository: request.repository,
        branch: request.branch,
        previousSha: request.previousSha,
        candidateSha: request.candidateSha,
        processedAt: new Date().toISOString(),
      });
      fs.rmSync(processing);
      if (config.once) stopping = true;
    }
  } finally {
    await stopChild(child);
    await inbox.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `Jarvis supervisor failed: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exitCode = 1;
});
