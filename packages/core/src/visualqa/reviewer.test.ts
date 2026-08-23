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
  it('normalizes structured findings and refuses a pass with a high finding', () => {
    const review = parseVisualReview({
      verdict: 'pass',
      findings: [
        {
          severity: 'high',
          route: '/',
          viewport: 'mobile',
          category: 'layout',
          description: 'Primary action is clipped',
          recommendation: 'Allow the action row to wrap',
        },
      ],
    });
    expect(review.verdict).toBe('needs_fix');
    expect(review.findings).toHaveLength(1);
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
    expect(bus.list().at(-1)?.type).toBe('visual_review.failed');
    db.close();
  });
});
