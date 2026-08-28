import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// The launcher is plain ESM with no import side effects: everything below its
// exports runs only when node was invoked with scripts/dev.mjs itself.
import {
  RUNTIME_ENV_ALLOWLIST,
  mintActivationToken,
  preservedRuntimeEnv,
  readyBanner,
  repositoryClean,
  repositoryRoot,
  supervisorConfig,
} from '../../scripts/dev.mjs';

const launcher = path.resolve('scripts/dev.mjs');
const repository = repositoryRoot();
const SECRET_ENV_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_KEY|PRIVATE_KEY)(?:_|$)/i;
const SECRET_SOURCE_ENV = {
  JARVIS_BOOTSTRAP_TOKEN: 'bootstrap-must-not-travel',
  JARVIS_CONTROL_TOKEN: 'control-must-not-travel',
  JARVIS_UPGRADE_TOKEN_HASH: 'f'.repeat(64),
  JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: 'e'.repeat(64),
  ANTHROPIC_API_KEY: 'sk-ant-must-not-travel',
  GITHUB_TOKEN: 'ghp_must_not_travel',
  JARVIS_UNKNOWN_KNOB: 'not-allowlisted',
};
const BANNER = /Jarvis supervised dev ready[\s\S]*?activation token[\s\S]*?\s([0-9a-f]{64})\s/;

const running: ChildProcess[] = [];
const temporary: string[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.pid) killTree(child.pid);
  }
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const args = ['/pid', String(pid), '/t', '/f'];
      execFileSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const selected = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return selected;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitFor<T>(
  read: () => Promise<T | null> | T | null,
  what: string,
  timeoutMs = 150_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Launch {
  child: ChildProcess;
  output: () => string;
  home: string;
  exit: () => Promise<number | string>;
}

function launch(env: Record<string, string>, args: string[], ports: number[]): Launch {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dev-'));
  temporary.push(home);
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: repository,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      ...SECRET_SOURCE_ENV,
      JARVIS_HOME: home,
      JARVIS_PORT: String(ports[0]),
      JARVIS_WEB_PORT: String(ports[1]),
      JARVIS_EMBEDDINGS: '0',
      // Stands in for a console Ctrl+C, which a test cannot deliver on Windows.
      JARVIS_DEV_STOP_ON_STDIN_EOF: '1',
      FORCE_COLOR: '0',
      ...env,
    },
  });
  running.push(child);
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  return {
    child,
    output: () => output,
    home,
    exit: () => waitFor(() => child.exitCode ?? child.signalCode, 'launcher exit', 60_000),
  };
}

async function ready(instance: Launch): Promise<{ session: string; token: string }> {
  const banner = await waitFor(() => {
    if (instance.child.exitCode !== null) {
      throw new Error(`launcher exited early:\n${instance.output()}`);
    }
    return BANNER.exec(instance.output());
  }, 'the supervised launcher banner');
  const session = /Supervisor session: (.+)\r?\n/.exec(instance.output())?.[1].trim();
  if (!session) throw new Error('launcher printed no session directory');
  temporary.push(session);
  return { session, token: banner[1] };
}

async function expectPortsFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    const released = async () => ((await portFree(port)) ? true : null);
    await waitFor(released, `port ${port} to be released`, 15_000);
  }
}

function readSession(dir: string): { supervisorPid: number; webPid: number } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
}

function head(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
}

function gitRoot(): string {
  const args = ['rev-parse', '--show-toplevel'];
  return fs.realpathSync(execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim());
}

