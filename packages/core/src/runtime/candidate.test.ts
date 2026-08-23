import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
                `require('node:http').createServer((_,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',home:process.env.JARVIS_HOME}))}).listen(Number(process.env.TEST_PORT),'127.0.0.1')`,
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

describe('candidate runtime isolation', () => {
  it('uses a dynamic port and an isolated JARVIS_HOME', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runtime-'));
    roots.push(root);
    const config = loadConfig({ home: path.join(root, 'jarvis-home') });
    const runtime = await startCandidateRuntime({
      project: project(root),
      cwd: root,
      jobId: 'job_fixture',
      config,
      timeoutMs: 10_000,
    });
    try {
      expect(runtime.ports.web).toBeGreaterThan(0);
      expect(runtime.baseUrl).not.toContain(':5199');
      expect(runtime.home).toBe(path.join(config.home, 'candidate-runtimes', 'job_fixture'));
      const health = (await (await fetch(runtime.healthUrl)).json()) as { home: string };
      expect(health.home).toBe(runtime.home);
    } finally {
      await runtime.stop();
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
});
