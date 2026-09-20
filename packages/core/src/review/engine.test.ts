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
import {
  checkReviewValue,
  parseReviewOutput,
  ReviewEngine,
  REVIEW_OUTPUT_SCHEMA,
} from './engine.js';

/** The prose shape a CLI can still fall back to. */
const FENCED_APPROVE =
  '```json\n{"verdict":"approve","summary":"Clean change.","findings":[]}\n```';

/**
 * The configured blocking severities, not a literal: these functions have no
 * default of their own any more, and a test that hard-coded one would be free
 * to drift away from the gate it is supposed to be checking.
 */
const BLOCKING = loadConfig({ home: os.tmpdir(), dbPath: ':memory:' }).pipeline
  .codeReviewBlockingSeverities;

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
  it('records a spend-limit failure, reroutes the same review to Codex, and stays routable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-route-'));
    homes.push(home);
    const base = loadConfig({ home, dbPath: ':memory:' });
    const config = loadConfig({
      home,
      dbPath: ':memory:',
      pipeline: { ...base.pipeline, providerAttempts: 2 },
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
    // Recorded, reported -- and still routable. A quota failure is provider
    // state at a moment in time, not a lock a later Resume has to wait out.
    const claudeHealth = (await agents.capabilities()).find((item) => item.id === 'claude');
    expect(claudeHealth?.lastFailureKind).toBe('quota');
    expect(claudeHealth?.available).toBe(true);
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
      '```json\n{"verdict":"request_changes","summary":"advisory","findings":[{"severity":"low","category":"style","description":"Optional cleanup","recommendation":"Consider renaming"}]}\n```',
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
    expect(parseReviewOutput(output, BLOCKING).verdict).toBe('error');
  });

  it('never approves a claimed approve with a valid critical finding', () => {
    const result = parseReviewOutput(
      '```json\n{"verdict":"approve","summary":"claimed clean","findings":[{"severity":"critical","category":"security","description":"Authority bypass","recommendation":"Authenticate it"}]}\n```',
      BLOCKING,
    );
    expect(result.verdict).toBe('request_changes');
  });

  it('accepts a clean, well-formed approve', () => {
    expect(
      parseReviewOutput(
        '```json\n{"verdict":"approve","summary":"Clean review","findings":[]}\n```',
        BLOCKING,
      ).verdict,
    ).toBe('approve');
  });
});

/**
 * The failure that used to burn three comprehensive reviewers in a row:
 *
 *   "Reviewer output failed strict structured validation:
 *    expected exactly one terminal JSON block"
 *
 * The JSON was only ever ASKED for, in prose. The fix is the provider's own
 * constrained-output channel plus the SAME strict validation on the way out --
 * not a looser schema, and not another reviewer.
 */
