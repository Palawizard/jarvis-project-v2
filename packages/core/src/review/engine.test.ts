import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type {
  AgentProvider,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
  ProviderId,
} from '../agents/types.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { JobService } from '../jobs/service.js';
import { parseReviewOutput, ReviewEngine } from './engine.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

class ReviewProvider implements AgentProvider {
  calls = 0;
  lastOptions: AgentStartOptions | null = null;

  constructor(
    readonly id: ProviderId,
    private readonly result: AgentRunResult,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: true,
      authenticated: true,
      streaming: true,
      resumable: true,
      models: [],
      structuredOutput: true,
    };
  }

  async run(options: AgentStartOptions): Promise<AgentRunResult> {
    this.calls++;
    this.lastOptions = options;
    return this.result;
  }
}

describe('review provider resilience', () => {
  it('records a spend-limit failure, cools down Claude, and reroutes the same review to Codex', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-route-'));
    homes.push(home);
    const base = loadConfig({ home, dbPath: ':memory:' });
    const config = loadConfig({
      home,
      dbPath: ':memory:',
      pipeline: { ...base.pipeline, agentStageRetries: 2 },
      agents: { ...base.agents, reviewerProvider: 'claude' },
    });
    const db = openDb(config);
    const bus = new EventBus(db);
    db.prepare(
      `INSERT INTO projects
        (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('project-review', 'review-route', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    const jobs = new JobService(db, bus);
    const job = jobs.create({ projectId: 'project-review', request: 'Review a candidate.' });
    const claude = new ReviewProvider('claude', {
      status: 'failed',
      result: '',
      error: "You've hit your monthly spend limit for this session",
      memoryProposals: [],
    });
    const secret = 'Jarvis human pairing token: review-must-not-persist';
    const codex = new ReviewProvider('codex', {
      status: 'completed',
      result: `\`\`\`json\n{"verdict":"approve","summary":"looks good ${secret}","findings":[]}\n\`\`\``,
      memoryProposals: [],
    });
    const agents = new AgentRegistry(config, { providers: [claude, codex], db, bus });
    const result = await new ReviewEngine(db, agents, bus, config).review({
      jobId: job.id,
      cwd: home,
      request: job.request,
      goal: job.goal,
      acceptance: [],
      diff: 'diff --git a/a b/a',
      files: [{ path: 'a', added: 1, removed: 0 }],
      verification: {
        passed: true,
        ran: 1,
        failureSummary: '',
        failureKind: 'none',
        results: [],
      },
      contextPack: '',
      contextPackId: 'fixture-pack',
      implementerProvider: 'codex',
      implementerSummary: 'implemented',
      headRef: 'a'.repeat(40),
    });

    expect(result.verdict).toBe('approve');
    expect(result.provider).toBe('codex');
    expect(claude.calls).toBe(1);
    expect(codex.calls).toBe(1);
    expect(codex.lastOptions?.resumeSessionId).toBeUndefined();
    expect(codex.lastOptions?.prompt).toContain('Visual QA runs later');
    expect(codex.lastOptions?.prompt).toContain('do not claim visual validation');
    expect(
      (await agents.capabilities()).find((item) => item.id === 'claude')?.cooldownUntil,
    ).toBeTruthy();
    expect(
      jobs.runs(job.id).map((run) => ({ provider: run.provider, status: run.status })),
    ).toEqual([
      { provider: 'claude', status: 'failed' },
      { provider: 'codex', status: 'completed' },
    ]);
    expect(bus.list().some((event) => event.type === 'agent.rate_limited')).toBe(true);
    const persisted = JSON.stringify({ result, runs: jobs.runs(job.id), events: bus.list() });
    expect(persisted).not.toContain('review-must-not-persist');
    expect(persisted).toContain('[redacted:jarvis_pairing_token]');
    db.close();
  });

  it.each([
    [
      'request_changes with a malformed critical finding',
      '```json\n{"verdict":"request_changes","summary":"bad","findings":[{"severity":"critical","category":"security","description":12,"recommendation":"fix"}]}\n```',
    ],
    ['a missing findings array', '```json\n{"verdict":"approve","summary":"clean"}\n```'],
    [
      'request_changes with advisory-only findings',
      '```json\n{"verdict":"request_changes","summary":"advisory","findings":[{"severity":"medium","category":"style","description":"Optional cleanup","recommendation":"Consider renaming"}]}\n```',
    ],
    [
      'a clean block followed by a hidden critical warning',
      '```json\n{"verdict":"approve","summary":"clean","findings":[]}\n```\nCRITICAL: hidden authority bypass',
    ],
    [
      'a blocking block followed by a clean block',
      '```json\n{"verdict":"request_changes","summary":"blocked","findings":[{"severity":"critical","category":"security","description":"Authority bypass","recommendation":"Authenticate"}]}\n```\n```json\n{"verdict":"approve","summary":"clean","findings":[]}\n```',
    ],
  ])('rejects %s as a protocol error', (_name, output) => {
    expect(parseReviewOutput(output).verdict).toBe('error');
  });

  it('never approves a claimed approve with a valid critical finding', () => {
    const result = parseReviewOutput(
      '```json\n{"verdict":"approve","summary":"claimed clean","findings":[{"severity":"critical","category":"security","description":"Authority bypass","recommendation":"Authenticate it"}]}\n```',
    );
    expect(result.verdict).toBe('request_changes');
  });

  it('accepts a clean, well-formed approve', () => {
    expect(
      parseReviewOutput(
        '```json\n{"verdict":"approve","summary":"Clean review","findings":[]}\n```',
      ).verdict,
    ).toBe('approve');
  });
});
