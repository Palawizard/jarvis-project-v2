import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type {
  AgentProvider,
  AgentEvent,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
  ProviderId,
} from '../agents/types.js';
import { loadConfig, type JarvisConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { GitWorkspace } from '../git/workspace.js';
import { JOB_BRIEF_SCHEMA_VERSION, type CompiledJobBrief } from './brief.js';
import { JobService, type Job } from './service.js';
import { ProjectService, type Project, type ProjectCommands } from '../projects/service.js';
import type { Review, ReviewFinding, ReviewOptions } from '../review/engine.js';
import { VerificationEngine, type VerificationReport } from '../verification/engine.js';
import { JobPipeline } from './pipeline.js';
import { nowIso } from '../ids.js';
import type { VisualQaShot } from '../visualqa/engine.js';
import type { InteractiveVisualQaResult, VisualQaBrief } from '../visualqa/agent.js';
import type { JobStage } from './machine.js';
import type { ExecutionRecommendation } from '../agents/policy.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeProvider implements AgentProvider {
  readonly calls: AgentStartOptions[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly handler: (
      options: AgentStartOptions,
      onEvent: (event: AgentEvent) => void,
    ) => AgentRunResult,
    private readonly available = true,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: this.available,
      authenticated: this.available,
      streaming: true,
      resumable: true,
      models: [],
      structuredOutput: true,
      ...(!this.available ? { reason: 'fixture unavailable' } : {}),
    };
  }

  async run(
    options: AgentStartOptions,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    this.calls.push(options);
    return this.handler(options, onEvent);
  }
}

const success = (result = 'done', sessionId?: string): AgentRunResult => ({
  status: 'completed',
  result,
  ...(sessionId ? { sessionId } : {}),
  memoryProposals: [],
});

const failure = (error: string): AgentRunResult => ({
  status: 'failed',
  result: '',
  error,
  memoryProposals: [],
});

const APPROVES = {
  review: (_call: number, opts: ReviewOptions) => ({
    runId: null,
    provider: 'codex',
    verdict: 'approve' as const,
    summary: 'approved',
    findings: [],
    headRef: opts.headRef,
    blocking: false,
  }),
};

const fixtureBrief = (): CompiledJobBrief => ({
  schemaVersion: JOB_BRIEF_SCHEMA_VERSION,
  title: 'Add OAuth login',
  goal: 'A user can sign in with Google.',
  requirements: ['Add a Google OAuth provider'],
  acceptanceCriteria: ['Signing in lands on the dashboard'],
  relevantProjectContext: [],
  constraints: [],
  assumptions: [],
  originalRequest: 'Add OAuth login.',
  compiledAt: nowIso(),
  provider: 'claude',
  model: null,
});

const highFinding = (): ReviewFinding => ({
  severity: 'high',
  category: 'correctness',
  file: 'change.txt',
  line: 1,
  description: 'The first implementation is intentionally incomplete.',
  recommendation: 'Repair the fixture candidate.',
});

const failedVerification = (failureKind: 'product' | 'infrastructure'): VerificationReport => ({
  passed: false,
  ran: failureKind === 'product' ? 1 : 0,
  failureSummary: `${failureKind} fixture failure`,
  failureKind,
  results: [
    {
      id: `ver-${failureKind}`,
      name: failureKind === 'product' ? 'test' : 'install',
      command: 'fixture',
      status: failureKind === 'product' ? 'failed' : 'error',
      exitCode: failureKind === 'product' ? 1 : null,
      output: `${failureKind} failure`,
      outputPath: null,
      durationMs: 1,
      cycle: 0,
      kind: failureKind === 'product' ? 'check' : 'setup',
      required: true,
      failureKind,
    },
  ],
});

const passedVerification = (): VerificationReport => ({
  passed: true,
  ran: 1,
  failureSummary: '',
  failureKind: 'none',
  results: [
    {
      id: 'ver-pass',
      name: 'test',
      command: 'fixture',
      status: 'passed',
      exitCode: 0,
      output: '',
      outputPath: null,
      durationMs: 1,
      cycle: 0,
      kind: 'check',
      required: true,
      failureKind: 'none',
    },
  ],
});

interface Harness {
  home: string;
  repo: string;
  db: Db;
  config: JarvisConfig;
  bus: EventBus;
  jobs: JobService;
  projects: ProjectService;
  project: Project;
  provider: FakeProvider;
  pipeline: JobPipeline;
  verificationCalls: number[];
  reviewHeads: string[];
  visualHeads: string[];
  visualBriefs: VisualQaBrief[];
}

