import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { JobService } from '../jobs/service.js';
import type { VisualQaShot } from './engine.js';
import { parseVisualReview, VisualReviewer } from './reviewer.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('visual reviewer', () => {
  const shotRef = {
    scenarioName: 'mobile home',
    route: '/',
    viewport: 'mobile' as const,
    status: 'captured' as const,
  };

  it('normalizes structured findings and refuses a pass with a high finding', () => {
    const review = parseVisualReview(
      {
        verdict: 'pass',
        findings: [
          {
            severity: 'high',
            scenarioName: 'mobile home',
            route: '/',
            viewport: 'mobile',
            category: 'layout',
            description: 'Primary action is clipped',
            recommendation: 'Allow the action row to wrap',
          },
        ],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('needs_fix');
    expect(review.findings).toHaveLength(1);
  });

  it('rejects needs_fix with only advisory findings', () => {
    const finding = {
      scenarioName: 'tools',
      route: '/',
      viewport: 'desktop' as const,
      category: 'polish',
      description: 'Minor alignment preference',
      recommendation: 'Consider aligning labels',
    };
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        findings: [
          { ...finding, severity: 'low' },
          { ...finding, severity: 'info' },
        ],
      },
      [{ ...finding, status: 'captured' }],
    );
    expect(review.verdict).toBe('error');
  });

  it('rejects malformed findings and missing findings arrays', () => {
    expect(
      parseVisualReview({ verdict: 'needs_fix', findings: [{ severity: 'high' }] }).verdict,
    ).toBe('error');
    expect(parseVisualReview({ verdict: 'pass' }).verdict).toBe('error');
  });

  it('rejects a finding that does not match an exact successful shot tuple', () => {
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        findings: [
          {
            severity: 'high',
            scenarioName: 'hallucinated',
            route: '/',
            viewport: 'mobile',
            category: 'layout',
            description: 'Imagined issue',
            recommendation: 'Do not fix imagined evidence',
          },
        ],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('error');
    expect(review.error).toContain('unknown or failed');
  });

  it('reports missing/unavailable review evidence without faking reviewedBy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reviewer-'));
    roots.push(root);
    const config = loadConfig({ home: root, dbPath: ':memory:' });
    const db = openDb(config);
    const bus = new EventBus(db);
    const reviewer = new VisualReviewer(
      db,
      new AgentRegistry(config, { providers: [] }),
      new JobService(db, bus),
      path.join(root, 'artifacts'),
      bus,
    );
    const shot: VisualQaShot = {
      id: 'shot_missing',
      scenarioName: 'home',
      route: '/',
      viewport: 'desktop',
      screenshotPath: path.join(root, 'missing.png'),
      consoleErrors: [],
      networkFailures: [],
      status: 'captured',
      error: null,
      reviewedBy: null,
      reviewVerdict: null,
      reviewFindings: [],
      headRef: 'abc123',
      cycle: 0,
      createdAt: new Date().toISOString(),
    };
    const result = await reviewer.review({
      jobId: 'job_missing',
      cwd: root,
      goal: 'Show a page',
      acceptance: [],
      shots: [shot],
      implementerProvider: 'claude',
    });
    expect(result.verdict).toBe('error');
    expect(shot.reviewedBy).toBeNull();
    expect(shot.status).toBe('failed');
    expect(shot.screenshotPath).toBeNull();
    expect(bus.list().at(-1)?.type).toBe('visual_review.failed');
    db.close();
  });

  it('deletes and invalidates a captured image whose content address is false', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reviewer-'));
    roots.push(root);
    const config = loadConfig({ home: root, dbPath: ':memory:' });
    const db = openDb(config);
    const bus = new EventBus(db);
    const screenshotPath = path.join(config.artifactsDir, `shot-${'0'.repeat(64)}.png`);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, 'tampered pixels');
    const shot: VisualQaShot = {
      id: 'shot_tampered',
      ...shotRef,
      screenshotPath,
      consoleErrors: [],
      networkFailures: [],
      error: null,
      reviewedBy: null,
      reviewVerdict: null,
      reviewFindings: [],
      headRef: 'abc123',
      cycle: 0,
      createdAt: new Date().toISOString(),
    };
    const reviewer = new VisualReviewer(
      db,
      new AgentRegistry(config, { providers: [] }),
      new JobService(db, bus),
      config.artifactsDir,
      bus,
    );
    const result = await reviewer.review({
      jobId: 'job_tampered',
      cwd: root,
      goal: 'Show a page',
      acceptance: [],
      shots: [shot],
    });
    expect(result.verdict).toBe('error');
    expect(shot).toMatchObject({ status: 'failed', screenshotPath: null, reviewedBy: null });
    expect(fs.existsSync(screenshotPath)).toBe(false);
    db.close();
  });
});
