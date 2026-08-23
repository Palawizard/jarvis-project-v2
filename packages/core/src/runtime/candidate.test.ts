import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { Project } from '../projects/service.js';
import { CandidateRuntimeUnsupportedError, startCandidateRuntime } from './candidate.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(root: string, configured = true): Project {
  return {
    id: 'prj_fixture',
    name: 'fixture',
    rootPath: root,
    defaultBranch: 'main',
    stack: { languages: ['javascript'], frameworks: [], hasTests: true },
    commands: {},
    devUrl: null,
    summary: null,
    isSelf: false,
    config: configured
      ? {
          candidateRuntime: {
            command: {
              executable: process.execPath,
              args: [
                '-e',
                `require('node:http').createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',home:process.env.JARVIS_HOME,supervised:process.env.JARVIS_SUPERVISED,requestPath:process.env.JARVIS_UPGRADE_REQUEST_PATH,apiKey:process.env.OPENAI_API_KEY}))}).listen(Number(process.env.TEST_PORT),'127.0.0.1')`,
              ],
            },
            portEnvironment: 'TEST_PORT',
            healthPath: '/health',
          },
        }
      : {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** API on its own port, web listener gated on a file so ordering is explicit. */
function splitPortProject(root: string, gate: string, apiHit: string): Project {
  const base = project(root);
  base.config.candidateRuntime = {
    command: {
      executable: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs'),http=require('node:http');` +
          `http.createServer((_,r)=>{fs.writeFileSync(${JSON.stringify(apiHit)},String(process.env.TEST_API_PORT));r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok'}))}).listen(Number(process.env.TEST_API_PORT),'127.0.0.1');` +
          `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);http.createServer((_,r)=>{r.setHeader('content-type','text/html');r.end('<!doctype html><h1>candidate</h1>')}).listen(Number(process.env.TEST_PORT),'127.0.0.1')}},25);`,
      ],
    },
    portEnvironment: 'TEST_PORT',
    apiPortEnvironment: 'TEST_API_PORT',
    healthPath: '/health',
  };
  return base;
}

describe('candidate runtime isolation', () => {
  it('uses a dynamic port and an isolated JARVIS_HOME', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const config = loadConfig({ home: path.join(root, 'jarvis-home') });
    const original = {
      supervised: process.env.JARVIS_SUPERVISED,
      requestPath: process.env.JARVIS_UPGRADE_REQUEST_PATH,
      apiKey: process.env.OPENAI_API_KEY,
    };
    process.env.JARVIS_SUPERVISED = '1';
    process.env.JARVIS_UPGRADE_REQUEST_PATH = path.join(root, 'activation.json');
    process.env.OPENAI_API_KEY = 'must-not-reach-candidate';
    let runtime: Awaited<ReturnType<typeof startCandidateRuntime>> | undefined;
    try {
      const started = await startCandidateRuntime({
        project: project(root),
        cwd: root,
        jobId: 'job_fixture',
        config,
        timeoutMs: 10_000,
      });
      runtime = started;
      expect(started.ports.web).toBeGreaterThan(0);
      expect(started.baseUrl).not.toContain(':5199');
      expect(started.home).toBe(path.join(config.home, 'candidate-runtimes', 'job_fixture'));
      const health = (await (await fetch(started.healthUrl)).json()) as {
        home: string;
        supervised?: string;
        requestPath?: string;
        apiKey?: string;
      };
      expect(health.home).toBe(started.home);
      expect(health.supervised).toBeUndefined();
      expect(health.requestPath).toBeUndefined();
      expect(health.apiKey).toBeUndefined();
      await started.stop();
      await started.stop();
      runtime = undefined;
      await expect(fetch(started.baseUrl, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
    } finally {
      await runtime?.stop();
      restoreEnv('JARVIS_SUPERVISED', original.supervised);
      restoreEnv('JARVIS_UPGRADE_REQUEST_PATH', original.requestPath);
      restoreEnv('OPENAI_API_KEY', original.apiKey);
    }
  });

  it('fails closed when the project cannot remap its candidate port', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    await expect(
      startCandidateRuntime({
        project: project(root, false),
        cwd: root,
        jobId: 'job_unsupported',
        config: loadConfig({ home: path.join(root, 'home') }),
      }),
    ).rejects.toBeInstanceOf(CandidateRuntimeUnsupportedError);
  });

  it('reports an invalid runtime executable without crashing the process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const broken = project(root);
    if (!broken.config.candidateRuntime) throw new Error('fixture runtime missing');
    broken.config.candidateRuntime.command.executable = 'jarvis-command-that-does-not-exist';
    await expect(
      startCandidateRuntime({
        project: broken,
        cwd: root,
        jobId: 'job_bad_executable',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
  });

  it('rejects a self-candidate health response without the launch identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Jarvis Test',
        '-c',
        'user.email=test@localhost',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: root },
    );
    const self = project(root);
    self.isSelf = true;
    if (!self.config.candidateRuntime) throw new Error('fixture runtime missing');
    self.config.candidateRuntime.command.args = [
      '-e',
      `const {execFileSync}=require('node:child_process');require('node:http').createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtimeNonce:'wrong'}))}).listen(Number(process.env.TEST_PORT),'127.0.0.1')`,
    ];
    await expect(
      startCandidateRuntime({
        project: self,
        cwd: root,
        jobId: 'job_wrong_listener',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 750,
      }),
    ).rejects.toThrow('did not pass healthcheck');
  });

  it('waits for the web frontend when the API port becomes healthy first', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const gate = path.join(root, 'start-web');
    const apiHit = path.join(root, 'api-probed');
    let runtime: Awaited<ReturnType<typeof startCandidateRuntime>> | undefined;
    let resolved = false;
    try {
      const starting = startCandidateRuntime({
        project: splitPortProject(root, gate, apiHit),
        cwd: root,
        jobId: 'job_split_port',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 30_000,
      }).then((started) => {
        resolved = true;
        return started;
      });
      starting.catch(() => undefined);

      // The API answered a real health probe; the web listener is still gated,
      // so startCandidateRuntime must not have handed out a dead baseUrl yet.
      await until(() => fs.existsSync(apiHit));
      expect(resolved).toBe(false);

      fs.writeFileSync(gate, 'go');
      runtime = await starting;
      expect(runtime.ports.api).toBeGreaterThan(0);
      expect(runtime.ports.api).not.toBe(runtime.ports.web);
      expect(runtime.baseUrl).toBe(`http://127.0.0.1:${runtime.ports.web}`);
      const page = await fetch(runtime.baseUrl);
      expect(page.ok).toBe(true);
      expect(await page.text()).toContain('candidate');
    } finally {
      await runtime?.stop();
    }
  });

  it('fails closed when the API is healthy but the web frontend never starts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const apiHit = path.join(root, 'api-probed');
    await expect(
      startCandidateRuntime({
        project: splitPortProject(root, path.join(root, 'never'), apiHit),
        cwd: root,
        jobId: 'job_no_web',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow('candidate API is healthy but web frontend did not become ready at');
    // The API really was up, and the failure path still tore the child down.
    const apiUrl = `http://127.0.0.1:${fs.readFileSync(apiHit, 'utf8')}/health`;
    await until(async () => {
      const reachable = await fetch(apiUrl, { signal: AbortSignal.timeout(1000) }).then(
        () => true,
        () => false,
      );
      return !reachable;
    });
  });

  it('rejects a completed 404 frontend and cleans both candidate ports', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const portsFile = path.join(root, 'ports');
    const candidate = project(root);
    candidate.config.candidateRuntime = {
      command: {
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'),http=require('node:http');` +
            `fs.writeFileSync(${JSON.stringify(portsFile)},process.env.TEST_API_PORT+','+process.env.TEST_PORT);` +
            `http.createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok'}))}).listen(Number(process.env.TEST_API_PORT),'127.0.0.1');` +
            `http.createServer((_,r)=>{r.writeHead(404);r.end('missing')}).listen(Number(process.env.TEST_PORT),'127.0.0.1');`,
        ],
      },
      portEnvironment: 'TEST_PORT',
      apiPortEnvironment: 'TEST_API_PORT',
      healthPath: '/health',
    };

    await expect(
      startCandidateRuntime({
        project: candidate,
        cwd: root,
        jobId: 'job_web_404',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow('candidate API is healthy but web frontend did not become ready at');

    for (const port of fs.readFileSync(portsFile, 'utf8').split(',')) {
      await until(() =>
        fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }).then(
          () => false,
          () => true,
        ),
      );
    }
  });

  it('fails closed when startup is cancelled during the final web probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const webHit = path.join(root, 'web-probed');
    const release = path.join(root, 'release-web');
    const candidate = splitPortProject(root, path.join(root, 'start-web'), path.join(root, 'api'));
    if (!candidate.config.candidateRuntime) throw new Error('fixture runtime missing');
    candidate.config.candidateRuntime.command.args = [
      '-e',
      `const fs=require('node:fs'),http=require('node:http');` +
        `http.createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok'}))}).listen(Number(process.env.TEST_API_PORT),'127.0.0.1');` +
        `http.createServer((_,r)=>{fs.writeFileSync(${JSON.stringify(webHit)},process.env.TEST_API_PORT+','+process.env.TEST_PORT);const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);r.end('ready')}},10)}).listen(Number(process.env.TEST_PORT),'127.0.0.1');`,
    ];
    const controller = new AbortController();
    const starting = startCandidateRuntime({
      project: candidate,
      cwd: root,
      jobId: 'job_cancelled_web_probe',
      config: loadConfig({ home: path.join(root, 'home') }),
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    starting.catch(() => undefined);

    await until(() => fs.existsSync(webHit));
    controller.abort();
    fs.writeFileSync(release, 'go');
    await expect(starting).rejects.toThrow('candidate runtime start cancelled');
    for (const port of fs.readFileSync(webHit, 'utf8').split(',')) {
      await until(() =>
        fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(
          () => false,
          () => true,
        ),
      );
    }
  });

  it('fails closed when the candidate exits before the final web body completes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const webHit = path.join(root, 'web-headers-sent');
    const terminate = path.join(root, 'terminate');
    const candidate = splitPortProject(root, path.join(root, 'start-web'), path.join(root, 'api'));
    if (!candidate.config.candidateRuntime) throw new Error('fixture runtime missing');
    candidate.config.candidateRuntime.command.args = [
      '-e',
      `const fs=require('node:fs'),http=require('node:http');` +
        `http.createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok'}))}).listen(Number(process.env.TEST_API_PORT),'127.0.0.1');` +
        `http.createServer((_,r)=>{r.writeHead(200,{'content-type':'text/html','content-length':'5'});r.write('x');fs.writeFileSync(${JSON.stringify(webHit)},process.env.TEST_API_PORT+','+process.env.TEST_PORT);const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(terminate)})){clearInterval(t);process.kill(process.pid,'SIGTERM')}},10)}).listen(Number(process.env.TEST_PORT),'127.0.0.1');`,
    ];

    const starting = startCandidateRuntime({
      project: candidate,
      cwd: root,
      jobId: 'job_exit_during_web_body',
      config: loadConfig({ home: path.join(root, 'home') }),
      timeoutMs: 10_000,
    });
    starting.catch(() => undefined);

    await until(() => fs.existsSync(webHit));
    fs.writeFileSync(terminate, 'go');
    await expect(starting).rejects.toThrow(/candidate runtime exited \((?:SIGTERM|1)\)/);
    for (const port of fs.readFileSync(webHit, 'utf8').split(',')) {
      await until(() =>
        fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(
          () => false,
          () => true,
        ),
      );
    }
  });

  it('reports a candidate terminated by a signal instead of waiting for timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const candidate = splitPortProject(root, path.join(root, 'never'), path.join(root, 'api'));
    if (!candidate.config.candidateRuntime) throw new Error('fixture runtime missing');
    candidate.config.candidateRuntime.command.args = [
      '-e',
      `require('node:http').createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok'}),()=>process.kill(process.pid,'SIGTERM'))}).listen(Number(process.env.TEST_API_PORT),'127.0.0.1')`,
    ];

    await expect(
      startCandidateRuntime({
        project: candidate,
        cwd: root,
        jobId: 'job_signal_exit',
        config: loadConfig({ home: path.join(root, 'home') }),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/candidate runtime exited \((?:SIGTERM|1)\)/);
  });
});

/** Poll until a condition holds; the suite timeout is the only failure mode. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await new Promise((resolve) => setTimeout(resolve, 25));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
