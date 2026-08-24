import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { JobService } from '../jobs/service.js';
import type { VisualQaShot } from './engine.js';
import type { AgentEvent, AgentProvider, ProviderCapabilities } from '../agents/types.js';
import { hasCompleteClaudeImageReads, parseVisualReview, VisualReviewer } from './reviewer.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('visual reviewer', () => {
  const digest = 'a'.repeat(64);
  const shotRef = {
    id: 'shot-mobile-home',
    scenarioName: 'mobile home',
    route: '/',
    viewport: 'mobile' as const,
    status: 'captured' as const,
    screenshotPath: `visual-${digest}.png`,
  };
  const reviewedEvidence = [{ shotId: shotRef.id, sha256: digest }];

  it('normalizes structured findings and refuses a pass with a high finding', () => {
    const review = parseVisualReview(
      {
        verdict: 'pass',
        reviewedEvidence,
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
        reviewedEvidence: [{ shotId: 'shot-tools', sha256: digest }],
        findings: [
          { ...finding, severity: 'low' },
          { ...finding, severity: 'info' },
        ],
      },
      [
        {
          id: 'shot-tools',
          ...finding,
          status: 'captured',
          screenshotPath: `visual-${digest}.png`,
        },
      ],
    );
    expect(review.verdict).toBe('error');
  });

  it('rejects malformed findings and missing findings arrays', () => {
    expect(
      parseVisualReview({
        verdict: 'needs_fix',
        reviewedEvidence: [],
        findings: [{ severity: 'high' }],
      }).verdict,
    ).toBe('error');
    expect(parseVisualReview({ verdict: 'pass' }).verdict).toBe('error');
  });

  it('rejects a finding that does not match an exact successful shot tuple', () => {
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        reviewedEvidence,
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

  it('requires an exact, duplicate-free acknowledgement of every image digest', () => {
    const review = parseVisualReview(
      {
        verdict: 'pass',
        reviewedEvidence: [reviewedEvidence[0], reviewedEvidence[0]],
        findings: [],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('error');
    expect(review.error).toContain('reviewedEvidence');
  });

  it('accepts Claude evidence only after every exact Read completes successfully', () => {
    const first = path.resolve('one.png');
    const second = path.resolve('two.png');
    const events: AgentEvent[] = [
      { kind: 'tool_started', tool: 'Read', id: 'r1', input: { file_path: first } },
      { kind: 'tool_completed', id: 'r1', isError: false },
      { kind: 'tool_started', tool: 'Read', id: 'r2', input: { file_path: second } },
      { kind: 'tool_completed', id: 'r2', isError: true },
    ];
    expect(hasCompleteClaudeImageReads(events, [first, second], process.cwd())).toBe(false);
    events[3] = { kind: 'tool_completed', id: 'r2', isError: false };
    expect(hasCompleteClaudeImageReads(events, [first, second], process.cwd())).toBe(true);
  });

  it.each([
    ['rejects', [] as AgentEvent[], 'error'],
    [
      'accepts',
      [
        {
          kind: 'tool_started',
          tool: 'Read',
          id: 'read-shot',
          input: { file_path: '__IMAGE__' },
        },
        { kind: 'tool_completed', id: 'read-shot', isError: false },
      ] as AgentEvent[],
      'pass',
    ],
  ])(
    '%s a schema-valid Claude pass based on exact Read evidence',
    async (_name, events, verdict) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reviewer-'));
      roots.push(root);
      const config = loadConfig({ home: root, dbPath: ':memory:' });
      const db = openDb(config);
      const bus = new EventBus(db);
      const jobs = new JobService(db, bus);
      db.prepare(
        `INSERT INTO projects (id,name,root_path,default_branch,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
      ).run('prj_visual', 'visual', root, 'main', 'now', 'now');
      const job = jobs.create({ projectId: 'prj_visual', request: 'inspect pixels' });
      const pixels = Buffer.from('exact screenshot pixels');
      const sha256 = createHash('sha256').update(pixels).digest('hex');
      const screenshotPath = path.join(config.artifactsDir, `visual-${sha256}.png`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, pixels);
      const shot: VisualQaShot = {
        id: 'shot-provider-proof',
        scenarioName: 'home',
        route: '/',
        viewport: 'desktop',
        screenshotPath,
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
      db.prepare(
        `INSERT INTO visual_qa
        (id,job_id,project_id,scenario_name,route,viewport,screenshot_path,console_errors,
         network_failures,status,head_ref,cycle,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        shot.id,
        job.id,
        'prj_visual',
        shot.scenarioName,
        shot.route,
        shot.viewport,
        screenshotPath,
        '[]',
        '[]',
        'captured',
        shot.headRef,
        0,
        shot.createdAt,
      );
      const materializedEvents = events.map((event) =>
        event.kind === 'tool_started'
          ? {
              ...event,
              input: { file_path: screenshotPath },
            }
          : event,
      );
      const secret = 'Jarvis human pairing token: visual-review-must-not-persist';
      const provider = fakeClaudeProvider(materializedEvents, {
        verdict: 'pass',
        reviewedEvidence: [{ shotId: shot.id, sha256 }],
        findings: [
          {
            severity: 'low',
            scenarioName: shot.scenarioName,
            route: shot.route,
            viewport: shot.viewport,
            category: 'copy',
            description: secret,
            recommendation: 'No action required',
          },
        ],
      });
      const reviewer = new VisualReviewer(
        db,
        new AgentRegistry(config, { providers: [provider], db, bus }),
        jobs,
        config.artifactsDir,
        bus,
        config,
      );
      const result = await reviewer.review({
        jobId: job.id,
        cwd: root,
        goal: 'Show the home page',
        acceptance: [],
        shots: [shot],
      });
      expect(result.verdict).toBe(verdict);
      const row = db
        .prepare('SELECT reviewed_by,review_findings FROM visual_qa WHERE id=?')
        .get(shot.id) as {
        reviewed_by: string | null;
        review_findings: string | null;
      };
      expect(row.reviewed_by === null).toBe(verdict === 'error');
      const persisted = JSON.stringify({ row, runs: jobs.runs(job.id), events: bus.list() });
      expect(persisted).not.toContain('visual-review-must-not-persist');
      expect(persisted).toContain('[redacted:jarvis_pairing_token]');
      db.close();
    },
  );

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

function fakeClaudeProvider(events: AgentEvent[], structuredOutput: unknown): AgentProvider {
  const capabilities: ProviderCapabilities = {
    id: 'claude',
    available: true,
    authenticated: true,
    streaming: true,
    resumable: false,
    models: ['fixture'],
    structuredOutput: true,
  };
  return {
    id: 'claude',
    capabilities: async () => capabilities,
    run: async (_options, onEvent) => {
      for (const event of events) onEvent(event);
      return {
        status: 'completed',
        result: JSON.stringify(structuredOutput),
        structuredOutput,
        memoryProposals: [],
      };
    },
  };
}