async function harness(options: {
  review: (call: number, opts: ReviewOptions) => Omit<Review, 'id' | 'jobId' | 'createdAt'>;
  provider?: FakeProvider;
  providers?: FakeProvider[];
  maxReviewFixCycles?: number;
  visual?: 'repair' | 'infrastructure' | 'advisory' | 'inconclusive';
  selfDevelopment?: boolean;
  verification?: VerificationReport[];
  realVerification?: boolean;
  verificationInfraRetries?: number;
  providerAttempts?: number;
  commands?: ProjectCommands;
  packageManifestForInstall?: boolean;
  maxFixCycles?: number;
  advisor?: { advise: (input: unknown) => Promise<ExecutionRecommendation | null> };
}): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pipeline-'));
  roots.push(home);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  if (options.commands?.install && options.packageManifestForInstall !== false) {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"pipeline-fixture"}\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  }
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  const baseConfig = loadConfig({ home });
  const config = loadConfig({
    home,
    pipeline: {
      ...baseConfig.pipeline,
      maxFixCycles: options.maxFixCycles ?? baseConfig.pipeline.maxFixCycles,
      maxReviewFixCycles: options.maxReviewFixCycles ?? 2,
      maxVisualFixCycles: 2,
      providerAttempts: options.providerAttempts ?? 2,
      verificationInfraRetries:
        options.verificationInfraRetries ?? baseConfig.pipeline.verificationInfraRetries,
    },
  });
  const db = openDb(config);
  const bus = new EventBus(db);
  const jobs = new JobService(db, bus);
  const projects = new ProjectService(db);
  const project = await projects.register({
    name: 'pipeline-fixture',
    rootPath: repo,
    isSelf: options.selfDevelopment ?? false,
    commands: options.commands,
    ...(options.visual
      ? {
          config: {
            visualQa: {
              required: true,
              scenarios: [{ name: 'tools', route: '/', viewports: ['desktop'] }],
            },
          },
        }
      : {}),
  });
  const provider =
    options.provider ??
    new FakeProvider('claude', (call) => {
      if (call.role === 'implementer') {
        fs.writeFileSync(path.join(call.cwd, 'change.txt'), 'first\n');
        if (options.visual) {
          fs.mkdirSync(path.join(call.cwd, 'apps', 'web'), { recursive: true });
          fs.writeFileSync(path.join(call.cwd, 'apps', 'web', 'style.css'), '.a{color:red}\n');
        }
      }
      if (call.role === 'fixer') fs.appendFileSync(path.join(call.cwd, 'change.txt'), 'fixed\n');
      if (call.role === 'visual_fixer')
        fs.appendFileSync(path.join(call.cwd, 'change.txt'), 'visual fixed\n');
      return success(`${call.role} completed`, `session-${call.role}`);
    });
  const agents = new AgentRegistry(config, { providers: options.providers ?? [provider], db, bus });
  const verificationCalls: number[] = [];
  const realVerification = new VerificationEngine(db, config.artifactsDir, bus);
  const verification = {
    async run(input: Parameters<VerificationEngine['run']>[0]): Promise<VerificationReport> {
      verificationCalls.push(input.cycle ?? 0);
      if (options.realVerification) return realVerification.run(input);
      const call = verificationCalls.length;
      const configured = options.verification?.[call - 1];
      const report: VerificationReport = configured
        ? {
            ...configured,
            results: configured.results.map((result, index) => ({
              ...result,
              id: `${result.id}-c${call}-${index}`,
              cycle: input.cycle ?? 0,
            })),
          }
        : {
            passed: true,
            ran: 1,
            failureSummary: '',
            failureKind: 'none',
            results: [
              {
                id: `ver-${call}`,
                name: 'fixture',
                command: 'fixture',
                status: 'passed',
                exitCode: 0,
                output: '',
                outputPath: null,
                durationMs: 1,
                cycle: input.cycle ?? 0,
                kind: 'check',
                required: true,
                failureKind: 'none',
              },
            ],
          };
      // Persisted like the real engine does, so the HEAD-bound reuse path reads
      // real rows rather than a stub that always answers "passed".
      for (const result of report.results) {
        db.prepare(
          `INSERT INTO verifications
            (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,kind,required,
             failure_kind,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          result.id,
          input.jobId,
          result.cycle,
          result.name,
          result.command,
          input.cwd,
          result.exitCode,
          result.status,
          result.output,
          result.durationMs,
          result.kind,
          result.required ? 1 : 0,
          result.failureKind,
          nowIso(),
        );
      }
      return report;
    },
    latestReport(jobId: string): VerificationReport {
      return options.realVerification ? realVerification.latestReport(jobId) : passedVerification();
    },
    // Reads the rows the fake `run` above did NOT write, so the reuse path is
    // exercised against real persisted evidence rather than a stub that always
    // says "passed".
    latestRepairableReport(jobId: string): VerificationReport {
      return realVerification.latestRepairableReport(jobId);
    },
    reportForResults(jobId: string, resultIds: string[], failureSummary: string) {
      return realVerification.reportForResults(jobId, resultIds, failureSummary);
    },
  };
  const reviewHeads: string[] = [];
  let reviewCall = 0;
  const review = {
    async review(input: ReviewOptions): Promise<Review> {
      reviewCall++;
      reviewHeads.push(input.headRef);
      const value = options.review(reviewCall, input);
      const row: Review = {
        id: `review-${reviewCall}`,
        jobId: input.jobId,
        createdAt: nowIso(),
        ...value,
      };
      db.prepare(
        `INSERT INTO reviews
          (id,job_id,run_id,provider,verdict,summary,findings,head_ref,blocking,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.jobId,
        row.runId,
        row.provider,
        row.verdict,
        row.summary,
        JSON.stringify(row.findings),
        row.headRef,
        row.blocking ? 1 : 0,
        row.createdAt,
      );
      return row;
    },
    list(jobId: string): Review[] {
      return (
        db
          .prepare('SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at ASC, rowid ASC')
          .all(jobId) as Array<Record<string, unknown>>
      ).map((row) => ({
        id: row.id as string,
        jobId: row.job_id as string,
        runId: (row.run_id as string) ?? null,
        provider: row.provider as string,
        verdict: row.verdict as Review['verdict'],
        summary: row.summary as string,
        findings: JSON.parse((row.findings as string) || '[]') as ReviewFinding[],
        headRef: (row.head_ref as string) ?? '',
        blocking: Number(row.blocking) === 1,
        createdAt: row.created_at as string,
      }));
    },
  };
  const pipeline = new JobPipeline({
    db,
    bus,
    config,
    jobs,
    projects,
    sessions: { get: () => null, renderState: () => '' } as never,
    memory: {
      remember: async () => ({ status: 'stored', memory: { id: 'episode' } }),
      rememberMany: async () => [],
    } as never,
    context: {
      build: async () => ({ id: 'pack', rendered: '', selections: [], dropped: [] }),
    } as never,
    agents,
    verification: verification as never,
    review: review as never,
    ...(options.advisor ? { advisor: options.advisor as never } : {}),
  });
  const visualHeads: string[] = [];
  const visualBriefs: VisualQaBrief[] = [];
  if (options.visual) {
    let visualCall = 0;
    (
      pipeline as unknown as {
        runInteractiveVisualQa(input: {
          headRef: string;
          cwd: string;
          brief: VisualQaBrief;
          escalateModel?: boolean;
        }): Promise<InteractiveVisualQaResult>;
      }
    ).runInteractiveVisualQa = async (input) => {
      visualCall++;
      visualHeads.push(input.headRef);
      visualBriefs.push(input.brief);
      const base = {
        provider: 'codex' as const,
        model: null,
        turns: 2,
        actions: 5,
        checks: [],
        findings: [],
        evidence: [],
      };
      if (options.visual === 'infrastructure') {
        return {
          ...base,
          verdict: 'infrastructure_error',
          summary: 'Playwright launch failed',
          error: 'Playwright launch failed',
        };
      }
      if (options.visual === 'inconclusive') {
        return {
          ...base,
          verdict: 'qa_inconclusive',
          summary: 'the changed surface could not be reached within the action budget',
          checks: [
            { goal: 'reach the Tools panel', status: 'not_reached', evidenceIds: [], note: '' },
          ],
        };
      }
      const screenshotPath = path.join(home, 'screens', `visual-${visualCall}.png`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, 'fixture screenshot');
      const shot: VisualQaShot = {
        id: `shot-${visualCall}`,
        scenarioName: 'tools',
        route: '/',
        viewport: 'desktop',
        screenshotPath,
        consoleErrors: [],
        networkFailures: [],
        status: 'captured',
        error: null,
        reviewedBy: 'codex',
        reviewVerdict: 'pass',
        reviewFindings: [],
        headRef: input.headRef,
        cycle: visualCall - 1,
        createdAt: nowIso(),
      };
      const defect = options.visual === 'repair' && visualCall === 1;
      return {
        ...base,
        evidence: [shot],
        verdict: defect ? 'product_defect' : 'pass',
        summary: defect ? 'The Tools panel is clipped.' : 'The changed surface looks correct.',
        checks: [
          {
            goal: 'the Tools panel renders without clipping',
            status: defect ? 'failed' : 'passed',
            evidenceIds: [shot.id],
            note: '',
          },
        ],
        findings: defect
          ? [
              {
                severity: 'high' as const,
                category: 'layout',
                description: 'The Tools panel is clipped.',
                recommendation: 'Allow the panel to wrap.',
                evidenceIds: [shot.id],
              },
            ]
          : options.visual === 'advisory'
            ? [
                {
                  severity: 'low' as const,
                  category: 'polish',
                  description: 'Spacing is a little tight.',
                  recommendation: 'Consider more padding.',
                  evidenceIds: [shot.id],
                },
              ]
            : [],
      };
    };
  }
  return {
    home,
    repo,
    db,
    config,
    bus,
    jobs,
    projects,
    project,
    provider,
    pipeline,
    verificationCalls,
    reviewHeads,
    visualHeads,
    visualBriefs,
  };
}

async function runToRest(
  h: Harness,
  input: Parameters<JobService['create']>[0] = {
    projectId: '',
    request: '',
  },
) {
  const job = h.jobs.create({
    ...input,
    projectId: h.project.id,
    request: input.request || 'Make the deterministic fixture change.',
  });
  h.pipeline.start(job.id);
  const deadline = Date.now() + 20_000;
  while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (h.pipeline.isRunning(job.id)) throw new Error('pipeline fixture timed out');
  const finished = h.jobs.get(job.id);
  if (!finished) throw new Error('pipeline fixture job disappeared');
  return finished;
}

function createPinnedSource(h: Harness, ui = false): { base: string; source: string } {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: h.repo, encoding: 'utf8' }).trim();
  const base = git(['rev-parse', 'HEAD']);
  git(['switch', '-qc', 'source']);
  fs.writeFileSync(path.join(h.repo, 'imported.bin'), Buffer.from([0, 1, 255, 128]));
  if (ui) {
    fs.mkdirSync(path.join(h.repo, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'apps', 'web', 'imported.css'), '.b{color:blue}\n');
  }
  git(['add', '-A']);
  git(['commit', '-qm', 'pinned source']);
  const source = git(['rev-parse', 'HEAD']);
  git(['switch', '-q', 'main']);
  return { base, source };
}

