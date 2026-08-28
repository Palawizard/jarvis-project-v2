#!/usr/bin/env node
/**
 * `pnpm dev` — one supervised Jarvis, one command.
 *
 * Process tree:
 *
 *   pnpm dev (this launcher)
 *     ├── node scripts/supervisor.mjs <session config>   ← owns the orchestrator
 *     └── pnpm --filter @jarvis/web dev                  ← Vite
 *
 * The self-upgrade activation token is minted here, printed once, and then
 * dropped. Only its SHA-256 reaches the supervisor config and the supervised
 * orchestrator, so this launcher never gives Jarvis the authority to activate
 * itself — the human still pastes the raw token in the activation prompt.
 *
 * `--unsupervised` keeps the old two-process dev loop (tsx watch + Vite). It is
 * also forced for candidate runtimes, which must never bootstrap a supervisor.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Non-secret operational configuration the supervised orchestrator must keep
 * seeing, because the supervisor otherwise hands its children a bare platform
 * environment. Explicit names only: never a `JARVIS_*` prefix match, so pairing
 * bootstraps, control credentials, candidate QA material, activation tokens and
 * ambient API keys cannot ride along.
 */
export const RUNTIME_ENV_ALLOWLIST = Object.freeze([
  'JARVIS_HOME',
  'JARVIS_PORT',
  'JARVIS_WEB_PORT',
  'JARVIS_CONTROL_ORIGINS',
  'JARVIS_IMPLEMENTER_PROVIDER',
  'JARVIS_REVIEWER_PROVIDER',
  'JARVIS_CLAUDE_MODEL',
  'JARVIS_CLAUDE_PERMISSION_MODE',
  'JARVIS_CODEX_MODEL',
  'JARVIS_CLAUDE_BIN',
  'JARVIS_CODEX_BIN',
  'JARVIS_AGENT_TIMEOUT_MS',
  'JARVIS_PROVIDER_COOLDOWN_MS',
  'JARVIS_MEMORY_MIN_IMPORTANCE',
  'JARVIS_MEMORY_DEDUPE_SIMILARITY',
  'JARVIS_MEMORY_DEDUPE_LEXICAL',
  'JARVIS_MEMORY_SEMANTIC_FLOOR',
  'JARVIS_MEMORY_SEMANTIC_MARGIN',
  'JARVIS_MEMORY_MAX_CONTENT_CHARS',
  'JARVIS_EMBEDDINGS',
  'JARVIS_EMBEDDING_MODEL',
  'JARVIS_CORE_USER_MEMORY_MAX',
  'JARVIS_CONTEXT_BUDGET_TOKENS',
  'JARVIS_MAX_FIX_CYCLES',
  'JARVIS_MAX_REVIEW_FIX_CYCLES',
  'JARVIS_MAX_VISUAL_FIX_CYCLES',
  'JARVIS_AGENT_STAGE_RETRIES',
  'JARVIS_VERIFICATION_INFRA_RETRIES',
  'JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES',
  'JARVIS_VISUAL_REVIEW_BLOCKING_SEVERITIES',
  'JARVIS_RAW_HISTORY_RETENTION_DAYS',
  'JARVIS_TOOL_TIMEOUT_MS',
  'JARVIS_TOOL_APPROVAL_TTL_MS',
  'JARVIS_TOOL_AUDIT_RETENTION_DAYS',
  'JARVIS_TOOL_MAX_RECORD_CHARS',
]);

export function preservedRuntimeEnv(source = process.env) {
  const env = {};
  for (const name of RUNTIME_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === 'string' && value.trim() !== '') env[name] = value;
  }
  return env;
}

