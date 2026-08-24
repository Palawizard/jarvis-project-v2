#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').trim();

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

function git(repo, args) {
  return clean(
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
}

function state(repo) {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    branch: git(repo, ['symbolic-ref', '--short', 'HEAD']),
    clean: git(repo, ['status', '--porcelain', '--untracked-files=normal']) === '',
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

function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo = fs.realpathSync(raw.repository);
  const root = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  if (root !== repo) throw new Error(`repository must be the Git root: ${root}`);
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
  };
}

function preflight(request) {
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

async function spawnProcess(spec, repo, requestFile, activationTokenHash, stdio = 'inherit') {
  const child = spawn(spec.executable, spec.args, {
    cwd: repo,
    env: {
      ...process.env,
      ...spec.env,
      JARVIS_SUPERVISED: '1',
      JARVIS_UPGRADE_REQUEST_PATH: requestFile,
      JARVIS_UPGRADE_TOKEN_HASH: activationTokenHash,
    },
    stdio,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

async function runBuild(config) {
  const started = Date.now();
  const child = await spawnProcess(
    config.buildCommand,
    config.repository,
    config.requestFile,
    config.activationTokenHash,
    ['ignore', 'pipe', 'pipe'],
  );
  let output = '';
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-8_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timeout = setTimeout(() => void stopChild(child), config.commandTimeoutMs);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`build exited with code ${code}: ${output.trim()}`);
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
    config.requestFile,
    config.activationTokenHash,
  );
  try {
    return { child, health: await waitForHealth(config, child, sha) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
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
    git(config.repository, ['merge', '--ff-only', '--no-edit', request.candidateSha]);
    requireState(config.repository, request.candidateSha);
    evidence.build = await runBuild(runtime);
    requireState(config.repository, request.candidateSha);
    const started = await startHealthy(runtime, request.candidateSha);
    child = started.child;
    evidence.healthcheck = started.health;
    requireState(config.repository, request.candidateSha);
    return {
      child,
      evidence: {
        ...evidence,
        status: 'activated',
        headAfter: request.candidateSha,
        finishedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    evidence.activationError = error instanceof Error ? error.message : String(error);
    await stopChild(child);
    child = null;
    const failedState = state(config.repository);

    if (failedState.clean && failedState.head === request.candidateSha) {
      evidence.rollbackStartedAt = new Date().toISOString();
      try {
        git(config.repository, ['reset', '--hard', request.previousSha]);
        requireState(config.repository, request.previousSha);
        evidence.rollbackBuild = await runBuild(runtime);
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
            headAfter: state(config.repository).head,
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
        error: `rollback requires clean HEAD ${request.candidateSha}; found ${failedState.head}, clean=${failedState.clean}`,
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
      if (!fs.existsSync(config.requestFile)) {
        await delay(config.pollMs);
        continue;
      }

      const processing = `${config.requestFile}.processing`;
      if (fs.existsSync(processing)) throw new Error(`ambiguous pending request: ${processing}`);
      fs.renameSync(config.requestFile, processing);
      let request;
      try {
        request = validateRequest(JSON.parse(fs.readFileSync(processing, 'utf8')), config);
        // Consume the human secret before any candidate-controlled build or
        // runtime can observe the request path. The validated request returned
        // above deliberately contains no activationToken.
        atomicJson(processing, request);
      } catch (error) {
        const rejected = `${config.requestFile}.${Date.now()}.rejected`;
        fs.rmSync(processing, { force: true });
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
      atomicJson(evidenceFile, outcome.evidence);
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
  }
}

main().catch((error) => {
  process.stderr.write(
    `Jarvis supervisor failed: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exitCode = 1;
});