describe('reviewer structured-output framing', () => {
  const APPROVED = { verdict: 'approve', summary: 'Clean change.', findings: [] };

  function reviewWith(answer: AgentRunResult) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-framing-'));
    homes.push(home);
    const config = loadConfig({ home, dbPath: ':memory:' });
    const db = openDb(config);
    const bus = new EventBus(db);
    db.prepare(
      `INSERT INTO projects
        (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('project-framing', 'framing', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    const jobs = new JobService(db, bus);
    const job = jobs.create({ projectId: 'project-framing', request: 'Review a candidate.' });
    const provider = new ReviewProvider('claude', answer);
    const agents = new AgentRegistry(config, { providers: [provider], db, bus });
    return {
      db,
      bus,
      provider,
      jobs,
      run: () =>
        new ReviewEngine(db, agents, bus, config).review({
          jobId: job.id,
          cwd: home,
          request: 'Review a candidate.',
          goal: 'review',
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
          implementerSummary: 'implemented',
          headRef: 'a'.repeat(40),
        }),
    };
  }

  it('accepts the provider-native constrained answer and keeps the schema out of the worktree', async () => {
    const h = reviewWith({
      status: 'completed',
      result: '',
      structuredOutput: APPROVED,
      memoryProposals: [],
    });
    const result = await h.run();

    expect(result.verdict).toBe('approve');
    expect(result.findings).toEqual([]);
    const schemaPath = h.provider.lastOptions?.outputSchemaPath as string;
    expect(schemaPath).toBeTruthy();
    // A schema file written into the candidate worktree would show up as an
    // uncommitted change, and the candidate-identity assertions would
    // (correctly) refuse the review that produced it.
    expect(schemaPath).toContain('review-output-schema.json');
    expect(schemaPath).toContain(`${path.sep}artifacts${path.sep}`);
    h.db.close();
  });

  it('falls back to the terminal fenced block when the CLI answers in prose anyway', async () => {
    const h = reviewWith({
      status: 'completed',
      result: FENCED_APPROVE,
      memoryProposals: [],
    });
    expect((await h.run()).verdict).toBe('approve');
    h.db.close();
  });

  // Fail-closed is preserved: a structured answer that does not satisfy the
  // strict schema is a protocol error, never a silent approval.
  it('refuses a constrained answer that does not validate', async () => {
    const h = reviewWith({
      status: 'completed',
      result: '',
      structuredOutput: { verdict: 'approve', summary: '', findings: 'none' },
      memoryProposals: [],
    });
    const result = await h.run();

    expect(result.verdict).toBe('error');
    expect(result.blocking).toBe(true);
    // Recorded as a PROVIDER failure, so no product review budget is spent and
    // the commit is never marked as reviewed.
    expect(h.jobs.runs(result.jobId).at(-1)?.status).toBe('failed');
    expect(h.jobs.runs(result.jobId).at(-1)?.error).toContain('protocol failure');
    h.db.close();
  });

  // The constrained channel and the trusted validator must agree on what is
  // acceptable. Where the JSON schema is looser, a provider emits an answer it
  // believes is valid and Jarvis turns it into a protocol error — an
  // infrastructure pause manufactured out of nothing, which is the failure this
  // whole change exists to remove.
  it('bounds every field the trusted validator requires to be non-empty', () => {
    const properties = REVIEW_OUTPUT_SCHEMA.properties;
    expect(properties.summary.minLength).toBe(1);
    const finding = properties.findings.items.properties;
    expect(finding.description.minLength).toBe(1);
    expect(finding.recommendation.minLength).toBe(1);
    expect(finding.file.minLength).toBe(1);
    // `file` and `line` are optional to the trusted schema, but strict
    // Structured Outputs has no optional properties: they are REQUIRED and
    // nullable, and `null` is normalized back to absence. Requiring them
    // non-nullably would manufacture the mirror-image failure.
    expect(REVIEW_OUTPUT_SCHEMA.properties.findings.items.required).toContain('file');
    expect(REVIEW_OUTPUT_SCHEMA.properties.findings.items.required).toContain('line');
    expect(finding.file.type).toEqual(['string', 'null']);
    expect(finding.line.type).toEqual(['integer', 'null']);
  });

  // A provider answering the schema literally sends `null`, not an absent key.
  // The Review that comes out must be indistinguishable from one where the
  // model simply left them out -- otherwise every downstream consumer of
  // `ReviewFinding.file` has to learn about a spelling the provider chose.
  it('accepts a null file/line and produces findings without those fields', () => {
    const checked = checkReviewValue(
      {
        verdict: 'request_changes',
        summary: 'One blocking issue.',
        findings: [
          {
            severity: 'high',
            category: 'correctness',
            file: null,
            line: null,
            description: 'Repository-wide problem with no single location.',
            recommendation: 'Fix it.',
          },
          {
            severity: 'low',
            category: 'style',
            file: 'src/a.ts',
            line: 12,
            description: 'Naming.',
            recommendation: 'Rename.',
          },
        ],
      },
      BLOCKING,
    );
    expect(checked.verdict).toBe('request_changes');
    expect(checked.findings[0]).not.toHaveProperty('file');
    expect(checked.findings[0]).not.toHaveProperty('line');
    expect(checked.findings[1]).toMatchObject({ file: 'src/a.ts', line: 12 });
  });

  it.each([
    ['an empty summary', { verdict: 'approve', summary: '', findings: [] }],
    [
      'an empty file on a finding',
      {
        verdict: 'approve',
        summary: 'Clean change.',
        findings: [
          {
            severity: 'low',
            category: 'style',
            file: '',
            description: 'nit',
            recommendation: 'rename it',
          },
        ],
      },
    ],
  ])('still fails closed on %s', (_label, value) => {
    // Rejected by BOTH: the schema above stops the provider producing it, and
    // the trusted validator refuses it if one does anyway. Nothing is loosened.
    expect(checkReviewValue(value, BLOCKING).verdict).toBe('error');
  });

  /**
   * The product rule this suite exists for: critical/high/medium is a defect,
   * and a reviewer cannot buy an "approve" by classifying one down to medium.
   */
  describe('medium is blocking', () => {
    const mediums = [
      {
        severity: 'medium',
        category: 'correctness',
        file: 'src/a.ts',
        line: 4,
        description: 'The error is swallowed, so the failure surfaces as a silent no-op.',
        recommendation: 'Propagate it.',
      },
      {
        severity: 'medium',
        category: 'tests',
        file: 'src/b.ts',
        line: 9,
        description: 'The new branch has no test.',
        recommendation: 'Cover it.',
      },
    ];

    it('derives request_changes from two mediums the model itself claimed were an approve', async () => {
      const claimed = { verdict: 'approve', summary: 'Looks fine to me.', findings: mediums };
      const parsed = checkReviewValue(claimed, BLOCKING);
      expect(parsed.verdict).toBe('request_changes');
      expect(parsed.claimedVerdict).toBe('approve');
      expect(parsed.blockingSeverities).toEqual(['medium']);

      const h = reviewWith({
        status: 'completed',
        result: '',
        structuredOutput: claimed,
        memoryProposals: [],
      });
      const review = await h.run();

      expect(review.verdict).toBe('request_changes');
      // `blocking` is what the pipeline reads to send the candidate to a fixer.
      expect(review.blocking).toBe(true);
      expect(review.findings).toHaveLength(2);
      // And the correction is visible, not silent.
      const override = h.bus.list().find((event) => event.type === 'review.verdict.overridden');
      expect(override?.payload).toMatchObject({
        claimed: 'approve',
        verdict: 'request_changes',
        severities: ['medium'],
      });
      h.db.close();
    });

    it('approves a low-only review and keeps the findings as advisories', async () => {
      const h = reviewWith({
        status: 'completed',
        result: '',
        structuredOutput: {
          verdict: 'approve',
          summary: 'Clean, two nits.',
          findings: [
            {
              severity: 'low',
              category: 'style',
              description: 'Awkward name.',
              recommendation: 'Rename it.',
            },
            {
              severity: 'info',
              category: 'design',
              description: 'Worth knowing about.',
              recommendation: 'No change requested.',
            },
          ],
        },
        memoryProposals: [],
      });
      const review = await h.run();

      expect(review.verdict).toBe('approve');
      expect(review.blocking).toBe(false);
      expect(review.findings.map((finding) => finding.severity)).toEqual(['low', 'info']);
      // Nothing was corrected, so nothing claims it was.
      expect(h.bus.list().some((event) => event.type === 'review.verdict.overridden')).toBe(false);
      h.db.close();
    });

    it('honours a critical,high environment override', () => {
      const previous = process.env.JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES;
      process.env.JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES = 'critical,high';
      try {
        const overridden = loadConfig({ home: os.tmpdir(), dbPath: ':memory:' }).pipeline
          .codeReviewBlockingSeverities;
        expect(overridden).toEqual(['critical', 'high']);
        const parsed = checkReviewValue(
          { verdict: 'approve', summary: 'Two mediums.', findings: mediums },
          overridden,
        );
        expect(parsed.verdict).toBe('approve');
        expect(parsed.blockingSeverities).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES;
        else process.env.JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES = previous;
      }
    });

    it('tells the reviewer, in the prompt, that medium blocks and what medium means', async () => {
      const h = reviewWith({
        status: 'completed',
        result: FENCED_APPROVE,
        memoryProposals: [],
      });
      await h.run();
      const prompt = h.provider.lastOptions?.prompt ?? '';

      expect(prompt).toContain('critical, high, medium are BLOCKING');
      expect(prompt).toContain('low, info are advisory');
      for (const severity of ['critical:', 'high:', 'medium:', 'low:', 'info:']) {
        expect(prompt).toContain(`- ${severity}`);
      }
      expect(prompt).toContain('Do not downgrade a real finding to reach "approve"');
      h.db.close();
    });
  });

  it('refuses a claimed approve that hides a critical finding, through either channel', async () => {
    const critical = {
      verdict: 'approve',
      summary: 'claimed clean',
      findings: [
        {
          severity: 'critical',
          category: 'security',
          description: 'Authority bypass',
          recommendation: 'Authenticate it',
        },
      ],
    };
    expect(checkReviewValue(critical, BLOCKING).verdict).toBe('request_changes');
    const h = reviewWith({
      status: 'completed',
      result: '',
      structuredOutput: critical,
      memoryProposals: [],
    });
    expect((await h.run()).verdict).toBe('request_changes');
    h.db.close();
  });
});