describe('pnpm dev supervisor bootstrap', () => {
  it('ignores executable fsmonitor residue before the supervisor starts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dev-poison-'));
    temporary.push(root);
    const marker = path.join(root, 'fsmonitor-ran');
    const monitor = path.join(root, 'fsmonitor.mjs');
    fs.writeFileSync(
      monitor,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); process.stdout.write('0\\0');\n`,
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'safe\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    execFileSync('git', ['config', 'core.fsmonitor', `node ${JSON.stringify(monitor)}`], {
      cwd: root,
    });

    expect(repositoryClean(root)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('checks the registered checkout instead of a configured worktree decoy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dev-worktree-'));
    temporary.push(root);
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(decoy);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'safe\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    // The decoy must look like a clean checkout of the same commit, otherwise
    // Git reports the tracked file as deleted and the assertion below passes
    // whether or not the work tree is actually pinned.
    fs.copyFileSync(path.join(root, 'tracked.txt'), path.join(decoy, 'tracked.txt'));
    execFileSync('git', ['config', 'core.worktree', decoy], { cwd: root });
    fs.writeFileSync(path.join(root, 'unreviewed.txt'), 'dirty\n');

    expect(repositoryClean(root)).toBe(false);
  });

  it('mints a fresh 32-byte activation token and publishes only its hash', () => {
    const first = mintActivationToken();
    const second = mintActivationToken();
    expect(first.token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    expect(first.token).not.toBe(second.token);
    expect(first.hash).toBe(createHash('sha256').update(first.token, 'utf8').digest('hex'));

    const config = supervisorConfig({
      repository,
      sessionDir: path.join(os.tmpdir(), 'jarvis-supervisor', 'session-test'),
      activationTokenHash: first.hash,
      apiPort: 4319,
      env: preservedRuntimeEnv({ JARVIS_CODEX_BIN: 'C:\\nope\\codex.exe' }),
    });
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(first.token);
    expect(serialized).not.toContain(second.token);
    expect(config.activationTokenHash).toBe(first.hash);
    expect(config.repository).toBe(gitRoot());
    expect(path.relative(repository, config.requestFile).startsWith('..')).toBe(true);
    expect(config.healthUrl).toBe('http://127.0.0.1:4319/health');
    // Byte-identical to what UpgradeManager sends, or the supervisor rejects it.
    expect(config.buildCommand).toEqual({ executable: 'pnpm', args: ['build'] });
    expect(config.startCommand).toEqual({
      executable: 'pnpm',
      args: ['--filter', '@jarvis/orchestrator', 'start'],
    });
    expect(config.runtimeEnv).toEqual({ JARVIS_CODEX_BIN: 'C:\\nope\\codex.exe' });
  });

  it('prints the raw token exactly once', () => {
    const { token } = mintActivationToken();
    const banner = readyBanner({ webPort: 5199, apiPort: 4319, token, sessionDir: 'C:\\s' });
    expect(banner.split(token)).toHaveLength(2);
  });

  it('forwards only allowlisted non-secret runtime configuration', () => {
    const preserved = preservedRuntimeEnv({
      ...SECRET_SOURCE_ENV,
      JARVIS_HOME: 'C:\\jarvis-home',
      JARVIS_IMPLEMENTER_PROVIDER: 'claude',
      JARVIS_REVIEWER_PROVIDER: 'claude',
      JARVIS_CODEX_BIN: 'C:\\__jarvis_codex_disabled__\\codex.exe',
      JARVIS_CLAUDE_MODEL: 'sonnet',
      JARVIS_PROVIDER_COOLDOWN_MS: '1000',
      JARVIS_WEB_PORT: '',
    });
    expect(preserved).toEqual({
      JARVIS_HOME: 'C:\\jarvis-home',
      JARVIS_IMPLEMENTER_PROVIDER: 'claude',
      JARVIS_REVIEWER_PROVIDER: 'claude',
      JARVIS_CODEX_BIN: 'C:\\__jarvis_codex_disabled__\\codex.exe',
      JARVIS_CLAUDE_MODEL: 'sonnet',
      JARVIS_PROVIDER_COOLDOWN_MS: '1000',
    });
    for (const name of RUNTIME_ENV_ALLOWLIST) {
      expect(name).not.toMatch(SECRET_ENV_NAME);
      expect(name).not.toMatch(/^JARVIS_(?:SUPERVISED|UPGRADE_|CANDIDATE_|RUNTIME_NONCE)/);
    }
  });
});

describe('pnpm dev supervised runtime', () => {
  it('starts supervisor, orchestrator and web, then stops the whole tree', async () => {
    const ports = [await freePort(), await freePort()];
    const origin = `http://127.0.0.1:${ports[1]}`;
    const disabledCodex = path.join(os.tmpdir(), '__jarvis_codex_disabled__', 'codex.exe');
    const instance = launch(
      {
        JARVIS_CONTROL_ORIGINS: origin,
        JARVIS_CLAUDE_BIN: process.execPath,
        JARVIS_CODEX_BIN: disabledCodex,
      },
      [],
      ports,
    );
    const { session, token } = await ready(instance);

    // The supervised orchestrator is live at the normal address, serving the
    // exact current checkout, with Vite beside it.
    const healthResponse = await fetch(`http://127.0.0.1:${ports[0]}/health`);
    const health: { status: string; commit: string } = await healthResponse.json();
    expect(health.status).toBe('ok');
    expect(health.commit).toBe(head());
    const viteUp = async () => ((await portFree(ports[1])) ? null : true);
    await waitFor(viteUp, 'Vite to bind', 30_000);

    // The raw token was printed once and exists nowhere else.
    expect(instance.output().split(token)).toHaveLength(2);
    const persisted = fs
      .readdirSync(session, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(session, entry.name), 'utf8'))
      .join('\n');
    expect(persisted).not.toContain(token);
    const raw = fs.readFileSync(path.join(session, 'supervisor.json'), 'utf8');
    const config: SupervisorConfig = JSON.parse(raw);
    expect(config.activationTokenHash).toBe(sha256(token));
    expect(path.relative(repository, config.requestFile).startsWith('..')).toBe(true);
    expect(config.runtimeEnv.JARVIS_HOME).toBe(instance.home);
    for (const name of Object.keys(SECRET_SOURCE_ENV)) {
      expect(config.runtimeEnv).not.toHaveProperty(name);
    }
    expect(raw).not.toContain('must-not-travel');

    // Non-secret runtime configuration survived supervised startup: the
    // orchestrator opened the temporary JARVIS_HOME, and the invalid Codex
    // override stayed authoritative with no PATH fallback.
    expect(fs.existsSync(path.join(instance.home, 'jarvis.db'))).toBe(true);
    const printed = instance.output();
    const bootstrap = /pairing token \(valid once for 10 minutes\): (\S+)/.exec(printed)?.[1];
    expect(bootstrap).toBeTruthy();
    const pairResponse = await fetch(`http://127.0.0.1:${ports[0]}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ bootstrap }),
    });
    const paired: { credential?: string } = await pairResponse.json();
    expect(paired.credential).toBeTruthy();
    const apiResponse = await fetch(`http://127.0.0.1:${ports[0]}/api/health`, {
      headers: { 'X-Jarvis-Control': String(paired.credential) },
    });
    const api: { home: string; providers: Capability[] } = await apiResponse.json();
    expect(api.home).toBe(instance.home);
    // The Claude override was resolved and executed by the supervised process:
    // `--version` on the binary it names. Availability itself is a real login,
    // which a deterministic test must not require.
    const claude = api.providers.find((provider) => provider.id === 'claude');
    expect(claude?.version).toBe(process.version);
    // The invalid Codex override stays authoritative: unavailable, not found,
    // and never rediscovered from PATH.
    const codex = api.providers.find((provider) => provider.id === 'codex');
    expect(codex?.available).toBe(false);
    expect(codex?.reason).toContain('Codex CLI not found');

    // Ctrl+C tears the whole tree down and releases both ports, silently.
    instance.child.stdin?.end();
    expect(await instance.exit()).toBe(0);
    await expectPortsFree(ports);
    expect(instance.output().split(token)).toHaveLength(2);
  });

  it('tears down web when the supervisor dies, and exits non-zero', async () => {
    const ports = [await freePort(), await freePort()];
    const instance = launch({}, [], ports);
    const { session } = await ready(instance);

    killTree(readSession(session).supervisorPid);
    expect(await instance.exit()).not.toBe(0);
    await expectPortsFree(ports);
  });

  it('tears down supervisor and orchestrator when web dies, and exits non-zero', async () => {
    const ports = [await freePort(), await freePort()];
    const instance = launch({}, [], ports);
    const { session } = await ready(instance);

    killTree(readSession(session).webPid);
    expect(await instance.exit()).not.toBe(0);
    await expectPortsFree(ports);
  });

  it('refuses to start on an occupied port and leaves nothing behind', async () => {
    const ports = [await freePort(), await freePort()];
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(ports[0], '127.0.0.1', resolve));
    try {
      const instance = launch({}, [], ports);
      expect(await instance.exit()).toBe(1);
      expect(instance.output()).toContain(`API port ${ports[0]} is already in use`);
      expect(instance.output()).not.toMatch(/activation token/i);
      expect(await portFree(ports[1])).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('never advertises self-upgrade in the unsupervised fallback', async () => {
    const ports = [await freePort(), await freePort()];
    const instance = launch({}, ['--unsupervised'], ports);
    const printed = () => (instance.output().includes('Jarvis dev (unsupervised)') ? true : null);
    await waitFor(printed, 'the unsupervised banner', 30_000);
    expect(instance.output()).toContain('self-upgrade activation is unavailable');
    expect(instance.output()).not.toMatch(/activation token/i);
    expect(BANNER.test(instance.output())).toBe(false);
    instance.child.stdin?.end();
    expect(await instance.exit()).toBe(0);
  });
});

interface Capability {
  id: string;
  available: boolean;
  version?: string;
  reason?: string;
}

interface SupervisorConfig {
  activationTokenHash: string;
  requestFile: string;
  runtimeEnv: Record<string, string>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
