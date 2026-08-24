import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { EVIDENCE_COVERAGE_PREFIX, isEvidenceCoverageFailure, VisualQaEngine } from './engine.js';

const roots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function candidate(html: string): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function seeded(): { db: Db; artifacts: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-coverage-'));
  roots.push(root);
  const db = openDb(loadConfig({ home: root, dbPath: ':memory:' }));
  db.prepare(
    `INSERT INTO projects
      (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
     VALUES ('prj','fixture',?, 'main','{}','{}',1,'{}','now','now')`,
  ).run(root);
  db.prepare(
    `INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
     VALUES ('job','prj','capture','capture','visual_qa','running','now','now')`,
  ).run();
  return { db, artifacts: path.join(root, 'artifacts') };
}

describe('expected-surface evidence coverage', () => {
  it('captures normally when the declared selector is present', async () => {
    const baseUrl = await candidate(
      `<!doctype html><div data-testid="pause-explanation">Paused</div>`,
    );
    const { db, artifacts } = seeded();
    try {
      const shots = await new VisualQaEngine(db, artifacts).capture({
        jobId: 'job',
        projectId: 'prj',
        baseUrl,
        routes: ['/'],
        scenarios: [
          {
            name: 'job-detail-paused',
            route: '/',
            expectedSelector: "[data-testid='pause-explanation']",
            viewports: ['desktop'],
          },
        ],
        headRef: 'abc',
      });
      expect(shots).toHaveLength(1);
      expect(shots[0]?.status).toBe('captured');
      expect(isEvidenceCoverageFailure(shots[0] as never)).toBe(false);
    } finally {
      db.close();
    }
  }, 60_000);

  it('marks an unreachable declared selector as evidence coverage, not a defect', async () => {
    const baseUrl = await candidate(`<!doctype html><h1>Command</h1>`);
    const { db, artifacts } = seeded();
    try {
      const shots = await new VisualQaEngine(db, artifacts).capture({
        jobId: 'job',
        projectId: 'prj',
        baseUrl,
        routes: ['/'],
        scenarios: [
          {
            name: 'job-detail-paused',
            route: '/',
            expectedSelector: "[data-testid='pause-explanation']",
            viewports: ['desktop'],
          },
        ],
        headRef: 'abc',
      });
      const shot = shots[0];
      expect(shot?.status).toBe('failed');
      expect(shot?.error?.startsWith(EVIDENCE_COVERAGE_PREFIX)).toBe(true);
      expect(shot?.error).toContain('pause-explanation');
      expect(isEvidenceCoverageFailure(shot as never)).toBe(true);
      // No half-written evidence survives a coverage failure.
      expect(shot?.screenshotPath).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  it('marks a missing interaction target as evidence coverage', async () => {
    const baseUrl = await candidate(`<!doctype html><h1>Command</h1>`);
    const { db, artifacts } = seeded();
    try {
      const shots = await new VisualQaEngine(db, artifacts).capture({
        jobId: 'job',
        projectId: 'prj',
        baseUrl,
        routes: ['/'],
        scenarios: [
          {
            name: 'jobs-list',
            route: '/',
            interactions: [
              { action: 'click', selector: "[data-testid='nav-jobs']" },
              { action: 'wait', selector: "[data-testid='jobs-view']", timeoutMs: 1000 },
            ],
            expectedSelector: "[data-testid='jobs-view']",
            viewports: ['desktop'],
          },
        ],
        headRef: 'abc',
      });
      expect(isEvidenceCoverageFailure(shots[0] as never)).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);

  it('does not classify a browser-launch failure as evidence coverage', () => {
    const { db, artifacts } = seeded();
    try {
      const shot = new VisualQaEngine(db, artifacts).recordFailure({
        jobId: 'job',
        projectId: 'prj',
        route: '(browser launch)',
        error: 'Playwright unavailable: chromium is not installed',
      });
      expect(isEvidenceCoverageFailure(shot)).toBe(false);
    } finally {
      db.close();
    }
  });
});
