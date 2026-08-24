import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const children: ChildProcess[] = [];
const supervisor = path.resolve('scripts/supervisor.mjs');
const ACTIVATION_TOKEN = 'human-held-supervisor-token-0123456789abcdef';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

async function port(): Promise<number> {
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

function fixture(healthyCandidate: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-supervisor-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.built\n.observed-request\n');
  fs.writeFileSync(
    path.join(repo, 'build.mjs'),
    `import {execFileSync} from 'node:child_process'; import fs from 'node:fs'; const processing=process.env.JARVIS_UPGRADE_REQUEST_PATH+'.processing'; const observed=fs.existsSync(processing)?fs.readFileSync(processing,'utf8'):''; fs.writeFileSync('.observed-request',observed); console.error(observed); fs.writeFileSync('.built', execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'server.mjs'),
    `import http from 'node:http'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
http.createServer((req,res)=>{ if(req.url!=='/health'){res.statusCode=404; return res.end();} const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); const built=fs.readFileSync('.built','utf8').trim(); const healthy=fs.readFileSync('healthy.txt','utf8').trim()==='yes' && built===commit; res.statusCode=healthy?200:503; res.setHeader('content-type','application/json'); res.end(JSON.stringify({status:healthy?'ok':'error',commit,version:fs.readFileSync('version.txt','utf8').trim(),supervised:process.env.JARVIS_SUPERVISED,requestPath:process.env.JARVIS_UPGRADE_REQUEST_PATH})); }).listen(Number(process.env.PORT),'127.0.0.1');\n`,
  );
  fs.writeFileSync(path.join(repo, 'healthy.txt'), 'yes\n');
  fs.writeFileSync(path.join(repo, 'version.txt'), 'old\n');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'jarvis@example.invalid');
  git(repo, 'config', 'user.name', 'Jarvis Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'old');
  const previousSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'candidate');
  fs.writeFileSync(path.join(repo, 'version.txt'), healthyCandidate ? 'new\n' : 'broken\n');
  if (!healthyCandidate) fs.writeFileSync(path.join(repo, 'healthy.txt'), 'no\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'candidate');
  const candidateSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'main');
  execFileSync(process.execPath, ['build.mjs'], { cwd: repo });
  return { root, repo, stateDir, previousSha, candidateSha };
}

async function waitFor<T>(
  read: () => Promise<T | null> | T | null,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for supervisor evidence');
}

async function runActivation(
  healthyCandidate: boolean,
  tamperCommand = false,
  activationToken = ACTIVATION_TOKEN,
) {
  const setup = fixture(healthyCandidate);
  const selectedPort = await port();
  const requestFile = path.join(setup.stateDir, 'activate.json');
  const transactionId = healthyCandidate ? 'good-activation' : 'broken-activation';
  const resultPath = path.join(setup.stateDir, `${transactionId}.result.json`);
  const healthUrl = `http://127.0.0.1:${selectedPort}/health`;
  const startCommand = {
    executable: process.execPath,
    args: ['server.mjs'],
    env: { PORT: String(selectedPort) },
  };
  const buildCommand = { executable: process.execPath, args: ['build.mjs'] };
  const configFile = path.join(setup.stateDir, 'supervisor.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      repository: setup.repo,
      requestFile,
      activationTokenHash: createHash('sha256').update(ACTIVATION_TOKEN).digest('hex'),
      healthUrl,
      startCommand,
      buildCommand,
      pollMs: 30,
      healthTimeoutMs: 1_200,
      commandTimeoutMs: 5_000,
      once: true,
    }),
  );

  const child = spawn(process.execPath, [supervisor, configFile], {
    cwd: setup.repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  let logs = '';
  child.stdout?.on('data', (chunk) => (logs += chunk));
  child.stderr?.on('data', (chunk) => (logs += chunk));

  await waitFor(async () => {
    try {
      const response = await fetch(healthUrl);
      const body = (await response.json()) as { commit?: string };
      return response.ok && body.commit === setup.previousSha ? true : null;
    } catch {
      return null;
    }
  });

  const request = {
    transactionId,
    approved: true,
    approvedBy: 'user',
    activationToken,
    repository: setup.repo,
    branch: 'main',
    previousSha: setup.previousSha,
    candidateSha: setup.candidateSha,
    rollbackRef: `refs/jarvis/rollback/${transactionId}`,
    healthUrl,
    buildCommand,
    startCommand,
    resultPath,
  };
  if (tamperCommand) request.buildCommand = { ...buildCommand, args: ['malicious.mjs'] };
  const temporary = `${requestFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(request));
  fs.renameSync(temporary, requestFile);

  if (tamperCommand || activationToken !== ACTIVATION_TOKEN) {
    const code = await waitFor(() => (child.exitCode === null ? null : child.exitCode));
    children.splice(children.indexOf(child), 1);
    const rejected = fs
      .readdirSync(setup.stateDir)
      .find((name) => name.startsWith('activate.json.') && name.endsWith('.rejected'));
    const evidence: Record<string, unknown> = {
      supervisorExitCode: code,
      logs,
      resultExists: fs.existsSync(resultPath),
      rejection: rejected
        ? JSON.parse(fs.readFileSync(path.join(setup.stateDir, rejected), 'utf8'))
        : null,
    };
    return { ...setup, evidence };
  }

  const evidence = await waitFor(() =>
    fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
      : null,
  );
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`supervisor exited ${code}: ${logs}`);
  children.splice(children.indexOf(child), 1);
  return { ...setup, evidence, logs };
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('external self-upgrade supervisor', () => {
  it('fast-forwards, rebuilds, restarts and healthchecks a good candidate', async () => {
    const result = await runActivation(true);
    expect(result.evidence).toMatchObject({
      transactionId: 'good-activation',
      status: 'activated',
      repository: result.repo,
      branch: 'main',
      previousSha: result.previousSha,
      candidateSha: result.candidateSha,
      rollbackRef: 'refs/jarvis/rollback/good-activation',
      healthUrl: expect.stringContaining('/health'),
      buildCommand: { executable: process.execPath, args: ['build.mjs'] },
      startCommand: { executable: process.execPath, args: ['server.mjs'] },
      resultPath: path.join(result.stateDir, 'good-activation.result.json'),
      headAfter: result.candidateSha,
      applicationMethod: 'git merge --ff-only',
      healthcheck: {
        body: {
          status: 'ok',
          commit: result.candidateSha,
          version: 'new',
          supervised: '1',
          requestPath: path.join(result.stateDir, 'activate.json'),
        },
      },
    });
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.candidateSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
    const processed = fs.readFileSync(
      path.join(result.stateDir, 'activate.json.good-activation.processed'),
      'utf8',
    );
    expect(processed).not.toContain(ACTIVATION_TOKEN);
    const observed = fs.readFileSync(path.join(result.repo, '.observed-request'), 'utf8');
    expect(observed).not.toContain(ACTIVATION_TOKEN);
    expect(observed).not.toContain('activationToken');
    expect(JSON.stringify(result.evidence)).not.toContain(ACTIVATION_TOKEN);
    expect(result.logs).not.toContain(ACTIVATION_TOKEN);
    expect(
      fs
        .readdirSync(result.stateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => fs.readFileSync(path.join(result.stateDir, entry.name), 'utf8'))
        .join('\n'),
    ).not.toContain(ACTIVATION_TOKEN);
  });

  it('restores and restarts the old revision after candidate health fails', async () => {
    const result = await runActivation(false);
    expect(result.evidence).toMatchObject({
      status: 'rolled_back',
      previousSha: result.previousSha,
      candidateSha: result.candidateSha,
      rollbackSha: result.previousSha,
      headAfter: result.previousSha,
      rollbackHealthcheck: {
        body: { status: 'ok', commit: result.previousSha, version: 'old' },
      },
    });
    expect(String(result.evidence.activationError)).toContain('healthcheck failed');
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.previousSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
  });

  it('rejects activation commands that differ from operator configuration', async () => {
    const result = await runActivation(true, true);
    expect(result.evidence).toMatchObject({
      supervisorExitCode: 0,
      resultExists: false,
      rejection: { status: 'rejected', error: 'buildCommand does not match supervisor config' },
    });
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.previousSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
  });

  it('rejects a self-asserted approval without the out-of-band human token', async () => {
    const attackerToken = 'attacker-cannot-self-approve-0123456789';
    const result = await runActivation(true, false, attackerToken);
    expect(result.evidence).toMatchObject({
      supervisorExitCode: 0,
      resultExists: false,
      rejection: { status: 'rejected', error: 'activation request human token is invalid' },
    });
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.previousSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
    expect(
      fs
        .readdirSync(result.stateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => fs.readFileSync(path.join(result.stateDir, entry.name), 'utf8'))
        .join('\n'),
    ).not.toContain(attackerToken);
  });
});
