import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, verify as verifyBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const children: ChildProcess[] = [];
const supervisor = path.resolve('scripts/supervisor.mjs');
const ACTIVATION_TOKEN = 'human-held-supervisor-token-0123456789abcdef';
const AMBIENT_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
const DISABLED_CODEX = path.join('C:', '__jarvis_codex_disabled__', 'codex.exe');
/**
 * These tests assert what the supervisor *does*, not how fast it does it: each
 * one spawns a real supervisor that installs and builds a temporary repository.
 * The deadline exists so a hung supervisor fails instead of hanging the suite,
 * so it has to clear the slowest legitimate run rather than the typical one.
 * A plain `pnpm verify` finishes these well inside a minute; the same suite run
 * while a supervised Jarvis is live -- which is exactly what happens when Jarvis
 * validates a candidate of itself -- shares the machine with an orchestrator, a
 * Vite server and that job's own builds, and repeatedly overran 120s there.
 */
const SUPERVISOR_TIMEOUT_MS = 300_000;

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
  fs.writeFileSync(path.join(repo, '.gitignore'), '.built\n.observed-env\n.daemon-pid\n');
  fs.writeFileSync(
    path.join(repo, 'build.mjs'),
    `import {execFileSync,spawn} from 'node:child_process'; import fs from 'node:fs'; const observed=JSON.stringify({token:process.env.GITHUB_TOKEN,request:process.env.JARVIS_UPGRADE_REQUEST_PATH,socket:process.env.JARVIS_UPGRADE_SOCKET,hash:process.env.JARVIS_UPGRADE_TOKEN_HASH,codexBin:process.env.JARVIS_CODEX_BIN}); fs.writeFileSync('.observed-env',observed); console.error(process.env.GITHUB_TOKEN??'no-token'); if(process.env.DAEMONIZE_BUILD==='1'){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync('.daemon-pid',String(c.pid));c.unref();} fs.writeFileSync('.built', execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'poison-build.mjs'),
    `import {execFileSync} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'}); if(fs.readFileSync('version.txt','utf8').trim()==='broken'){const gitDir=path.resolve(execFileSync('git',['rev-parse','--git-dir'],{encoding:'utf8'}).trim()); const driver=path.join(gitDir,'rollback-filter.mjs'); fs.writeFileSync(driver,"import fs from 'node:fs'; fs.writeFileSync(process.argv[2],'yes'); process.stdin.pipe(process.stdout);\\n"); fs.mkdirSync(path.join(gitDir,'info'),{recursive:true}); fs.writeFileSync(path.join(gitDir,'info','attributes'),'version.txt filter=evil\\n'); execFileSync('git',['config','filter.evil.smudge',\`node \${JSON.stringify(driver)} \${JSON.stringify(path.join(gitDir,'rollback-filter-ran'))}\`]); execFileSync('git',['config','filter.evil.required','true']); fs.writeFileSync('.gitattributes','version.txt filter=evil\\n'); fs.writeFileSync(path.join(gitDir,'info','exclude'),'.gitattributes\\n'); fs.writeFileSync('version.txt',fs.readFileSync('version.txt')); if(process.env.POISON_THEN_FAIL==='1'){process.exit(1);}} if(process.env.CORRUPT_GIT_HEAD==='1'){const gitDir=path.resolve(execFileSync('git',['rev-parse','--git-dir'],{encoding:'utf8'}).trim()); fs.writeFileSync(path.join(gitDir,'HEAD'),'not a ref');}\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'worktree-poison-build.mjs'),
    `import {execFileSync} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'}); if(fs.readFileSync('version.txt','utf8').trim()==='broken'){const gitDir=path.resolve(execFileSync('git',['rev-parse','--git-dir'],{encoding:'utf8'}).trim()); const decoy=path.join(path.dirname(path.dirname(gitDir)),'build-worktree-decoy'); fs.mkdirSync(decoy,{recursive:true}); execFileSync('git',['config','core.worktree',decoy]); process.exit(1);}\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'server.mjs'),
    `import http from 'node:http'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
http.createServer((req,res)=>{ if(req.url!=='/health'){res.statusCode=404; return res.end();} const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); const built=fs.readFileSync('.built','utf8').trim(); const healthy=fs.readFileSync('healthy.txt','utf8').trim()==='yes' && built===commit; res.statusCode=healthy?200:503; res.setHeader('content-type','application/json'); res.end(JSON.stringify({status:healthy?'ok':'error',commit,version:fs.readFileSync('version.txt','utf8').trim(),supervised:process.env.JARVIS_SUPERVISED,requestPath:process.env.JARVIS_UPGRADE_REQUEST_PATH,upgradeSocket:process.env.JARVIS_UPGRADE_SOCKET,implementer:process.env.JARVIS_IMPLEMENTER_PROVIDER,codexBin:process.env.JARVIS_CODEX_BIN})); }).listen(Number(process.env.PORT),'127.0.0.1');\n`,
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
  timeoutMs = SUPERVISOR_TIMEOUT_MS,
  what = 'supervisor evidence',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Polls the settled exit instead of awaiting the one-shot 'exit' event: the
 * child often exits before we get here (the event would never fire again), and
 * a supervisor that never exits must fail the test rather than hang it.
 */
function waitForExit(
  child: ChildProcess,
  timeoutMs = SUPERVISOR_TIMEOUT_MS,
): Promise<number | string> {
  return waitFor(() => child.exitCode ?? child.signalCode, timeoutMs, 'supervisor exit');
}

async function submit(
  endpoint: string,
  request: unknown,
): Promise<{ accepted?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    // Generous on purpose: this only exists to turn a hung socket into a failure
    // rather than a stalled suite. A tight bound turns CPU contention into a
    // false negative, which is how this suite first failed.
    socket.setTimeout(SUPERVISOR_TIMEOUT_MS, () =>
      socket.destroy(new Error('timed out waiting for supervisor')),
    );
    socket.setEncoding('utf8');
    let pending = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const response = JSON.parse(pending.slice(0, newline)) as {
        accepted?: boolean;
        error?: string;
      };
      if (response.accepted) socket.end('ack\n');
      else socket.end();
      resolve(response);
    });
    socket.once('error', reject);
  });
}

async function runActivation(
  healthyCandidate: boolean,
  tamperCommand = false,
  activationToken = ACTIVATION_TOKEN,
  daemonizeBuild = false,
  poisonGit = false,
  checkoutFilter: 'smudge' | 'process' | null = null,
  mixedCaseGitEnv = false,
  poisonRollbackFilter: boolean | 'fail' = false,
  corruptGitHead = false,
  poisonWorktree = false,
  concealTargetResidue = false,
) {
  const setup = fixture(healthyCandidate);
  const selectedPort = await port();
  const requestFile = path.join(setup.stateDir, 'activate.json');
  const transactionId = healthyCandidate ? 'good-activation' : 'broken-activation';
  const resultPath = path.join(setup.stateDir, `${transactionId}.result.json`);
  const evidenceKeys = generateKeyPairSync('ed25519');
  const evidencePrivateKey = evidenceKeys.privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const healthUrl = `http://127.0.0.1:${selectedPort}/health`;
  const startCommand = {
    executable: process.execPath,
    args: ['server.mjs'],
    env: { PORT: String(selectedPort) },
  };
  const buildCommand = {
    executable: process.execPath,
    args: [
      poisonWorktree
        ? 'worktree-poison-build.mjs'
        : poisonRollbackFilter || corruptGitHead
          ? 'poison-build.mjs'
          : 'build.mjs',
    ],
    ...(daemonizeBuild ? { env: { DAEMONIZE_BUILD: '1' } } : {}),
    ...(corruptGitHead ? { env: { CORRUPT_GIT_HEAD: '1' } } : {}),
    ...(poisonRollbackFilter === 'fail' ? { env: { POISON_THEN_FAIL: '1' } } : {}),
  };
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
      // What `pnpm dev` forwards: non-secret operator configuration that must
      // survive every supervised start, including the post-activation restart.
      runtimeEnv: { JARVIS_IMPLEMENTER_PROVIDER: 'claude', JARVIS_CODEX_BIN: DISABLED_CODEX },
      pollMs: 30,
      healthTimeoutMs: 1_200,
      commandTimeoutMs: 5_000,
      once: true,
    }),
  );

  let candidateWorktree: string | null = null;
  if (poisonGit || checkoutFilter) {
    candidateWorktree = path.join(setup.root, 'candidate-worktree');
    git(setup.repo, 'worktree', 'add', candidateWorktree, 'candidate');
  }

  if (poisonGit && candidateWorktree) {
    const forged = git(
      candidateWorktree,
      'commit-tree',
      `${setup.previousSha}^{tree}`,
      '-p',
      setup.previousSha,
      '-m',
      'forged replacement',
    );
    git(candidateWorktree, 'replace', setup.candidateSha, forged);
    const fsmonitor = path.join(setup.root, 'fsmonitor.mjs');
    const hook = path.join(setup.root, 'hook.mjs');
    fs.writeFileSync(
      fsmonitor,
      `import fs from 'node:fs'; fs.writeFileSync('.fsmonitor-ran','yes'); process.stdout.write('0\\0');\n`,
    );
    fs.writeFileSync(hook, `import fs from 'node:fs'; fs.writeFileSync('.hook-ran','yes');\n`);
    const hooks = path.join(setup.root, 'hooks');
    fs.mkdirSync(hooks);
    const postMerge = path.join(hooks, 'post-merge');
    fs.writeFileSync(postMerge, `#!/bin/sh\nnode ${JSON.stringify(hook)}\n`);
    fs.chmodSync(postMerge, 0o755);
    git(candidateWorktree, 'config', 'core.fsmonitor', `node ${JSON.stringify(fsmonitor)}`);
    git(candidateWorktree, 'config', 'core.hooksPath', hooks);
    const decoy = path.join(setup.root, 'configured-worktree-decoy');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, 'version.txt'), 'decoy\n');
    git(candidateWorktree, 'config', 'core.worktree', decoy);
  }

  if (checkoutFilter && candidateWorktree) {
    fs.writeFileSync(path.join(candidateWorktree, '.gitattributes'), 'filtered.txt filter=evil\n');
    fs.writeFileSync(path.join(candidateWorktree, 'filtered.txt'), 'exact candidate bytes\n');
    git(candidateWorktree, 'add', '.gitattributes', 'filtered.txt');
    git(candidateWorktree, 'commit', '--amend', '--no-edit');
    setup.candidateSha = git(candidateWorktree, 'rev-parse', 'HEAD');
    const marker = path.join(setup.repo, `.${checkoutFilter}-ran`);
    const driver = path.join(setup.root, `${checkoutFilter}-filter.mjs`);
    fs.writeFileSync(
      driver,
      checkoutFilter === 'smudge'
        ? `import fs from 'node:fs'; fs.writeFileSync(process.argv[2],'yes'); process.stdin.pipe(process.stdout);\n`
        : `import fs from 'node:fs'; fs.writeFileSync(process.argv[2],'yes'); setTimeout(()=>process.exit(1),1000);\n`,
    );
    git(
      candidateWorktree,
      'config',
      `filter.evil.${checkoutFilter}`,
      `node ${JSON.stringify(driver)} ${JSON.stringify(marker)}`,
    );
    git(candidateWorktree, 'config', 'filter.evil.required', 'true');
  }

  const child = spawn(process.execPath, [supervisor, configFile], {
    cwd: setup.repo,
    env: {
      ...process.env,
      GITHUB_TOKEN: AMBIENT_TOKEN,
      ...(mixedCaseGitEnv ? { Git_CONFIG_COUNT: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  let logs = '';
  child.stdout?.on('data', (chunk) => (logs += chunk));
  child.stderr?.on('data', (chunk) => (logs += chunk));

  const initialHealth = await waitFor(async () => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      const body = (await response.json()) as { commit?: string; upgradeSocket?: string };
      return response.ok && body.commit === setup.previousSha && body.upgradeSocket ? body : null;
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
    evidencePrivateKey,
  };
  if (tamperCommand) request.buildCommand = { ...buildCommand, args: ['malicious.mjs'] };
  if (concealTargetResidue) {
    // Unreviewed bytes in the target, hidden from status by a shared exclude
    // that is neither tracked nor visible in any reviewed diff.
    fs.mkdirSync(path.join(setup.repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(setup.repo, '.git', 'info', 'exclude'), 'unreviewed.js\n');
    fs.writeFileSync(path.join(setup.repo, 'unreviewed.js'), 'throw new Error("unreviewed");\n');
  }
  const response = await submit(initialHealth.upgradeSocket as string, request);

  if (tamperCommand || activationToken !== ACTIVATION_TOKEN) {
    const code = await waitForExit(child);
    children.splice(children.indexOf(child), 1);
    const rejected = fs
      .readdirSync(setup.stateDir)
      .find((name) => name.startsWith('activate.json.') && name.endsWith('.rejected'));
    const evidence: Record<string, unknown> = {
      supervisorExitCode: code,
      logs,
      response,
      resultExists: fs.existsSync(resultPath),
      rejection: rejected
        ? JSON.parse(fs.readFileSync(path.join(setup.stateDir, rejected), 'utf8'))
        : null,
    };
    return { ...setup, evidence, evidencePublicKey: evidenceKeys.publicKey };
  }

  const evidence = await waitFor(() =>
    fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>)
      : null,
  );
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`supervisor exited ${code}: ${logs}`);
  children.splice(children.indexOf(child), 1);
  return { ...setup, evidence, logs, response, evidencePublicKey: evidenceKeys.publicKey };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

afterEach(async () => {
  // `child.kill()` reaps only the supervisor itself. Its build and runtime
  // grandchildren survive on Windows, and a leaked fixture server answering
  // /health with a stale commit starves every later activation test.
  for (const child of children.splice(0)) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        continue;
      } catch {
        // Already gone: fall through to the portable kill below.
      }
    }
    child.kill();
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('external self-upgrade supervisor', () => {
  it('settles the exit wait for an already-exited child and bounds one that never exits', async () => {
    const opts = { windowsHide: true, stdio: 'ignore' as const };
    const done = spawn(process.execPath, ['-e', 'process.exit(3)'], opts);
    await new Promise((resolve) => done.once('exit', resolve));
    expect(await waitForExit(done)).toBe(3);

    const hung = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], opts);
    children.push(hung);
    await expect(waitForExit(hung, 200)).rejects.toThrow('timed out waiting for supervisor exit');
  });

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
          // Operator runtime configuration survives the activation restart.
          implementer: 'claude',
          codexBin: DISABLED_CODEX,
        },
      },
    });
    const { evidenceSignature, ...signed } = result.evidence;
    expect(
      verifyBytes(
        null,
        Buffer.from(stableJson(signed), 'utf8'),
        result.evidencePublicKey,
        Buffer.from(String(evidenceSignature), 'base64'),
      ),
    ).toBe(true);
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.candidateSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
    const processed = fs.readFileSync(
      path.join(result.stateDir, 'activate.json.good-activation.processed'),
      'utf8',
    );
    expect(processed).not.toContain(ACTIVATION_TOKEN);
    const observed = fs.readFileSync(path.join(result.repo, '.observed-env'), 'utf8');
    expect(JSON.parse(observed).codexBin).toBe(DISABLED_CODEX);
    expect(observed).not.toContain(ACTIVATION_TOKEN);
    expect(observed).not.toContain(AMBIENT_TOKEN);
    expect(observed).not.toContain('activate.json');
    expect(observed).not.toContain('jarvis-upgrade-');
    expect(JSON.stringify(result.evidence)).not.toContain(ACTIVATION_TOKEN);
    expect(result.logs).not.toContain(ACTIVATION_TOKEN);
    expect(result.logs).not.toContain(AMBIENT_TOKEN);
    const persistedState = fs
      .readdirSync(result.stateDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(result.stateDir, entry.name), 'utf8'))
      .join('\n');
    expect(persistedState).not.toContain(ACTIVATION_TOKEN);
    expect(persistedState).not.toContain('BEGIN PRIVATE KEY');
  });

  it('ignores shared replacement refs and executable Git configuration', async () => {
    const result = await runActivation(true, false, ACTIVATION_TOKEN, false, true);
    expect(result.evidence).toMatchObject({
      status: 'activated',
      headAfter: result.candidateSha,
      healthcheck: { body: { commit: result.candidateSha, version: 'new' } },
    });
    expect(fs.existsSync(path.join(result.repo, '.fsmonitor-ran'))).toBe(false);
    expect(fs.existsSync(path.join(result.repo, '.hook-ran'))).toBe(false);
  });

  it('rolls back the real commit graph despite poisoned shared Git state', async () => {
    const result = await runActivation(false, false, ACTIVATION_TOKEN, false, true);
    expect(result.evidence).toMatchObject({
      status: 'rolled_back',
      rollbackSha: result.previousSha,
      headAfter: result.previousSha,
      rollbackHealthcheck: { body: { commit: result.previousSha, version: 'old' } },
    });
    expect(fs.existsSync(path.join(result.repo, '.fsmonitor-ran'))).toBe(false);
    expect(fs.existsSync(path.join(result.repo, '.hook-ran'))).toBe(false);
  });

  it('scrubs mixed-case inherited Git configuration on Windows', async () => {
    if (process.platform !== 'win32') return;
    const result = await runActivation(true, false, ACTIVATION_TOKEN, false, false, null, true);
    expect(result.evidence).toMatchObject({ status: 'activated', headAfter: result.candidateSha });
  });

  it.each(['smudge', 'process'] as const)(
    'rejects a candidate tree that requests an executable %s filter',
    async (filter) => {
      const result = await runActivation(true, false, ACTIVATION_TOKEN, false, false, filter);
      expect(result.evidence).toMatchObject({
        status: 'rejected',
        error: 'checkout filter is prohibited for filtered.txt',
      });
      expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.previousSha);
      expect(fs.existsSync(path.join(result.repo, `.${filter}-ran`))).toBe(false);
    },
  );

  it('ignores a filter planted by the failed candidate build during rollback', async () => {
    const result = await runActivation(
      false,
      false,
      ACTIVATION_TOKEN,
      false,
      false,
      null,
      false,
      true,
    );
    expect(result.evidence).toMatchObject({
      status: 'rolled_back',
      rollbackSha: result.previousSha,
      headAfter: result.previousSha,
    });
    const gitDir = path.resolve(result.repo, git(result.repo, 'rev-parse', '--git-dir'));
    expect(fs.existsSync(path.join(gitDir, 'rollback-filter-ran'))).toBe(false);
  });

  it('rolls back after a build that plants attributes and then fails', async () => {
    const result = await runActivation(
      false,
      false,
      ACTIVATION_TOKEN,
      false,
      false,
      null,
      false,
      'fail',
    );
    // The planted filter must be quarantined before state is read, or this
    // rollback is reported blocked instead of being performed.
    expect(result.evidence).toMatchObject({
      status: 'rolled_back',
      rollbackSha: result.previousSha,
      headAfter: result.previousSha,
    });
    const gitDir = path.resolve(result.repo, git(result.repo, 'rev-parse', '--git-dir'));
    expect(fs.existsSync(path.join(gitDir, 'rollback-filter-ran'))).toBe(false);
  });

  it('refuses a target whose unreviewed files are hidden by a shared exclude', async () => {
    // The quarantine of build-planted excludes is only sound because activation
    // cannot start from a tree that is already concealing something.
    const result = await runActivation(
      true,
      false,
      ACTIVATION_TOKEN,
      false,
      false,
      null,
      false,
      false,
      false,
      false,
      true,
    );
    expect(result.evidence).toMatchObject({ status: 'rejected' });
    expect(String(result.evidence.error)).toContain('dirty');
    expect(fs.readFileSync(path.join(result.repo, 'version.txt'), 'utf8').trim()).toBe('old');
  });

  it('rolls back the registered checkout after a build plants core.worktree', async () => {
    const result = await runActivation(
      false,
      false,
      ACTIVATION_TOKEN,
      false,
      false,
      null,
      false,
      false,
      false,
      true,
    );
    expect(result.evidence).toMatchObject({
      status: 'rolled_back',
      rollbackSha: result.previousSha,
      headAfter: result.previousSha,
    });
    expect(fs.readFileSync(path.join(result.repo, 'version.txt'), 'utf8').trim()).toBe('old');
    expect(fs.existsSync(path.join(result.root, 'build-worktree-decoy', 'version.txt'))).toBe(
      false,
    );
  });

  it('still signs evidence when the candidate build makes repository state unreadable', async () => {
    const result = await runActivation(
      true,
      false,
      ACTIVATION_TOKEN,
      false,
      false,
      null,
      false,
      false,
      true,
    );
    // Without a guarded state read the exception escapes activate(), kills the
    // supervisor and leaves the transaction pending with no evidence at all.
    expect(result.evidence).toMatchObject({ status: 'rollback_blocked', headAfter: null });
    expect(String(result.evidence.error)).toMatch(/clean=false/);
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

  it('contains a detached Windows build descendant before activation completes', async () => {
    if (process.platform !== 'win32') return;
    const result = await runActivation(true, false, ACTIVATION_TOKEN, true);
    expect(result.evidence).toMatchObject({ status: 'activated' });
    const pid = Number(fs.readFileSync(path.join(result.repo, '.daemon-pid'), 'utf8'));
    await waitFor(() => (processAlive(pid) ? null : true));
  });

  it('rejects activation commands that differ from operator configuration', async () => {
    const result = await runActivation(true, true);
    expect(result.evidence).toMatchObject({
      supervisorExitCode: 0,
      resultExists: false,
      response: { accepted: false, error: 'buildCommand does not match supervisor config' },
      rejection: { status: 'rejected', error: 'buildCommand does not match supervisor config' },
    });
    expect(git(result.repo, 'rev-parse', 'HEAD')).toBe(result.previousSha);
    expect(git(result.repo, 'status', '--porcelain')).toBe('');
  });

  it('rejects operator runtime configuration that carries a secret', async () => {
    const setup = fixture(true);
    const configFile = path.join(setup.stateDir, 'supervisor.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repository: setup.repo,
        requestFile: path.join(setup.stateDir, 'activate.json'),
        activationTokenHash: createHash('sha256').update(ACTIVATION_TOKEN).digest('hex'),
        healthUrl: 'http://127.0.0.1:4319/health',
        startCommand: { executable: process.execPath, args: ['server.mjs'] },
        buildCommand: { executable: process.execPath, args: ['build.mjs'] },
        runtimeEnv: { GITHUB_TOKEN: AMBIENT_TOKEN },
      }),
    );
    const child = spawn(process.execPath, [supervisor, configFile], {
      cwd: setup.repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    let logs = '';
    child.stderr?.on('data', (chunk) => (logs += chunk));
    expect(await waitForExit(child)).toBe(1);
    children.splice(children.indexOf(child), 1);
    expect(logs).toContain('runtimeEnv must not carry GITHUB_TOKEN');
    expect(logs).not.toContain(AMBIENT_TOKEN);
  });

  it('rejects a self-asserted approval without the out-of-band human token', async () => {
    const attackerToken = 'attacker-cannot-self-approve-0123456789';
    const result = await runActivation(true, false, attackerToken);
    expect(result.evidence).toMatchObject({
      supervisorExitCode: 0,
      resultExists: false,
      response: { accepted: false, error: 'activation request human token is invalid' },
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