/** Human authority for one launcher session. The raw value never leaves memory. */
export function mintActivationToken() {
  const token = randomBytes(32).toString('hex');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

/** Platform only: no provider keys, no control tokens, no `GIT_*` overrides. */
const GIT_ENV_ALLOWLIST = [
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
];

function gitEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' };
  for (const name of GIT_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

const DISABLED_GIT_HOOKS = path.join(os.tmpdir(), `.jarvis-no-git-hooks-${randomUUID()}`);
// Git refuses NUL and /dev/null as an exclude file, so point it at a path that
// simply does not exist: a missing excludes file contributes no patterns.
const DISABLED_GIT_EXCLUDES = path.join(os.tmpdir(), `.jarvis-no-git-excludes-${randomUUID()}`);
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const NO_TREE_ATTRIBUTES = '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function trustedGitArgs(cwd, args) {
  return [
    '--no-replace-objects',
    `--work-tree=${fs.realpathSync(path.resolve(cwd))}`,
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
    // Untracked work hidden from status is unreviewed work, and a failed
    // activation can leave this config behind. `info/exclude` has no switch and
    // is probed by hiddenExcludedFiles instead.
    '-c',
    `core.excludesFile=${DISABLED_GIT_EXCLUDES}`,
    NO_TREE_ATTRIBUTES,
    ...args,
  ];
}

/**
 * A failed activation can leave a candidate build's `.gitattributes` and
 * `filter.*` config behind in the repository, and this runs before anything has
 * cleaned up. Resolve attributes against the empty tree so no driver is bound,
 * and hand Git the same allowlist untrusted commands get rather than the
 * operator's shell, so a driver that does run somewhere learns nothing.
 */
function gitOut(cwd, args) {
  // eslint-disable-next-line no-restricted-syntax -- this is the launcher's own copy of the trusted shape
  return execFileSync('git', trustedGitArgs(cwd, args), {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

export function repositoryRoot(from = path.resolve(scriptsDir, '..')) {
  // Asking Git would only echo the pinned `--work-tree` back. Walk up to the
  // directory that actually holds the `.git` entry instead.
  let current = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return fs.realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`not a Git repository: ${from}`);
    current = parent;
  }
}

/**
 * Untracked files hidden behind `<git-common-dir>/info/exclude`. `.gitignore`
 * is tracked so hiding work there changes a reviewed diff, but `info/exclude`
 * is neither tracked nor per-worktree and Git offers no switch to disable it.
 * Apply its patterns deliberately to see what they conceal.
 */
function hiddenExcludedFiles(repository) {
  const exclude = path.resolve(
    repository,
    gitOut(repository, ['rev-parse', '--git-common-dir']),
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
  return gitOut(repository, ['ls-files', '--others', '--ignored', `--exclude-from=${exclude}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function repositoryClean(repository) {
  // `--work-tree` is pinned to `repository` by trustedGitArgs, so this status
  // describes the registered checkout even when a candidate left a
  // `core.worktree` pointing somewhere clean.
  if (hiddenExcludedFiles(repository).length > 0) return false;
  return gitOut(repository, ['status', '--porcelain', '--untracked-files=normal']) === '';
}

export function supervisorConfig({ repository, sessionDir, activationTokenHash, apiPort, env }) {
  return {
    repository,
    requestFile: path.join(sessionDir, 'activation.json'),
    activationTokenHash,
    healthUrl: `http://127.0.0.1:${apiPort}/health`,
    // Exactly the commands the orchestrator asks for at activation time: the
    // supervisor rejects any request whose commands differ from its config.
    buildCommand: { executable: 'pnpm', args: ['build'] },
    startCommand: { executable: 'pnpm', args: ['--filter', '@jarvis/orchestrator', 'start'] },
    runtimeEnv: env,
    healthTimeoutMs: 120_000,
  };
}

export function readyBanner({ webPort, apiPort, token, sessionDir }) {
  return [
    '',
    '  Jarvis supervised dev ready',
    `  UI:  http://localhost:${webPort}`,
    `  API: http://127.0.0.1:${apiPort}`,
    `  Supervisor session: ${sessionDir}`,
    '',
    '  Self-upgrade activation token for this session:',
    `  ${token}`,
    '',
    '  Keep this token. It is requested once, in the browser, when you activate a',
    '  self-upgrade. It is not the pairing token, and it is stored nowhere.',
    '',
    '',
  ].join('\n');
}

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 400);
}

function fail(message) {
  process.stderr.write(`\nJarvis dev failed: ${message}\n\n`);
  shutdown(1);
}

function spawnPrefixed(name, executable, args, color, options = {}) {
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
    env: { ...process.env, FORCE_COLOR: '1', ...(options.env ?? {}) },
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return { child, prefix };
}

/** A long-running half of Jarvis: its death is the whole launcher's death. */
function start(name, executable, args, color, options = {}) {
  const { child, prefix } = spawnPrefixed(name, executable, args, color, options);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    // Losing either half leaves a half-running Jarvis: tear the rest down.
    // No-op once a Ctrl+C shutdown already latched its own exit code.
    shutdown(code || 1);
  });
  return child;
}

/** A one-shot startup step. Runs under the same Ctrl+C teardown as the rest. */
function run(name, executable, args, color, options = {}) {
  return new Promise((resolve) => {
    const { child } = spawnPrefixed(name, executable, args, color, options);
    child.once('exit', (code) => {
      children.splice(children.indexOf(child), 1);
      resolve(code ?? 1);
    });
    child.once('error', (error) => {
      children.splice(children.indexOf(child), 1);
      process.stderr.write(`${name} could not start: ${error.message}\n`);
      resolve(1);
    });
  });
}

async function requireFreePort(label, port) {
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
  if (free) return;
  throw new Error(`${label} port ${port} is already in use; stop the other Jarvis first`);
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'healthcheck did not run';
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body.status === 'ok') return body;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`supervised Jarvis never became healthy: ${lastError}`);
}

/**
 * Session directories are per-launch, so a stale one can never be mistaken for
 * this run's inbox. Old ones are still deleted eventually — except residue of an
 * activation that was interrupted mid-flight, which stays for inspection.
 */