async function pausedCandidate(
  h: Harness,
  resumeStage: JobStage,
  resumeSessionId?: string,
  beforeResume?: (worktreePath: string) => void,
) {
  const job = h.jobs.create({ projectId: h.project.id, request: `Resume ${resumeStage}.` });
  h.jobs.transition(job.id, 'planning');
  h.jobs.transition(job.id, 'implementing');
  const worktree = await new GitWorkspace(h.config.worktreesDir).createWorktree({
    repoRoot: h.repo,
    jobId: job.id,
  });
  fs.writeFileSync(path.join(worktree.path, 'change.txt'), 'checkpoint\n');
  // Rendered UI, so a visual_qa resume fixture is actually eligible for it.
  fs.mkdirSync(path.join(worktree.path, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(worktree.path, 'apps', 'web', 'style.css'), '.c{color:green}\n');
  const head =
    resumeStage === 'implementing'
      ? worktree.baseRef
      : ((await new GitWorkspace(h.config.worktreesDir).commitPending(
          worktree.path,
          'checkpoint',
        )) as string);
  h.jobs.patch(job.id, {
    worktreePath: worktree.path,
    branch: worktree.branch,
    baseRef: worktree.baseRef,
    headRef: head,
    lastProvider: resumeSessionId ? 'claude' : null,
    resumeSessionId: resumeSessionId ?? null,
  });
  if (resumeStage === 'verifying' || resumeStage === 'reviewing' || resumeStage === 'visual_qa') {
    h.jobs.transition(job.id, 'verifying');
  }
  if (resumeStage === 'reviewing' || resumeStage === 'visual_qa') {
    h.jobs.transition(job.id, 'reviewing');
  }
  if (resumeStage === 'visual_qa') h.jobs.transition(job.id, 'visual_qa');
  h.jobs.transition(job.id, 'paused', { resumeStage, pauseReason: 'fixture interruption' });
  beforeResume?.(worktree.path);
  h.pipeline.resume(job.id);
  const deadline = Date.now() + 20_000;
  while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (h.pipeline.isRunning(job.id)) throw new Error('resume fixture timed out');
  const finished = h.jobs.get(job.id);
  if (!finished) throw new Error('resume fixture job disappeared');
  return finished;
}

describe('job repair pipeline', () => {
  it('redacts provider text before retries, recovery state, events, or later prompts', async () => {
    const secret = 'Jarvis human pairing token: bootstrap-must-not-persist';
    let calls = 0;
    let reviewedSummary = '';
    const provider = new FakeProvider('claude', (options, onEvent) => {
      calls++;
      onEvent({ kind: 'waiting', note: secret });
      if (calls === 1) {
        return { status: 'failed', result: '', error: secret, memoryProposals: [] };
      }
      fs.writeFileSync(path.join(options.cwd, 'change.txt'), 'safe\n');
      return success(`completed ${secret}`);
    });
    const h = await harness({
      provider,
      review: (_call, opts) => {
        reviewedSummary = opts.implementerSummary;
        return {
          runId: null,
          provider: 'codex',
          verdict: 'approve',
          summary: 'approved',
          findings: [],
          headRef: opts.headRef,
          blocking: false,
        };
      },
    });

    const job = await runToRest(h);
    const persisted = JSON.stringify({
      job,
      runs: h.jobs.runs(job.id),
      events: h.bus.list({ jobId: job.id, limit: 500 }),
      reviewedSummary,
    });
    expect(job.stage).toBe('awaiting_user');
    expect(persisted).not.toContain('bootstrap-must-not-persist');
    expect(persisted).toContain('[redacted:jarvis_pairing_token]');
    h.db.close();
  });

  it('repairs a high code finding, verifies again, and obtains a fresh review', async () => {
    const h = await harness({
      selfDevelopment: true,
      review: (call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: call === 1 ? 'request_changes' : 'approve',
        summary: call === 1 ? 'repair required' : 'approved',
        findings: call === 1 ? [highFinding()] : [],
        headRef: opts.headRef,
        blocking: call === 1,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.reviewFixCycles).toBe(1);
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.reviewHeads).toHaveLength(2);
    expect(h.reviewHeads[1]).not.toBe(h.reviewHeads[0]);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(1);
    expect(h.provider.calls.find((call) => call.role === 'fixer')?.prompt).toContain(
      highFinding().description,
    );
    h.db.close();
  });

  it('puts the user request above the compiled brief in the implementer prompt', async () => {
    const h = await harness(APPROVES);
    await runToRest(h, { projectId: '', request: 'Add OAuth login.', brief: fixtureBrief() });
    const prompt = h.provider.calls.find((call) => call.role === 'implementer')?.prompt ?? '';

    // Order is the guarantee: authority first, derived context second, and the
    // brief's own contents only inside the section that says what they are.
    const request = prompt.indexOf("## Task — the user's own request (AUTHORITATIVE)");
    const briefHeading = prompt.indexOf('Compiled brief (derived context, NOT authoritative)');
    const requirement = prompt.indexOf('Add a Google OAuth provider');
    expect(request).toBeGreaterThanOrEqual(0);
    expect(briefHeading).toBeGreaterThan(request);
    expect(requirement).toBeGreaterThan(briefHeading);
    // The request itself is above the brief heading, not only its own heading.
    expect(prompt.indexOf('Add OAuth login.')).toBeLessThan(briefHeading);
    h.db.close();
  });

  it('names no brief at all in the implementer prompt when none was compiled', async () => {
    const h = await harness(APPROVES);
    await runToRest(h, { projectId: '', request: 'Add OAuth login.' });
    const prompt = h.provider.calls.find((call) => call.role === 'implementer')?.prompt ?? '';

    expect(prompt).toContain("## Task — the user's own request (AUTHORITATIVE)");
    expect(prompt).not.toContain('Compiled brief');
    h.db.close();
  });

  it('does not invoke a fixer for advisory-only findings', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'advisory only',
        findings: [
          { ...highFinding(), severity: 'medium' },
          { ...highFinding(), severity: 'low' },
          { ...highFinding(), severity: 'info' },
        ],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.reviewFixCycles).toBe(0);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(0);
    h.db.close();
  });

  it('preserves the worktree and pauses when the review repair budget is exhausted', async () => {
    const h = await harness({
      maxReviewFixCycles: 2,
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'request_changes',
        summary: 'still blocked',
        findings: [highFinding()],
        headRef: opts.headRef,
        blocking: true,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('reviewing');
    expect(job.reviewFixCycles).toBe(2);
    expect(job.pauseReason).toContain(highFinding().description);
    expect(job.worktreePath && fs.existsSync(job.worktreePath)).toBe(true);
    expect(job.headRef).toHaveLength(40);
    expect(h.reviewHeads).toHaveLength(3);

    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(h.jobs.get(job.id)?.stage).toBe('paused');
    expect(h.jobs.get(job.id)?.reviewFixCycles).toBe(2);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(2);
    h.db.close();
  });

  it('pauses without invoking an agent when every provider is unavailable', async () => {
    const unavailable = new FakeProvider('claude', () => success(), false);
    const h = await harness({
      provider: unavailable,
      review: (_call, opts) => ({
        runId: null,
        provider: 'none',
        verdict: 'error',
        summary: 'unreachable',
        findings: [],
        headRef: opts.headRef,
        blocking: true,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('implementing');
    expect(job.pauseReason).toContain('No healthy provider');
    expect(unavailable.calls).toHaveLength(0);
    h.db.close();
  });

  it('imports a pinned candidate and starts at verification without an implementer', async () => {
    const h = await harness({
      selfDevelopment: true,
      visual: 'advisory',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'import approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const { base, source } = createPinnedSource(h);
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: h.repo, encoding: 'utf8' }).trim();

    const job = await runToRest(h, {
      projectId: h.project.id,
      request: 'Validate the pinned source.',
      candidateSource: { baseSha: base, sourceSha: source },
      validationOnly: true,
    });
    expect(job.stage).toBe('awaiting_user');
    expect(job.validationOnly).toBe(true);
    expect(job.candidateSourceSha).toBe(source);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.verificationCalls).toHaveLength(1);
    expect(h.reviewHeads).toHaveLength(1);
    // The pinned source changes no rendered self UI, so no browser starts and
    // no visual model turn is spent.
    expect(h.visualHeads).toHaveLength(0);
    // The decision is recorded, so the approval gate does not inherit the self
    // project's standing required:true and block forever.
    expect(job.visualQaStatus).toBe('skipped');
    expect(
      h.bus
        .list({ jobId: job.id, limit: 200 })
        .some(
          (event) =>
            event.type === 'visual_qa.skipped' &&
            String(event.payload.reason).includes('no rendered UI file changed'),
        ),
    ).toBe(true);
    if (!job.worktreePath) throw new Error('import worktree missing');
    expect(
      execFileSync('git', ['rev-parse', `${job.headRef}^{tree}`], {
        cwd: job.worktreePath,
        encoding: 'utf8',
      }).trim(),
    ).toBe(git(['rev-parse', `${source}^{tree}`]));
    h.db.close();
  });

  it('pauses a failing validation-only candidate without invoking any source fixer', async () => {
    const h = await harness({
      verification: [failedVerification('product')],
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const { base, source } = createPinnedSource(h);
    const job = await runToRest(h, {
      projectId: h.project.id,
      request: 'Validate the failing pinned source.',
      candidateSource: { baseSha: base, sourceSha: source },
      validationOnly: true,
    });
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('verifying');
    expect(job.pauseReason).toContain('source fixers are disabled');
    expect(h.provider.calls).toHaveLength(0);
    h.db.close();
  });

  it('rejects tracked source mutation performed by a passing validation command', async () => {
    const command = `node -e "require('node:fs').writeFileSync('imported.bin','tampered')"`;
    const h = await harness({
      realVerification: true,
      commands: { test: command },
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const { base, source } = createPinnedSource(h);
    const job = await runToRest(h, {
      projectId: h.project.id,
      request: 'Validate without deriving new source.',
      candidateSource: { baseSha: base, sourceSha: source },
      validationOnly: true,
    });
    expect(job.stage).toBe('paused');
    expect(job.pauseReason).toContain('source identity changed during verification');
    expect(h.provider.calls).toHaveLength(0);
    expect(
      execFileSync('git', ['rev-parse', `${job.headRef}^{tree}`], {
        cwd: job.worktreePath as string,
        encoding: 'utf8',
      }).trim(),
    ).toBe(
      execFileSync('git', ['rev-parse', `${source}^{tree}`], {
        cwd: h.repo,
        encoding: 'utf8',
      }).trim(),
    );
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: job.worktreePath as string,
        encoding: 'utf8',
      }),
    ).toContain('imported.bin');
    h.db.close();
  });

  it('pauses blocking validation-only review findings without a review fixer', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'request_changes',
        summary: 'blocked',
        findings: [highFinding()],
        headRef: opts.headRef,
        blocking: true,
      }),
    });
    const { base, source } = createPinnedSource(h);
    const job = await runToRest(h, {
      projectId: h.project.id,
      request: 'Review the exact pinned source.',
      candidateSource: { baseSha: base, sourceSha: source },
      validationOnly: true,
    });
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('reviewing');
    expect(job.pauseReason).toContain('source fixers are disabled');
    expect(h.provider.calls).toHaveLength(0);
    h.db.close();
  });

  it('pauses blocking validation-only visual findings without a visual fixer', async () => {
    const h = await harness({
      visual: 'repair',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const { base, source } = createPinnedSource(h, true);
    const job = await runToRest(h, {
      projectId: h.project.id,
      request: 'Visually review the exact pinned source.',
      candidateSource: { baseSha: base, sourceSha: source },
      validationOnly: true,
    });
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('visual_qa');
    expect(job.pauseReason).toContain('source fixers are disabled');
    expect(h.provider.calls).toHaveLength(0);
    h.db.close();
  });

  it('reruns verification after a passing check changes and commits source', async () => {
    const command = `node -e "require('node:fs').writeFileSync('generated.txt','stable')"`;
    const h = await harness({
      realVerification: true,
      commands: { test: command },
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.reviewHeads).toEqual([job.headRef]);
    expect(
      execFileSync('git', ['show', `${job.headRef}:generated.txt`], {
        cwd: job.worktreePath as string,
        encoding: 'utf8',
      }),
    ).toBe('stable');
    h.db.close();
  });

  it('retries inconclusive visual QA exactly once, then completes with the honest status', async () => {
    const h = await harness({
      visual: 'inconclusive',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    // Inconclusive is not a product defect and not a dead end: the Job reaches
    // a reviewable state carrying a status a human can act on.
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualQaStatus).toBe('inconclusive');
    expect(job.visualHead).toBeNull();
    expect(job.visualFixCycles).toBe(0);
    // Exactly two attempts. Never a third, and never a source fixer.
    expect(h.visualHeads).toHaveLength(2);
    expect(h.visualHeads[0]).toBe(h.visualHeads[1]);
    expect(h.provider.calls.filter((call) => call.role === 'visual_fixer')).toHaveLength(0);
    // The retry is a fresh look at the same HEAD, told why the first failed.
    expect(h.visualBriefs[0]?.previousAttemptFailure).toBeUndefined();
    expect(h.visualBriefs[1]?.previousAttemptFailure).toContain('qa_inconclusive');
    expect(
      h.bus
        .list({ jobId: job.id, limit: 400 })
        .filter((event) => event.type === 'visual_qa.retried'),
    ).toHaveLength(1);
    h.db.close();
  });

  it('skips visual QA deterministically for a backend-only candidate', async () => {
    // The default implementer writes only `change.txt`. Nothing rendered
    // changed, so no browser starts and no visual model turn is spent.
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualQaStatus).toBe('skipped');
    expect(h.visualHeads).toHaveLength(0);
    expect(
      h.bus
        .list({ jobId: job.id, limit: 400 })
        .filter((event) => event.type === 'visual_qa.skipped'),
    ).toHaveLength(1);
    expect(
      h.bus.list({ jobId: job.id, limit: 400 }).some((event) => event.type === 'visual_qa.started'),
    ).toBe(false);
    h.db.close();
  });

  it('records the resolved visual QA plan on the job', async () => {
    const h = await harness({
      visual: 'advisory',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    // The persisted plan is now the evidence the agent actually captured, not a
    // predeclared screenshot list nobody was asked to produce.
    expect(job.visualQaPlan?.mode).toBe('interactive');
    expect(job.visualQaPlan?.scenarios.map((scenario) => scenario.name)).toEqual(['tools']);
    expect(job.visualQaPlan?.reasons[0]).toBe('interactive visual QA: pass');
    expect(job.visualQaStatus).toBe('passed');
    // Legacy project `visualQa.scenarios`/`routes` survive as route hints; they
    // are no longer a coverage contract the run has to satisfy.
    expect(h.visualBriefs[0]?.routeHints).toContain('/');
    expect(h.visualBriefs[0]?.surfaceHints).not.toHaveLength(0);
    h.db.close();
  });

  it('pauses as infrastructure, without a source fixer, when candidate planning fails', async () => {
    const provider = new FakeProvider('claude', (call) => {
      if (call.role === 'implementer') {
        const views = path.join(call.cwd, 'apps', 'web', 'src', 'views');
        fs.mkdirSync(views, { recursive: true });
        fs.writeFileSync(path.join(views, 'Chat.tsx'), 'export const Chat = () => null;\n');
      }
      return success(`${call.role} completed`, `session-${call.role}`);
    });
    const h = await harness({
      visual: 'advisory',
      selfDevelopment: true,
      provider,
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    // A catalog that cannot map the diff costs the agent some starting advice.
    // It no longer pauses the Job: the agent explores the app either way.
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualQaStatus).toBe('passed');
    expect(h.visualHeads).toHaveLength(1);
    expect(h.visualBriefs[0]?.surfaceHints.join(' ')).toContain('no surface hints');
    expect(
      h.bus
        .list({ jobId: job.id, limit: 400 })
        .some(
          (event) =>
            event.type === 'visual_qa.plan.resolved' && typeof event.payload.hintError === 'string',
        ),
    ).toBe(true);
    expect(h.provider.calls.filter((call) => call.role === 'visual_fixer')).toHaveLength(0);
    h.db.close();
  });

  it('repairs a blocking visual finding, then re-verifies, re-reviews, and recaptures', async () => {
    const h = await harness({
      visual: 'repair',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualQaStatus).toBe('passed');
    // Exactly ONE visual repair cycle, then a targeted recheck.
    expect(job.visualFixCycles).toBe(1);
    expect(h.provider.calls.filter((call) => call.role === 'visual_fixer')).toHaveLength(1);
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.reviewHeads).toHaveLength(2);
    expect(h.visualHeads).toHaveLength(2);
    expect(h.reviewHeads[1]).not.toBe(h.reviewHeads[0]);
    expect(h.visualHeads[1]).toBe(h.reviewHeads[1]);
    expect(job.reviewedHead).toBe(job.headRef);
    expect(job.visualHead).toBe(job.headRef);
    // The recheck verifies the failed check, not the whole app again.
    expect(h.visualBriefs[0]?.recheckGoals).toBeUndefined();
    expect(h.visualBriefs[1]?.recheckGoals).toEqual(['the Tools panel renders without clipping']);
    h.db.close();
  });

  it('does not invoke a source fixer for visual infrastructure failure', async () => {
    const h = await harness({
      visual: 'infrastructure',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualQaStatus).toBe('infrastructure_error');
    expect(job.visualHead).toBeNull();
    expect(h.visualHeads).toHaveLength(2);
    expect(h.provider.calls.filter((call) => call.role === 'visual_fixer')).toHaveLength(0);
    h.db.close();
  });

  it('lets advisory-only visual findings proceed without a fixer', async () => {
    const h = await harness({
      visual: 'advisory',
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'code approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(job.visualFixCycles).toBe(0);
    expect(h.provider.calls.filter((call) => call.role === 'visual_fixer')).toHaveLength(0);
    h.db.close();
  });

  it('retries verification infrastructure without invoking a source fixer', async () => {
    const h = await harness({
      verification: [failedVerification('infrastructure'), passedVerification()],
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(0);
    h.db.close();
  });

  it('pauses after bounded verification infrastructure retries without a fixer', async () => {
    const h = await harness({
      verification: [
        failedVerification('infrastructure'),
        failedVerification('infrastructure'),
        failedVerification('infrastructure'),
      ],
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('verifying');
    expect(job.pauseReason).toContain('infrastructure attempts exhausted');
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(0);
    h.db.close();
  });

  it('reruns a real failed install with partial residue and never calls a source fixer', async () => {
    const install =
      `node -e "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});` +
      `fs.appendFileSync('node_modules/attempts','x');process.exit(1)"`;
    const h = await harness({
      realVerification: true,
      verificationInfraRetries: 1,
      commands: { install, test: 'echo verification-ran' },
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(job.resumeStage).toBe('verifying');
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(0);
    expect(
      fs.readFileSync(path.join(job.worktreePath as string, 'node_modules', 'attempts'), 'utf8'),
    ).toBe('xx');
    expect(
      h.db.prepare("SELECT DISTINCT failure_kind FROM verifications WHERE kind='setup'").all(),
    ).toEqual([{ failure_kind: 'infrastructure' }]);
    h.db.close();
  });

  it('treats configured non-JavaScript setup failure as infrastructure without a fixer', async () => {
    const h = await harness({
      realVerification: true,
      verificationInfraRetries: 1,
      packageManifestForInstall: false,
      commands: { install: 'echo setup-failed && exit 1', test: 'echo product-looking && exit 3' },
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(h.verificationCalls).toHaveLength(2);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(0);
    expect(
      h.db.prepare('SELECT name,failure_kind FROM verifications ORDER BY cycle').all(),
    ).toEqual([
      { name: 'install', failure_kind: 'infrastructure' },
      { name: 'install', failure_kind: 'infrastructure' },
    ]);
    h.db.close();
  });

  it('allows a real product fixer only after a setup retry succeeds', async () => {
    const install =
      `node -e "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});` +
      `const p='node_modules/attempts';const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').length:0;` +
      `fs.appendFileSync(p,'x');process.exit(n===0?1:0)"`;
    const h = await harness({
      realVerification: true,
      verificationInfraRetries: 1,
      commands: { install, test: 'echo boom && exit 3' },
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(1);
    expect(h.verificationCalls).toHaveLength(3);
    const reports = h.db
      .prepare('SELECT cycle,name,status,failure_kind FROM verifications ORDER BY cycle,created_at')
      .all();
    expect(reports).toEqual([
      { cycle: 0, name: 'install', status: 'failed', failure_kind: 'infrastructure' },
      { cycle: 1, name: 'install', status: 'passed', failure_kind: 'none' },
      { cycle: 1, name: 'test', status: 'failed', failure_kind: 'product' },
      { cycle: 2, name: 'install', status: 'passed', failure_kind: 'none' },
      { cycle: 2, name: 'test', status: 'failed', failure_kind: 'product' },
    ]);
    h.db.close();
  });

  it('invokes the verification fixer for an actual product failure', async () => {
    const h = await harness({
      verification: [failedVerification('product'), passedVerification()],
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(1);
    h.db.close();
  });

  it.each([
    ['verification', 'fixer', 'persisted verification failure', undefined],
    ['code_review', 'fixer', highFinding().description, undefined],
    ['visual', 'visual_fixer', 'persisted visual issue', 'advisory'],
  ] as const)(
    'resumes the exact interrupted %s repair checkpoint',
    async (kind, expectedRole, evidence, visual) => {
      const h = await harness({
        ...(visual ? { visual } : {}),
        review: (_call, opts) => ({
          runId: null,
          provider: 'codex',
          verdict: 'approve',
          summary: 'approved',
          findings: [],
          headRef: opts.headRef,
          blocking: false,
        }),
      });
      const job = h.jobs.create({ projectId: h.project.id, request: `Resume ${kind} repair.` });
      h.jobs.transition(job.id, 'planning');
      h.jobs.transition(job.id, 'implementing');
      const worktree = await new GitWorkspace(h.config.worktreesDir).createWorktree({
        repoRoot: h.repo,
        jobId: job.id,
      });
      fs.writeFileSync(path.join(worktree.path, 'change.txt'), 'checkpoint\n');
      const head = (await new GitWorkspace(h.config.worktreesDir).commitPending(
        worktree.path,
        'repair checkpoint',
      )) as string;
      h.jobs.patch(job.id, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        baseRef: worktree.baseRef,
        headRef: head,
      });
      h.jobs.transition(job.id, 'verifying');
      h.db
        .prepare(
          `INSERT INTO verifications
            (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,kind,required,
             failure_kind,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'ver-checkpoint',
          job.id,
          0,
          'test',
          'test',
          worktree.path,
          kind === 'verification' ? 1 : 0,
          kind === 'verification' ? 'failed' : 'passed',
          evidence,
          1,
          'check',
          1,
          kind === 'verification' ? 'product' : 'none',
          nowIso(),
        );
      if (kind === 'code_review') {
        h.db
          .prepare(
            `INSERT INTO verifications
              (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,kind,required,
               failure_kind,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            'ver-newer-unrelated',
            job.id,
            1,
            'newer-unrelated-check',
            'test',
            worktree.path,
            0,
            'passed',
            '',
            1,
            'check',
            1,
            'none',
            nowIso(),
          );
      }
      const screenshotPath = path.join(h.home, 'persisted-visual.png');
      if (kind === 'visual') {
        fs.writeFileSync(screenshotPath, 'visual evidence');
        h.db
          .prepare(
            `INSERT INTO visual_qa
            (id,job_id,project_id,scenario_name,route,viewport,screenshot_path,console_errors,
             network_failures,status,head_ref,cycle,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            'shot-checkpoint',
            job.id,
            h.project.id,
            'tools',
            '/',
            'desktop',
            screenshotPath,
            '[]',
            '[]',
            'captured',
            head,
            0,
            nowIso(),
          );
      }
      h.jobs.transition(job.id, 'fixing', {
        repairKind: kind,
        repairCheckpoint:
          kind === 'verification'
            ? {
                kind,
                verification: {
                  resultIds: ['ver-checkpoint'],
                  cycle: 0,
                  failureSummary: 'persisted verification failure',
                },
              }
            : kind === 'code_review'
              ? {
                  kind,
                  verification: { resultIds: ['ver-checkpoint'], cycle: 0, failureSummary: '' },
                  review: { id: 'review-checkpoint', findings: [highFinding()] },
                }
              : {
                  kind,
                  visual: {
                    shotIds: ['shot-checkpoint'],
                    cycle: 0,
                    findings: [
                      {
                        severity: 'high',
                        scenarioName: 'tools',
                        route: '/',
                        viewport: 'desktop',
                        category: 'layout',
                        description: 'persisted visual issue',
                        recommendation: 'fix the persisted visual issue',
                      },
                    ],
                  },
                },
      });
      expect(h.jobs.recoverInterrupted().jobs).toBe(1);
      expect(h.jobs.get(job.id)?.restartReason).toBe('orchestrator_restart');
      h.pipeline.resume(job.id);
      const deadline = Date.now() + 20_000;
      while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(h.jobs.get(job.id)?.stage).toBe('awaiting_user');
      const resumed = h.provider.calls.find((call) => call.role === expectedRole);
      expect(resumed?.prompt).toContain(evidence);
      if (kind === 'code_review') expect(resumed?.prompt).not.toContain('newer-unrelated-check');
      if (kind === 'visual') expect(resumed?.imagePaths).toEqual([screenshotPath]);
      h.db.close();
    },
  );

  // A repair rewrites the same source the implementer wrote. If it routes on
  // repair counters alone, a candidate that touched auth, permissions, the
  // sandbox or a migration gets a weaker model for the harder, riskier half of
  // the job — so both repair entry points read the candidate's own paths.
  const SENSITIVE = path.join('packages', 'core', 'src', 'auth', 'control.ts');

  const writeSensitive = (cwd: string): void => {
    fs.mkdirSync(path.join(cwd, path.dirname(SENSITIVE)), { recursive: true });
    fs.writeFileSync(path.join(cwd, SENSITIVE), 'export const control = 1;\n');
  };

  it('routes a verification fixer for a sensitive candidate at the strong/high floor', async () => {
    const provider = new FakeProvider('claude', (call) => {
      if (call.role === 'implementer') writeSensitive(call.cwd);
      return success();
    });
    const h = await harness({
      provider,
      verification: [failedVerification('product'), passedVerification()],
      review: APPROVES.review,
    });
    await runToRest(h);
    const fixer = provider.calls.find((call) => call.role === 'fixer');
    expect(fixer).toBeDefined();
    expect(fixer?.model).toBe('opus');
    expect(fixer?.effort).toBe('high');
    h.db.close();
  });

  it('routes a resumed repair of a sensitive candidate at the strong/high floor', async () => {
    const provider = new FakeProvider('claude', () => success());
    const h = await harness({ provider, review: APPROVES.review });
    const job = h.jobs.create({ projectId: h.project.id, request: 'Resume a sensitive repair.' });
    h.jobs.transition(job.id, 'planning');
    h.jobs.transition(job.id, 'implementing');
    const workspace = new GitWorkspace(h.config.worktreesDir);
    const worktree = await workspace.createWorktree({ repoRoot: h.repo, jobId: job.id });
    writeSensitive(worktree.path);
    const head = (await workspace.commitPending(worktree.path, 'sensitive checkpoint')) as string;
    h.jobs.patch(job.id, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      headRef: head,
    });
    h.jobs.transition(job.id, 'verifying');
    h.db
      .prepare(
        `INSERT INTO verifications
          (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,kind,required,
           failure_kind,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'ver-sensitive',
        job.id,
        0,
        'test',
        'test',
        worktree.path,
        1,
        'failed',
        'persisted sensitive failure',
        1,
        'check',
        1,
        'product',
        nowIso(),
      );
    h.jobs.transition(job.id, 'fixing', {
      repairKind: 'verification',
      repairCheckpoint: {
        kind: 'verification',
        verification: {
          resultIds: ['ver-sensitive'],
          cycle: 0,
          failureSummary: 'persisted sensitive failure',
        },
      },
    });
    expect(h.jobs.recoverInterrupted().jobs).toBe(1);
    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const resumed = provider.calls.find((call) => call.role === 'fixer');
    expect(resumed).toBeDefined();
    expect(resumed?.model).toBe('opus');
    expect(resumed?.effort).toBe('high');
    h.db.close();
  });

  it.each([
    ['verifying', undefined],
    ['reviewing', undefined],
    ['visual_qa', 'advisory'],
  ] as const)('resumes a checkpointed %s stage in the same job', async (stage, visual) => {
    const h = await harness({
      ...(visual ? { visual } : {}),
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'fresh review after resume',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await pausedCandidate(h, stage);
    expect(job.stage).toBe('awaiting_user');
    expect(job.id).toBe(h.jobs.list({ projectId: h.project.id })[0]?.id);
    expect(h.verificationCalls).toHaveLength(1);
    expect(h.reviewHeads).toHaveLength(1);
    if (stage === 'visual_qa') expect(h.visualHeads).toHaveLength(1);
    h.db.close();
  });

  it('reuses a resumable implementation session when recovering the same worktree', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await pausedCandidate(h, 'implementing', 'external-session-123');
    expect(job.stage).toBe('awaiting_user');
    const resumed = h.provider.calls.find((call) => call.role === 'implementer');
    expect(resumed?.resumeSessionId).toBe('external-session-123');
    expect(job.worktreePath).toBeTruthy();
    h.db.close();
  });

  it('refuses resume when a verification checkpoint worktree became dirty', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'unused',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = await pausedCandidate(h, 'verifying', undefined, (worktreePath) => {
      fs.appendFileSync(path.join(worktreePath, 'change.txt'), 'unexpected mutation\n');
    });
    expect(job.stage).toBe('paused');
    expect(job.pauseReason).toContain('Resume refused');
    expect(job.pauseReason).toContain('uncommitted changes Jarvis did not make');
    expect(h.verificationCalls).toHaveLength(0);
    expect(h.reviewHeads).toHaveLength(0);
    h.db.close();
  });

  it('resumes an interrupted planning stage without creating a recovery job', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve',
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
    });
    const job = h.jobs.create({ projectId: h.project.id, request: 'Resume planning.' });
    h.jobs.transition(job.id, 'planning');
    h.jobs.transition(job.id, 'paused', {
      resumeStage: 'planning',
      pauseReason: 'orchestrator_restart',
    });

    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(h.jobs.get(job.id)?.stage).toBe('awaiting_user');
    expect(h.jobs.list({ projectId: h.project.id })).toHaveLength(1);
    h.db.close();
  });
});

describe('provider-scoped session recovery', () => {
  const review = (_call: number, opts: ReviewOptions) => ({
    runId: null,
    provider: 'codex' as const,
    verdict: 'approve' as const,
    summary: 'approved',
    findings: [],
    headRef: opts.headRef,
    blocking: false,
  });
  async function runStage(
    h: Harness,
    provider: ProviderId,
    resumeSessionId: string,
    owner?: ProviderId,
  ) {
    const created = h.jobs.create({ projectId: h.project.id, request: 'resume provider session' });
    // A persisted resume id always has a recorded owner; the pair is what the
    // stage reads.
    h.jobs.patch(created.id, { lastProvider: owner ?? provider, resumeSessionId });
    const pipeline = h.pipeline as unknown as {
      runAgentStage(opts: {
        jobId: string;
        role: 'implementer';
        cwd: string;
        prompt: string;
        contextPackId: string;
        signal: AbortSignal;
        preferredProvider: ProviderId;
        resumeSessionId: string;
      }): Promise<{ status: string; provider?: ProviderId }>;
    };
    const result = await pipeline.runAgentStage({
      jobId: created.id,
      role: 'implementer',
      cwd: h.repo,
      prompt: 'continue the same work',
      contextPackId: 'pack',
      signal: new AbortController().signal,
      preferredProvider: provider,
      resumeSessionId,
    });
    return { created, result };
  }

  it('retires a broken Codex resume and retries exactly once with fresh Codex context', async () => {
    const codex = new FakeProvider('codex', (options) =>
      options.resumeSessionId
        ? failure('Codex exited without a terminal structured event')
        : success('fresh context completed', 'codex-fresh'),
    );
    const h = await harness({ review, providers: [codex] });
    const { created, result } = await runStage(h, 'codex', 'codex-broken');

    expect(result.status).toBe('completed');
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual(['codex-broken', undefined]);
    expect(codex.calls.every((call) => call.prompt === 'continue the same work')).toBe(true);
    expect(codex.calls.every((call) => call.cwd === h.repo && call.role === 'implementer')).toBe(
      true,
    );
    expect(h.jobs.get(created.id)?.resumeSessionId).toBe('codex-fresh');
    expect(
      h.bus
        .list({ jobId: created.id, limit: 100 })
        .filter(
          (event) =>
            event.type === 'agent.stage.retry' && event.payload.recovery === 'fresh_context',
        ),
    ).toHaveLength(1);
    h.db.close();
  });

  it.each([
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const)('never sends a %s session id to fallback %s', async (preferredId, fallbackId) => {
    const preferred = new FakeProvider(preferredId, () =>
      failure(`${preferredId} exited without a terminal structured event`),
    );
    const fallback = new FakeProvider(fallbackId, () => success('fallback completed'));
    const h = await harness({ review, providers: [preferred, fallback], providerAttempts: 3 });
    const { result } = await runStage(h, preferredId, `${preferredId}-session`);
    const preferredResumeIds = preferred.calls.map((call) => call.resumeSessionId);
    const fallbackResumeId = fallback.calls[0]?.resumeSessionId;
    const fallbackCalls = fallback.calls.length;
    const preferredCalls = preferred.calls.length;
    h.db.close();

    expect(result.status).toBe('completed');
    expect(preferredResumeIds).toEqual([`${preferredId}-session`, undefined]);
    expect(fallbackCalls).toBe(1);
    expect(fallbackResumeId).toBeUndefined();
    expect(preferredCalls).toBe(2);
  });

  it('never resumes a session recorded against a different provider', async () => {
    // The Job carries a Claude thread, but this stage prefers Codex. Handing it
    // over would put a Claude id behind `codex resume` -- the exact shape that
    // produced "Codex exited without a terminal structured event" against a
    // worktree where direct Codex execution worked.
    const codex = new FakeProvider('codex', (options) =>
      options.resumeSessionId ? failure('wrong provider session') : success('fresh codex'),
    );
    const h = await harness({ review, providers: [codex] });
    const { result } = await runStage(h, 'codex', 'claude-session', 'claude');

    expect(result.status).toBe('completed');
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual([undefined]);
    h.db.close();
  });

  it('never sends a session id to a provider chosen on the first attempt', async () => {
    // The preferred provider is unavailable, so routing falls back immediately
    // and the session id is still live. Only the (provider === preferred) pairing
    // guard suppresses it here: the later reset has not run yet.
    const preferred = new FakeProvider('claude', () => success('unused'), false);
    const fallback = new FakeProvider('codex', () => success('fallback completed'));
    const h = await harness({ review, providers: [preferred, fallback] });
    const { result } = await runStage(h, 'claude', 'claude-session');
    const fallbackResumeIds = fallback.calls.map((call) => call.resumeSessionId);
    const preferredCalls = preferred.calls.length;
    h.db.close();

    expect(result.status).toBe('completed');
    expect(preferredCalls).toBe(0);
    expect(fallbackResumeIds).toEqual([undefined]);
  });

  it('counts a failed fresh-context recovery inside the configured attempt budget', async () => {
    const codex = new FakeProvider('codex', () =>
      failure('Codex exited without a terminal structured event'),
    );
    const claude = new FakeProvider('claude', () => failure('Claude protocol failure'));
    const h = await harness({
      review,
      providers: [codex, claude],
      providerAttempts: 3,
    });
    const { result } = await runStage(h, 'codex', 'codex-broken');

    expect(result.status).toBe('failed');
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual(['codex-broken', undefined]);
    expect(claude.calls.map((call) => call.resumeSessionId)).toEqual([undefined]);
    expect(codex.calls.length + claude.calls.length).toBe(3);
    h.db.close();
  });

  it('does not exceed a single-attempt budget for a broken resumed session', async () => {
    const codex = new FakeProvider('codex', () =>
      failure('Codex exited without a terminal structured event'),
    );
    const h = await harness({ review, providers: [codex], providerAttempts: 1 });
    const { result } = await runStage(h, 'codex', 'codex-broken');

    expect(result.status).toBe('failed');
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual(['codex-broken']);
    h.db.close();
  });
});

// ===========================================================================
// JOB PIPELINE v2 — the production failures this redesign exists to remove.
//
// Every case below is something that really happened and really cost quota:
// a Resume that re-ran a whole verification suite on a commit it had already
// verified, a second reviewer sent at an unchanged candidate, a provider outage
// that consumed a product repair budget, a paused Job that could not be
// recovered because an authorised agent had committed.
// ===========================================================================

describe('HEAD-bound evidence', () => {
  /**
   * Drive a Job to `awaiting_user`, then push it back to `paused` at a chosen
   * stage WITHOUT touching the worktree. That is the shape of every real
   * "paused after the expensive work was already done" case: the commit is
   * unchanged, so every recorded piece of evidence still describes it.
   */
  async function pausedOnVerifiedCandidate(
    h: Harness,
    resumeStage: JobStage,
    patch: Partial<Job> = {},
  ) {
    const finished = await runToRest(h);
    expect(finished.stage).toBe('awaiting_user');
    h.jobs.transition(finished.id, 'fixing');
    h.jobs.transition(finished.id, 'paused', {
      resumeStage,
      pauseReason: 'fixture: provider unavailable',
      ...patch,
    });
    return h.jobs.get(finished.id) as Job;
  }

  async function resumeToRest(h: Harness, jobId: string) {
    h.pipeline.resume(jobId);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(jobId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (h.pipeline.isRunning(jobId)) throw new Error('resume fixture timed out');
    return h.jobs.get(jobId) as Job;
  }

  // A. Verification passed on X. The Job later paused during review. Resuming
  // used to re-run the entire deterministic suite on X before it was allowed to
  // try the reviewer again — minutes of CI to re-derive an answer on disk.
  it('reuses verification evidence for an unchanged candidate instead of re-running it', async () => {
    const h = await harness({ review: APPROVES.review });
    const job = await pausedOnVerifiedCandidate(h, 'reviewing', { reviewedHead: null });
    expect(job.verifiedHead).toBe(job.headRef);
    const verificationsBefore = h.verificationCalls.length;
    const reviewsBefore = h.reviewHeads.length;

    const resumed = await resumeToRest(h, job.id);

    expect(resumed.stage).toBe('awaiting_user');
    expect(h.verificationCalls).toHaveLength(verificationsBefore);
    expect(h.reviewHeads).toHaveLength(reviewsBefore + 1);
    expect(h.reviewHeads.at(-1)).toBe(job.headRef);
    expect(
      h.bus
        .list({ jobId: job.id, limit: 200 })
        .some(
          (event) => event.type === 'job.evidence.reused' && event.payload.stage === 'verification',
        ),
    ).toBe(true);
    h.db.close();
  });

  // C. A successful review already exists for X. Nothing changed. A second
  // equivalent reviewer can only re-derive the same verdict, at full cost.
  it('never launches a second automatic review for an unchanged reviewed candidate', async () => {
    const h = await harness({ review: APPROVES.review });
    const job = await pausedOnVerifiedCandidate(h, 'reviewing');
    expect(job.reviewedHead).toBe(job.headRef);
    const reviewsBefore = h.reviewHeads.length;

    const resumed = await resumeToRest(h, job.id);

    expect(resumed.stage).toBe('awaiting_user');
    expect(h.reviewHeads).toHaveLength(reviewsBefore);
    expect(h.verificationCalls).toHaveLength(1);
    h.db.close();
  });

  // B. The reviewer asked for changes, the batch fixer already ran, and nothing
  // about the candidate has changed since. Verifying it again and reviewing it
  // again both cost real quota to arrive back at exactly this state.
  it('pauses with actionable state when the review repair budget is spent on an unchanged candidate', async () => {
    const h = await harness({
      maxReviewFixCycles: 1,
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'request_changes' as const,
        summary: 'blocking',
        findings: [highFinding()],
        headRef: opts.headRef,
        blocking: true,
      }),
    });
    const job = await runToRest(h);
    expect(job.stage).toBe('paused');
    expect(job.reviewFixCycles).toBe(1);
    expect(job.reviewBlockedHead).toBe(job.headRef);
    const verificationsBefore = h.verificationCalls.length;
    const reviewsBefore = h.reviewHeads.length;

    const resumed = await resumeToRest(h, job.id);

    expect(resumed.stage).toBe('paused');
    expect(h.verificationCalls).toHaveLength(verificationsBefore);
    expect(h.reviewHeads).toHaveLength(reviewsBefore);
    expect(resumed.pauseReason).toContain('review repair budget');
    expect(resumed.pauseReason).toContain('continuation');

    const plan = await h.pipeline.resumePlan(job.id);
    expect(plan?.plan.kind).toBe('none');
    expect(plan?.plan.reusing.join(' ')).toContain('verification');
    h.db.close();
  });

  // The final gate is expensive by construction — it is the self-upgrade gate.
  it('does not re-run a final gate that already passed on the same candidate', async () => {
    const h = await harness({
      realVerification: true,
      commands: { test: 'node -e "process.exit(0)"' },
      review: APPROVES.review,
    });
    h.projects.update(h.project.id, {
      config: {
        verification: {
          steps: [
            { name: 'test', command: 'node -e "process.exit(0)"', kind: 'check', required: true },
            {
              name: 'catalog',
              command: 'node -e "process.exit(0)"',
              kind: 'final',
              required: true,
            },
          ],
        },
      },
    });
    const job = await pausedOnVerifiedCandidate(h, 'verifying');
    expect(job.finalGateHead).toBe(job.headRef);
    const before = h.verificationCalls.length;

    const resumed = await resumeToRest(h, job.id);

    expect(resumed.stage).toBe('awaiting_user');
    expect(h.verificationCalls).toHaveLength(before);
    h.db.close();
  });
});

// A fixer is allowed to conclude that nothing should change — the visual
// fixer prompt says so in as many words. When it did, `commitPending` was a
// no-op on the clean tree, the candidate was still the verified commit, and
// the verification-evidence reuse branch broke out of the loop with the Job
// still in `fixing`. `fixing -> reviewing` is not a legal transition, so the
// pipeline threw and the Job paused showing an internal error as its state,
// with a repair cycle already charged.
it('survives a review fixer that completes without changing anything', async () => {
  const provider = new FakeProvider('claude', (call) => {
    if (call.role === 'implementer') {
      fs.writeFileSync(path.join(call.cwd, 'change.txt'), 'first\n');
    }
    // A fixer that deliberately writes nothing.
    return success(`${call.role} completed`);
  });
  const h = await harness({
    provider,
    maxReviewFixCycles: 1,
    review: (_call, opts) => ({
      runId: null,
      provider: 'codex',
      verdict: 'request_changes' as const,
      summary: 'blocking',
      findings: [highFinding()],
      headRef: opts.headRef,
      blocking: true,
    }),
  });
  const job = await runToRest(h);

  expect(job.stage).toBe('paused');
  expect(job.pauseReason).not.toContain('illegal job transition');
  expect(job.pauseReason).toContain('Code review repair budget exhausted');
  // The candidate never moved, so the verification evidence is still valid
  // and was reused rather than re-derived.
  expect(job.verifiedHead).toBe(job.headRef);
  expect(h.verificationCalls).toHaveLength(1);
  // The reviewer is not asked again about a candidate it already judged.
  expect(h.reviewHeads).toHaveLength(1);
  h.db.close();
});

describe('product budgets versus provider attempts', () => {
  // D. Quota is not a code problem. Charging a repair budget for it means a
  // provider outage silently eats the fixer a real failure would have needed.
  it('does not consume a review repair cycle when every reviewer provider fails', async () => {
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'none',
        verdict: 'error' as const,
        summary: 'No reviewer available: claude: usage limit reached',
        findings: [],
        headRef: opts.headRef,
        blocking: true,
      }),
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('paused');
    expect(job.reviewFixCycles).toBe(0);
    expect(job.reviewedHead).toBeNull();
    expect(job.reviewBlockedHead).toBeNull();
    // Verification evidence survives: a reviewer that could not run says
    // nothing about whether the checks passed.
    expect(job.verifiedHead).toBe(job.headRef);
    expect(job.pauseFailureKind).toBe('quota');
    h.db.close();
  });

  it('does not consume a verification repair cycle when the fixer provider is unavailable', async () => {
    const provider = new FakeProvider('claude', (call) => {
      if (call.role === 'implementer') {
        fs.writeFileSync(path.join(call.cwd, 'change.txt'), 'first\n');
        return success('implemented');
      }
      return failure("You've hit your usage limit for this session");
    });
    const h = await harness({
      provider,
      verification: [failedVerification('product'), passedVerification()],
      review: APPROVES.review,
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('paused');
    expect(job.fixCycles).toBe(0);
    expect(job.pauseFailureKind).toBe('quota');
    expect(job.pauseReason).toContain('usage limit');
    h.db.close();
  });

  // E. Two attempts, then stop. Never a chain that walks back and forth.
  it('stops after two provider attempts for one logical action', async () => {
    const claude = new FakeProvider('claude', () => failure('Claude usage limit reached'));
    const codex = new FakeProvider('codex', () => failure('Codex capacity unavailable'));
    const h = await harness({ providers: [claude, codex], review: APPROVES.review });
    const job = await runToRest(h);

    expect(job.stage).toBe('paused');
    expect(claude.calls.length + codex.calls.length).toBe(2);
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    h.db.close();
  });
});

describe('progress-aware verification repair', () => {
  const failing = (
    id: string,
    steps: Array<[string, 'passed' | 'failed']>,
  ): VerificationReport => ({
    passed: steps.every(([, status]) => status === 'passed'),
    ran: steps.length,
    failureSummary: steps
      .filter(([, status]) => status === 'failed')
      .map(([name]) => `${name} failed`)
      .join('\n'),
    failureKind: steps.every(([, status]) => status === 'passed') ? 'none' : 'product',
    results: steps.map(([name, status], index) => ({
      id: `${id}-${index}`,
      name,
      command: name,
      status,
      exitCode: status === 'passed' ? 0 : 1,
      output: `${name}: ${status}`,
      outputPath: null,
      durationMs: 1,
      cycle: 0,
      kind: 'check' as const,
      required: true,
      failureKind: status === 'passed' ? ('none' as const) : ('product' as const),
    })),
  });

  // G. unit+integration failing -> integration green, unit down to a residual.
  // That is real progress and the second fixer finishes the job. A bare counter
  // paused here and handed a nearly-finished candidate back to the human.
  it('allows a second fixer when the failure signature actually moved', async () => {
    const h = await harness({
      maxFixCycles: 2,
      verification: [
        failing('c0', [
          ['unit', 'failed'],
          ['integration', 'failed'],
        ]),
        failing('c1', [
          ['unit', 'failed'],
          ['integration', 'passed'],
        ]),
        failing('c2', [
          ['unit', 'passed'],
          ['integration', 'passed'],
        ]),
      ],
      review: APPROVES.review,
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('awaiting_user');
    expect(job.fixCycles).toBe(2);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(2);
    h.db.close();
  });

  // H. The identical failure, twice. A third look cannot help and the budget
  // says nothing useful — the signature does.
  it('stops after one fixer when the failure signature did not move', async () => {
    const identical = () => failing('same', [['unit', 'failed']]);
    const h = await harness({
      maxFixCycles: 2,
      verification: [identical(), identical(), identical()],
      review: APPROVES.review,
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('paused');
    expect(job.fixCycles).toBe(1);
    expect(h.provider.calls.filter((call) => call.role === 'fixer')).toHaveLength(1);
    expect(job.pauseReason).toContain('identical failure signature');
    h.db.close();
  });
});

describe('candidate HEAD recovery', () => {
  // I. The agent committed and THEN the run failed on quota. `headRef` used to
  // still name the commit from before the run, so the recovery check refused
  // the mismatch forever and thirty minutes of committed work was unreachable.
  it('records a commit an authorised agent produced even when its run then failed', async () => {
    const provider = new FakeProvider('claude', (call) => {
      if (call.role !== 'implementer') return failure('quota');
      fs.writeFileSync(path.join(call.cwd, 'change.txt'), 'agent work\n');
      execFileSync('git', ['add', '-A'], { cwd: call.cwd });
      execFileSync(
        'git',
        ['-c', 'user.name=A', '-c', 'user.email=a@b', 'commit', '-qm', 'agent commit'],
        { cwd: call.cwd },
      );
      return failure("You've hit your usage limit");
    });
    const h = await harness({ provider, review: APPROVES.review });
    const job = await runToRest(h);

    expect(job.stage).toBe('paused');
    expect(job.headRef).not.toBe(job.baseRef);
    const worktreeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: job.worktreePath as string,
      encoding: 'utf8',
    }).trim();
    expect(job.headRef).toBe(worktreeHead);

    // And the Job is recoverable rather than stranded.
    const plan = await h.pipeline.resumePlan(job.id);
    expect(plan?.recovery).toBeNull();
    expect(plan?.plan.kind).toBe('verify');
    h.db.close();
  });

  // B. An orchestrator restart gets no chance to record the commit an
  // authorised run had already made. Refusing that mismatch is what used to
  // discard half an hour of committed agent work behind "recovery HEAD
  // changed" — with no way back short of editing the database.
  it('recovers a commit an interrupted authorised run had already made', async () => {
    const h = await harness({ review: APPROVES.review });
    const job = h.jobs.create({ projectId: h.project.id, request: 'Interrupted implementation.' });
    h.jobs.transition(job.id, 'planning');
    h.jobs.transition(job.id, 'implementing');
    const workspace = new GitWorkspace(h.config.worktreesDir);
    const worktree = await workspace.createWorktree({ repoRoot: h.repo, jobId: job.id });
    h.jobs.patch(job.id, {
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseRef: worktree.baseRef,
      // Still the base: the run was killed before anything recorded its commit.
      headRef: worktree.baseRef,
    });
    fs.writeFileSync(path.join(worktree.path, 'change.txt'), 'thirty minutes of work\n');
    const committed = (await workspace.commitPending(worktree.path, 'agent commit')) as string;
    expect(h.jobs.recoverInterrupted().jobs).toBe(1);

    const plan = await h.pipeline.resumePlan(job.id);
    expect(plan?.recovery).toBeNull();
    expect(plan?.candidateHead).toBe(committed);

    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const resumed = h.jobs.get(job.id) as Job;
    expect(resumed.headRef).toBe(committed);
    expect(resumed.stage).toBe('awaiting_user');
    expect(
      h.bus
        .list({ jobId: job.id, limit: 200 })
        .some((event) => event.payload?.reason === 'interrupted_agent_commit'),
    ).toBe(true);
    h.db.close();
  });

  // J. A commit Jarvis did not create. Never adopted silently; adopting is an
  // explicit human operation, and it invalidates the old evidence.
  it('refuses an external HEAD change, then adopts it on an explicit request', async () => {
    const h = await harness({ review: APPROVES.review });
    const job = await runToRest(h);
    expect(job.stage).toBe('awaiting_user');
    const recorded = job.headRef as string;

    h.jobs.transition(job.id, 'fixing');
    h.jobs.transition(job.id, 'paused', { resumeStage: 'reviewing' });
    const cwd = job.worktreePath as string;
    fs.appendFileSync(path.join(cwd, 'change.txt'), 'human edit\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync(
      'git',
      ['-c', 'user.name=H', '-c', 'user.email=h@b', 'commit', '-qm', 'human commit'],
      { cwd },
    );
    const external = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

    const before = await h.pipeline.resumePlan(job.id);
    expect(before?.recovery?.kind).toBe('external_head_change');
    expect(
      before?.recovery?.options.some((option) => option.startsWith('Adopt current HEAD')),
    ).toBe(true);

    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const refused = h.jobs.get(job.id) as Job;
    expect(refused.stage).toBe('paused');
    expect(refused.headRef).toBe(recorded);
    expect(refused.pauseReason).toContain('Jarvis did not create');
    expect(h.verificationCalls).toHaveLength(1);

    await h.pipeline.adoptCandidateHead(job.id);
    const adopted = h.jobs.get(job.id) as Job;
    expect(adopted.headRef).toBe(external);
    expect(adopted.verifiedHead).toBeNull();
    expect(adopted.reviewedHead).toBeNull();
    expect(
      h.bus.list({ jobId: job.id, limit: 200 }).some((event) => event.type === 'job.head.adopted'),
    ).toBe(true);

    const after = await h.pipeline.resumePlan(job.id);
    expect(after?.recovery).toBeNull();
    expect(after?.plan.kind).toBe('verify');
    h.db.close();
  });
});

describe('semantic execution advice', () => {
  const advice: ExecutionRecommendation = {
    capabilityTier: 'strong',
    effort: 'high',
    reasons: ['self-development touching the permission boundary'],
  };

  // K. A Job created directly has no brief and must not compile one just to
  // choose a model. It used to fall through to "long request" / "very long
  // request", which is a proxy for typing rather than for difficulty.
  it('asks the Execution Advisor once for a direct Job and maps the answer to an exact model', async () => {
    const calls: unknown[] = [];
    const h = await harness({
      review: APPROVES.review,
      advisor: {
        advise: async (input) => {
          calls.push(input);
          return advice;
        },
      },
    });
    const job = await runToRest(h);

    expect(calls).toHaveLength(1);
    expect(job.executionRecommendation).toEqual(advice);
    const implementer = h.provider.calls.find((call) => call.role === 'implementer');
    expect(implementer?.model).toBe('opus');
    expect(implementer?.effort).toBe('high');
    h.db.close();
  });

  // L. The chat path already answers this question inside a call it was making
  // anyway. Adding a second one there would be pure waste.
  it('does not invoke the Execution Advisor when a compiled brief carries the recommendation', async () => {
    const calls: unknown[] = [];
    const h = await harness({
      review: APPROVES.review,
      advisor: {
        advise: async (input) => {
          calls.push(input);
          return advice;
        },
      },
    });
    const job = await runToRest(h, {
      projectId: '',
      request: 'Add OAuth login.',
      brief: { ...fixtureBrief(), executionRecommendation: advice },
    });

    expect(calls).toHaveLength(0);
    expect(job.executionRecommendation).toBeNull();
    const implementer = h.provider.calls.find((call) => call.role === 'implementer');
    expect(implementer?.model).toBe('opus');
    h.db.close();
  });

  it('reuses a persisted recommendation instead of asking again on Resume', async () => {
    let calls = 0;
    const h = await harness({
      review: APPROVES.review,
      advisor: {
        advise: async () => {
          calls++;
          return advice;
        },
      },
    });
    const job = await runToRest(h);
    expect(calls).toBe(1);

    h.jobs.transition(job.id, 'fixing');
    h.jobs.transition(job.id, 'paused', { resumeStage: 'reviewing', reviewedHead: null });
    h.pipeline.resume(job.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(job.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(calls).toBe(1);
    h.db.close();
  });

  // M. A short continuation command in front of a large, risky diff.
  it('sends trusted continuation facts, not the length of the sentence', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const h = await harness({
      review: (_call, opts) => ({
        runId: null,
        provider: 'codex',
        verdict: 'approve' as const,
        summary: 'approved',
        findings: [],
        headRef: opts.headRef,
        blocking: false,
      }),
      advisor: {
        advise: async (input) => {
          seen.push(input as Record<string, unknown>);
          return advice;
        },
      },
    });
    const first = await runToRest(h);
    h.db
      .prepare(
        `INSERT INTO reviews (id,job_id,run_id,provider,verdict,summary,findings,head_ref,blocking,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'rev-blocking',
        first.id,
        null,
        'codex',
        'request_changes',
        'blocking findings remain',
        JSON.stringify([highFinding()]),
        first.headRef,
        1,
        nowIso(),
      );

    const continuation = h.jobs.create({
      projectId: h.project.id,
      request: 'continue',
      predecessorJobId: first.id,
    });
    h.pipeline.start(continuation.id);
    const deadline = Date.now() + 20_000;
    while (h.pipeline.isRunning(continuation.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const facts = seen.at(-1)?.continuation as Record<string, unknown> | undefined;
    expect(facts).toBeDefined();
    expect(facts?.sourceHead).toBe(first.headRef);
    expect(facts?.highSeverityFindings).toBe(1);
    expect(facts?.filesChanged).toBeGreaterThan(0);
    const implementer = h.provider.calls.filter((call) => call.role === 'implementer').at(-1);
    expect(implementer?.model).toBe('opus');
    expect(implementer?.effort).toBe('high');
    h.db.close();
  });

  // ADVICE MUST NEVER FAIL A JOB. It did once: the advisor called a registry
  // method a partially wired registry did not have, the TypeError escaped
  // `execute`, and a Job that would otherwise have completed paused with a
  // crash reason. The whole stage is advisory; nothing inside it may become the
  // reason work stopped.
  it('completes the Job when the advisor throws', async () => {
    const h = await harness({
      review: APPROVES.review,
      advisor: {
        advise: async () => {
          throw new TypeError('agents.recordResult is not a function');
        },
      },
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('awaiting_user');
    expect(job.executionRecommendation).toBeNull();
    expect(h.provider.calls.find((call) => call.role === 'implementer')?.model).toBe('sonnet');
    h.db.close();
  });

  it('falls back to the deterministic policy when the advisor returns nothing', async () => {
    const h = await harness({
      review: APPROVES.review,
      advisor: { advise: async () => null },
    });
    const job = await runToRest(h);

    expect(job.stage).toBe('awaiting_user');
    expect(job.executionRecommendation).toBeNull();
    expect(h.provider.calls.find((call) => call.role === 'implementer')?.model).toBe('sonnet');
    h.db.close();
  });
});
