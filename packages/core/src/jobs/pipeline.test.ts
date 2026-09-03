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
import { JobService } from './service.js';
import { ProjectService, type Project, type ProjectCommands } from '../projects/service.js';
import type { Review, ReviewFinding, ReviewOptions } from '../review/engine.js';
import { VerificationEngine, type VerificationReport } from '../verification/engine.js';
import { JobPipeline } from './pipeline.js';
import { nowIso } from '../ids.js';
import type { VisualQaShot } from '../visualqa/engine.js';
import type { InteractiveVisualQaResult, VisualQaBrief } from '../visualqa/agent.js';
import type { JobStage } from './machine.js';

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
  agentStageRetries?: number;
  commands?: ProjectCommands;
  packageManifestForInstall?: boolean;
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
      maxReviewFixCycles: options.maxReviewFixCycles ?? 2,
      maxVisualFixCycles: 2,
      agentStageRetries: options.agentStageRetries ?? 1,
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
      const configured = options.verification?.[verificationCalls.length - 1];
      if (configured) {
        return {
          ...configured,
          results: configured.results.map((result) => ({ ...result, cycle: input.cycle })),
        };
      }
      return {
        passed: true,
        ran: 1,
        failureSummary: '',
        failureKind: 'none',
        results: [
          {
            id: `ver-${verificationCalls.length}`,
            name: 'fixture',
            command: 'fixture',
            status: 'passed',
            exitCode: 0,
            output: '',
            outputPath: null,
            durationMs: 1,
            cycle: input.cycle,
            kind: 'check',
            required: true,
            failureKind: 'none',
          },
        ],
      };
    },
    latestReport(jobId: string): VerificationReport {
      return options.realVerification ? realVerification.latestReport(jobId) : passedVerification();
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
    expect(job.pauseReason).toContain('dirty');
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
  const failure = (error: string): AgentRunResult => ({
    status: 'failed',
    result: '',
    error,
    memoryProposals: [],
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
    const h = await harness({ review, providers: [preferred, fallback], agentStageRetries: 2 });
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
      agentStageRetries: 2,
    });
    const { result } = await runStage(h, 'codex', 'codex-broken');

    expect(result.status).toBe('failed');
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual(['codex-broken', undefined]);
    expect(claude.calls.map((call) => call.resumeSessionId)).toEqual([undefined]);
    expect(codex.calls.length + claude.calls.length).toBe(3);
    h.db.close();
  });

  it('does not exceed a zero-retry budget for a broken resumed session', async () => {
    const codex = new FakeProvider('codex', () =>
      failure('Codex exited without a terminal structured event'),
    );
    const h = await harness({ review, providers: [codex], agentStageRetries: 0 });
    const { result } = await runStage(h, 'codex', 'codex-broken');

    expect(result.status).toBe('failed');
    expect(codex.calls.map((call) => call.resumeSessionId)).toEqual(['codex-broken']);
    h.db.close();
  });
});