function sessionRoot(repository) {
  const home = path.join(os.homedir(), '.jarvis', 'supervisor');
  const base = path.relative(repository, home).startsWith('..')
    ? home
    : path.join(os.tmpdir(), 'jarvis-supervisor');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const week = 7 * 24 * 60 * 60_000;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    const stale = path.join(base, entry.name);
    try {
      if (Date.now() - fs.statSync(stale).mtimeMs < week) continue;
      if (fs.readdirSync(stale).some((name) => name.endsWith('.processing'))) continue;
      fs.rmSync(stale, { recursive: true, force: true });
    } catch {
      /* another launcher owns it */
    }
  }
  return fs.mkdtempSync(path.join(base, 'session-'));
}

function unsupervised(apiPort, webPort) {
  start('api', pnpm, ['--filter', '@jarvis/orchestrator', 'dev'], '36', { shell: isWindows });
  start('web', pnpm, ['--filter', '@jarvis/web', 'dev'], '35', { shell: isWindows });
  process.stdout.write(
    `\n  Jarvis dev (unsupervised) — UI http://localhost:${webPort}   API http://127.0.0.1:${apiPort}\n` +
      `  No upgrade supervisor: self-upgrade activation is unavailable in this mode.\n` +
      `  Run "pnpm dev" for the normal supervised developer experience.\n\n`,
  );
}

async function supervised(apiPort, webPort) {
  const repository = repositoryRoot();
  try {
    gitOut(repository, ['symbolic-ref', '--quiet', 'HEAD']);
  } catch {
    throw new Error(`${repository} has a detached HEAD; check out a branch first`);
  }
  // Dirty is fine for development — activation is where it fails closed — but
  // say so now rather than at the end of a self-upgrade.
  if (!repositoryClean(repository)) {
    process.stdout.write('\n  Note: this checkout is dirty; self-upgrade will refuse to run.\n');
  }
  await requireFreePort('API', apiPort);
  await requireFreePort('UI', webPort);

  // The supervisor starts the orchestrator from dist, not from tsx.
  const built = await run(
    'build',
    pnpm,
    ['--filter', '@jarvis/core', '--filter', '@jarvis/orchestrator', 'build'],
    '33',
    { shell: isWindows, cwd: repository },
  );
  if (shuttingDown) return; // Ctrl+C during the build is not a build failure.
  if (built !== 0) throw new Error(`initial build failed with code ${built}`);

  const sessionDir = sessionRoot(repository);
  const { token, hash } = mintActivationToken();
  const configFile = path.join(sessionDir, 'supervisor.json');
  const config = supervisorConfig({
    repository,
    sessionDir,
    activationTokenHash: hash,
    apiPort,
    env: preservedRuntimeEnv(),
  });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const supervisorArgs = [path.join(scriptsDir, 'supervisor.mjs'), configFile];
  const supervisor = start('jarvis', process.execPath, supervisorArgs, '36', { cwd: repository });
  const web = start('web', pnpm, ['--filter', '@jarvis/web', 'dev'], '35', {
    shell: isWindows,
    cwd: repository,
    // Keep the Vite proxy on the API the supervisor actually started.
    env: { JARVIS_API: `http://127.0.0.1:${apiPort}` },
  });
  const session = {
    launcherPid: process.pid,
    supervisorPid: supervisor.pid,
    webPid: web.pid,
    configFile,
    startedAt: new Date().toISOString(),
  };
  const sessionFile = path.join(sessionDir, 'session.json');
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });

  await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 180_000);
  if (shuttingDown) return;
  // The only time the raw token is ever written anywhere. Nothing keeps it
  // afterwards: not this process, not the config, not Jarvis.
  process.stdout.write(readyBanner({ webPort, apiPort, token, sessionDir }));
}

async function main() {
  const apiPort = Number.parseInt(process.env.JARVIS_PORT || '4319', 10);
  const webPort = Number.parseInt(process.env.JARVIS_WEB_PORT || '5199', 10);
  if (!Number.isInteger(apiPort) || !Number.isInteger(webPort)) {
    throw new Error('JARVIS_PORT and JARVIS_WEB_PORT must be integers');
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // Opt-in Ctrl+C equivalent for a supervising parent that cannot deliver a
  // console control event (tests, CI). Off by default: an ignored stdin is
  // /dev/null and would EOF immediately.
  if (process.env.JARVIS_DEV_STOP_ON_STDIN_EOF === '1') {
    process.stdin.resume();
    process.stdin.on('end', () => shutdown(0));
  }
  if (process.env.JARVIS_CANDIDATE_RUNTIME === '1' || process.argv.includes('--unsupervised')) {
    unsupervised(apiPort, webPort);
    return;
  }
  await supervised(apiPort, webPort);
}

const invoked = process.argv[1];
const entry = invoked && fs.existsSync(invoked) ? fs.realpathSync(invoked) : '';
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
