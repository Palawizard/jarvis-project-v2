import type { Db } from '../db/index.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import type { JobService, Job } from './service.js';
import type { ProjectService, Project, VisualQaScenario } from '../projects/service.js';
import type { SessionService } from '../sessions/service.js';
import type { MemoryService } from '../memory/service.js';
import type { ContextPackBuilder } from '../context/pack.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { VerificationEngine, VerificationReport } from '../verification/engine.js';
import type { ReviewEngine, Review, ReviewFinding } from '../review/engine.js';
import { VisualQaEngine } from '../visualqa/engine.js';
import { VisualReviewer } from '../visualqa/reviewer.js';
import { startCandidateRuntime } from '../runtime/candidate.js';
import { GitWorkspace } from '../git/workspace.js';
import { MEMORY_PROPOSAL_INSTRUCTIONS } from '../agents/proposals.js';
import {
  proposalToInput,
  type AgentEvent,
  type AgentRunResult,
  type ProviderId,
} from '../agents/types.js';
import type { MemoryInput } from '../memory/types.js';
import type { AgentRole } from '../agents/types.js';
import type { VisualReview } from '../visualqa/reviewer.js';

const log = createLogger('pipeline');

export interface PipelineDeps {
  db: Db;
  bus: EventBus;
  config?: JarvisConfig;
  jobs: JobService;
  projects: ProjectService;
  sessions: SessionService;
  memory: MemoryService;
  context: ContextPackBuilder;
  agents: AgentRegistry;
  verification: VerificationEngine;
  review: ReviewEngine;
  visualQa?: VisualQaEngine;
  visualReviewer?: VisualReviewer;
}

/**
 * The development Job pipeline.
 *
 * planning -> implementing -> verifying -> [fixing] -> reviewing -> visual_qa -> awaiting_user
 *
 * `planning` is deterministic on purpose: worktree setup + context pack, no LLM
 * call. Spending a model round-trip to restate the request before the implementer
 * (which plans anyway) buys nothing and costs quota.
 */
export class JobPipeline {
  private readonly config: JarvisConfig;
  private readonly git: GitWorkspace;
  private readonly visualQa: VisualQaEngine;
  private readonly visualReviewer: VisualReviewer;
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: PipelineDeps) {
    this.config = deps.config ?? getConfig();
    this.git = new GitWorkspace(this.config.worktreesDir);
    this.visualQa =
      deps.visualQa ?? new VisualQaEngine(deps.db, this.config.artifactsDir, deps.bus);
    this.visualReviewer =
      deps.visualReviewer ??
      new VisualReviewer(deps.db, deps.agents, deps.jobs, this.config.artifactsDir, deps.bus);
  }

  private async runCandidateGates(input: {
    job: Job;
    project: Project;
    cwd: string;
    contextPackId: string;
    implementerSummary: string;
    implementerProvider?: ProviderId;
    proposals: ReturnType<typeof proposalToInput>[];
    runId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const { jobs, verification, review, context, sessions } = this.deps;
    const { jobId } = { jobId: input.job.id };
    let job = jobs.get(jobId) as Job;
    let provider = input.implementerProvider;
    for (;;) {
      if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');

      // Verification failures have their own bounded repair budget.
      let report: VerificationReport;
      for (;;) {
        jobs.transition(jobId, 'verifying', { pauseReason: null, error: null });
        job = jobs.get(jobId) as Job;
        report = await verification.run({
          jobId,
          cwd: input.cwd,
          commands: input.project.commands,
          steps: input.project.config.verification?.steps,
          cycle: job.fixCycles + job.reviewFixCycles + job.visualFixCycles,
          signal: input.signal,
        });
        if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');
        if (report.passed) break;
        if (job.fixCycles >= this.config.pipeline.maxFixCycles) {
          this.pause(
            jobId,
            'verifying',
            report.failureSummary || 'deterministic verification failed',
          );
          return;
        }
        const cycle = job.fixCycles + 1;
        jobs.transition(jobId, 'fixing', { fixCycles: cycle });
        const fixed = await this.runAgentStage({
          jobId,
          role: 'fixer',
          cwd: input.cwd,
          contextPackId: input.contextPackId,
          prompt: buildFixerPrompt({ job, failures: report.failureSummary }),
          signal: input.signal,
          preferredProvider: provider,
          resumeSessionId: job.resumeSessionId ?? undefined,
        });
        if (fixed.status === 'cancelled' || input.signal.aborted) {
          jobs.transition(jobId, 'cancelled');
          return;
        }
        if (fixed.status !== 'completed') {
          this.pause(
            jobId,
            'fixing',
            `${fixed.error ?? 'verification fixer provider attempts exhausted'}\n\n${report.failureSummary}`,
          );
          return;
        }
        provider = fixed.provider;
        await this.git.commitPending(input.cwd, `jarvis: verification fix ${cycle}`);
        job = jobs.patch(jobId, {
          reviewedHead: null,
          visualHead: null,
          headRef: await this.git.resolveCommit(input.cwd, 'HEAD'),
        });
      }

      await this.git.commitPending(input.cwd, 'jarvis: deterministic verification updates');
      const changes = await this.git.validateCandidate(input.cwd, job.baseRef as string);
      job = jobs.patch(jobId, { headRef: changes.head, reviewedHead: null, visualHead: null });

      const session = job.sessionId ? sessions.get(job.sessionId) : null;
      const reviewerPack = await context.build({
        role: 'reviewer',
        query: `${job.goal}\n${job.request}`,
        projectId: input.project.id,
        sessionId: job.sessionId,
        jobId,
        projectSnapshot: renderProjectSnapshot(input.project),
        sessionState: session ? sessions.renderState(session.state) : null,
      });
      jobs.transition(jobId, 'reviewing');
      const reviewResult = await review.review({
        jobId,
        cwd: input.cwd,
        request: job.request,
        goal: job.goal,
        acceptance: job.acceptance,
        diff: changes.diff,
        files: changes.files,
        verification: report,
        contextPack: reviewerPack.rendered,
        contextPackId: reviewerPack.id,
        ...(provider ? { implementerProvider: provider } : {}),
        implementerSummary: input.implementerSummary,
        headRef: changes.head,
        taskProfile: { selfDevelopment: input.project.isSelf },
        signal: input.signal,
      });
      if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');
      if (reviewResult.verdict === 'error') {
        this.pause(jobId, 'reviewing', reviewResult.summary);
        return;
      }
      const blockers = reviewResult.findings.filter((finding) =>
        this.config.pipeline.codeReviewBlockingSeverities.includes(finding.severity),
      );
      if (blockers.length) {
        if (job.reviewFixCycles >= this.config.pipeline.maxReviewFixCycles) {
          this.pause(jobId, 'reviewing', renderCodeBlockers(blockers));
          return;
        }
        const cycle = job.reviewFixCycles + 1;
        jobs.transition(jobId, 'fixing', { reviewFixCycles: cycle });
        const fixed = await this.runAgentStage({
          jobId,
          role: 'fixer',
          cwd: input.cwd,
          contextPackId: input.contextPackId,
          prompt: buildReviewFixerPrompt({ job, blockers, verification: report }),
          signal: input.signal,
          preferredProvider: provider,
          resumeSessionId: job.resumeSessionId ?? undefined,
        });
        if (fixed.status === 'cancelled' || input.signal.aborted) {
          jobs.transition(jobId, 'cancelled');
          return;
        }
        if (fixed.status !== 'completed') {
          this.pause(
            jobId,
            'fixing',
            `${fixed.error ?? 'code-review fixer provider attempts exhausted'}\n\n${renderCodeBlockers(blockers)}`,
          );
          return;
        }
        provider = fixed.provider;
        await this.git.commitPending(input.cwd, `jarvis: code review fix ${cycle}`);
        jobs.patch(jobId, { reviewedHead: null, visualHead: null });
        continue;
      }
      job = jobs.patch(jobId, { reviewedHead: changes.head });

      const visualConfig = resolveVisualConfig(job, input.project);
      const uiChanged = changes.files.some((file) =>
        /^(?:apps\/web\/|src\/.*\.(?:css|html|tsx|jsx|vue|svelte)$)/i.test(file.path),
      );
      const shouldVisualQa = Boolean(
        visualConfig && (visualConfig.required === true || uiChanged || job.visualQaConfig),
      );
      if (shouldVisualQa && visualConfig) {
        jobs.transition(jobId, 'visual_qa');
        const visual = await this.runVisualQa({
          job,
          project: input.project,
          cwd: input.cwd,
          signal: input.signal,
          config: visualConfig,
          implementerProvider: provider,
          headRef: changes.head,
          cycle: job.visualFixCycles,
        });
        if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');
        if (visual.kind === 'infrastructure') {
          this.pause(jobId, 'visual_qa', visual.error);
          return;
        } else if (visual.kind === 'blocking') {
          const blockingReview = {
            ...visual.review,
            findings: visual.review.findings.filter((finding) =>
              this.config.pipeline.visualBlockingSeverities.includes(finding.severity),
            ),
          };
          if (job.visualFixCycles >= this.config.pipeline.maxVisualFixCycles) {
            this.pause(jobId, 'visual_qa', renderVisualBlockers(blockingReview));
            return;
          }
          const cycle = job.visualFixCycles + 1;
          jobs.transition(jobId, 'fixing', { visualFixCycles: cycle });
          const fixed = await this.runAgentStage({
            jobId,
            role: 'visual_fixer',
            cwd: input.cwd,
            contextPackId: input.contextPackId,
            prompt: buildVisualFixerPrompt({ job, review: blockingReview, diff: changes.diff }),
            imagePaths: visual.shots.flatMap((shot) =>
              shot.screenshotPath ? [shot.screenshotPath] : [],
            ),
            signal: input.signal,
            preferredProvider: provider,
            resumeSessionId: job.resumeSessionId ?? undefined,
          });
          if (fixed.status === 'cancelled' || input.signal.aborted) {
            jobs.transition(jobId, 'cancelled');
            return;
          }
          if (fixed.status !== 'completed') {
            this.pause(
              jobId,
              'fixing',
              `${fixed.error ?? 'visual fixer provider attempts exhausted'}\n\n${renderVisualBlockers(blockingReview)}`,
            );
            return;
          }
          provider = fixed.provider;
          await this.git.commitPending(input.cwd, `jarvis: visual fix ${cycle}`);
          jobs.patch(jobId, { reviewedHead: null, visualHead: null });
          continue;
        } else {
          job = jobs.patch(jobId, { visualHead: changes.head });
        }
      }

      await this.git.validateCandidate(input.cwd, job.baseRef as string, changes.head);
      job = jobs.get(jobId) as Job;
      if (
        job.reviewedHead !== changes.head ||
        (shouldVisualQa && job.visualHead !== changes.head)
      ) {
        this.pause(
          jobId,
          shouldVisualQa ? 'visual_qa' : 'reviewing',
          'candidate evidence identity is stale',
        );
        return;
      }
      const episodeId = await this.consolidate({
        job,
        project: input.project,
        changes,
        verification: report,
        review: reviewResult,
        implementerSummary: input.implementerSummary,
        proposals: input.proposals,
        runId: input.runId,
      });
      if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled', { episodeId });
      jobs.transition(jobId, 'awaiting_user', { episodeId, pauseReason: null, error: null });
      log.info('job finished', { jobId, verdict: reviewResult.verdict, verified: report.passed });
      return;
    }
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  cancel(jobId: string): boolean {
    const controller = this.running.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Fire-and-forget entry point used by the HTTP layer. */
  start(jobId: string): void {
    const job = this.deps.jobs.get(jobId);
    if (!job || job.stage !== 'queued') return;
    this.launch(jobId);
  }

  resume(jobId: string): void {
    const job = this.deps.jobs.get(jobId);
    if (!job || job.stage !== 'paused') return;
    this.launch(jobId);
  }

  private launch(jobId: string): void {
    if (this.running.has(jobId)) return;
    const controller = new AbortController();
    this.running.set(jobId, controller);
    void this.execute(jobId, controller.signal)
      .catch((error: unknown) => {
        log.error('pipeline crashed', { jobId, error: String(error) });
        try {
          const job = this.deps.jobs.get(jobId);
          if (job) {
            const message = error instanceof Error ? error.message : String(error);
            if (job.stage === 'paused') {
              this.deps.jobs.patch(jobId, {
                pauseReason: `Resume refused: ${message}`,
                error: `Resume refused: ${message}`,
              });
            } else if (job.status === 'running' && job.worktreePath) {
              this.pause(jobId, job.stage, message);
            } else if (job.status === 'running') {
              this.deps.jobs.transition(jobId, 'failed', { error: message });
            }
          }
        } catch {
          /* job already terminal */
        }
      })
      .finally(() => this.running.delete(jobId));
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const { jobs, projects, context, sessions, bus } = this.deps;
    let job = jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const project = projects.get(job.projectId);
    if (!project) throw new Error(`project not found: ${job.projectId}`);

    const session = job.sessionId ? sessions.get(job.sessionId) : null;

    if (job.stage === 'paused') {
      const resumeStage = job.resumeStage ?? 'verifying';
      if (!job.worktreePath || !job.baseRef) {
        if (resumeStage !== 'planning') {
          jobs.patch(jobId, {
            pauseReason: 'Resume refused: paused job has no recoverable worktree checkpoint',
            error: 'Resume refused: paused job has no recoverable worktree checkpoint',
          });
          return;
        }
        job = jobs.transition(jobId, 'planning', { pauseReason: null, error: null });
      }
    }

    if (job.stage === 'paused' && job.worktreePath && job.baseRef) {
      const resumeStage = job.resumeStage ?? 'verifying';
      await this.git.validateRecoveryWorkspace({
        repoRoot: project.rootPath,
        worktreePath: job.worktreePath,
        baseRef: job.baseRef,
        expectedHead: job.headRef,
        allowDirty: resumeStage === 'implementing' || resumeStage === 'fixing',
      });
      const pack = await context.build({
        role: 'implementer',
        query: `${job.goal}\n${job.request}`,
        projectId: project.id,
        sessionId: job.sessionId,
        jobId,
        projectSnapshot: renderProjectSnapshot(project),
        sessionState: session ? sessions.renderState(session.state) : null,
      });
      let summary =
        jobs
          .runs(jobId)
          .filter((run) => run.result)
          .at(-1)?.result ?? 'resumed candidate';
      let provider = job.lastProvider ?? undefined;
      let runId = jobs.runs(jobId).at(-1)?.id ?? '';
      if (resumeStage === 'implementing' || resumeStage === 'fixing') {
        jobs.transition(jobId, resumeStage, { pauseReason: null, error: null });
        const resumed = await this.runAgentStage({
          jobId,
          role: resumeStage === 'implementing' ? 'implementer' : 'fixer',
          cwd: job.worktreePath,
          contextPackId: pack.id,
          prompt: buildResumePrompt(job, resumeStage),
          signal,
          preferredProvider: provider,
          resumeSessionId: job.resumeSessionId ?? undefined,
        });
        if (resumed.status === 'cancelled' || signal.aborted) {
          jobs.transition(jobId, 'cancelled');
          return;
        }
        if (resumed.status !== 'completed') {
          this.pause(jobId, resumeStage, resumed.error ?? 'resumed agent stage exhausted');
          return;
        }
        await this.git.commitPending(job.worktreePath, `jarvis: resume ${resumeStage}`);
        summary = resumed.result;
        provider = resumed.provider;
        runId = resumed.runId;
      }
      await this.runCandidateGates({
        job: jobs.get(jobId) as Job,
        project,
        cwd: job.worktreePath,
        contextPackId: pack.id,
        implementerSummary: summary,
        implementerProvider: provider,
        proposals: [],
        runId,
        signal,
      });
      return;
    }

    // ------------------------------------------------------------- planning --
    if (job.stage !== 'planning') job = jobs.transition(jobId, 'planning');
    const source =
      job.validationOnly && job.candidateBaseSha && job.candidateSourceSha
        ? await this.git.validateCandidateSource(
            project.rootPath,
            job.candidateBaseSha,
            job.candidateSourceSha,
          )
        : null;
    const worktree = await this.git
      .createWorktree({
        repoRoot: project.rootPath,
        jobId,
        ...(source ? { baseRef: source.baseSha } : {}),
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        jobs.transition(jobId, 'failed', { error: `Worktree creation failed: ${message}` });
        return null;
      });
    if (!worktree) return;

    if (worktree.warnings.length) {
      bus.emit({
        type: 'job.stage.changed',
        jobId,
        payload: { note: worktree.warnings.join(' ') },
      });
    }
    job = jobs.patch(jobId, {
      branch: worktree.branch,
      worktreePath: worktree.path,
      baseRef: worktree.baseRef,
    });

    const pack = await context.build({
      role: 'implementer',
      query: `${job.goal}\n${job.request}`,
      projectId: project.id,
      sessionId: job.sessionId,
      jobId,
      projectSnapshot: renderProjectSnapshot(project),
      sessionState: session ? sessions.renderState(session.state) : null,
    });

    if (signal.aborted) return void jobs.transition(jobId, 'cancelled');

    if (source) {
      const head = await this.git.materializeCandidate(
        worktree.path,
        source.baseSha,
        source.sourceSha,
      );
      job = jobs.patch(jobId, {
        headRef: head,
        candidateBaseSha: source.baseSha,
        candidateSourceSha: source.sourceSha,
      });
      await this.runCandidateGates({
        job,
        project,
        cwd: worktree.path,
        contextPackId: pack.id,
        implementerSummary: `Validation-only import of ${source.sourceSha}`,
        proposals: [],
        runId: '',
        signal,
      });
      return;
    }

    job = jobs.transition(jobId, 'implementing');
    const implResult = await this.runAgentStage({
      jobId,
      role: 'implementer',
      cwd: worktree.path,
      contextPackId: pack.id,
      prompt: buildImplementerPrompt({ job, project, contextPack: pack.rendered }),
      signal,
      preferredProvider: this.config.agents.implementerProvider,
    });
    if (implResult.status === 'cancelled' || signal.aborted) {
      jobs.transition(jobId, 'cancelled');
      return;
    }
    if (implResult.status !== 'completed') {
      this.pause(
        jobId,
        'implementing',
        `Implementer unavailable: ${implResult.error ?? 'unknown'}`,
      );
      return;
    }
    await this.git.commitPending(worktree.path, `jarvis: ${job.goal}`);
    await this.runCandidateGates({
      job: jobs.get(jobId) as Job,
      project,
      cwd: worktree.path,
      contextPackId: pack.id,
      implementerSummary: implResult.result,
      implementerProvider: implResult.provider,
      proposals: implResult.proposals,
      runId: implResult.runId,
      signal,
    });
  }

  private async runVisualQa(opts: {
    job: Job;
    project: Project;
    cwd: string;
    signal: AbortSignal;
    config: { required?: boolean; scenarios: VisualQaScenario[] };
    implementerProvider?: ProviderId;
    headRef: string;
    cycle: number;
  }): Promise<
    | { kind: 'pass'; review: VisualReview; shots: Awaited<ReturnType<VisualQaEngine['capture']>> }
    | {
        kind: 'blocking';
        review: VisualReview;
        shots: Awaited<ReturnType<VisualQaEngine['capture']>>;
      }
    | { kind: 'infrastructure'; error: string }
  > {
    let outcome:
      | {
          kind: 'pass';
          review: VisualReview;
          shots: Awaited<ReturnType<VisualQaEngine['capture']>>;
        }
      | {
          kind: 'blocking';
          review: VisualReview;
          shots: Awaited<ReturnType<VisualQaEngine['capture']>>;
        }
      | { kind: 'infrastructure'; error: string };
    let server: Awaited<ReturnType<typeof startCandidateRuntime>> | undefined;
    try {
      server = await startCandidateRuntime({
        project: opts.project,
        cwd: opts.cwd,
        jobId: opts.job.id,
        config: this.config,
        signal: opts.signal,
      });
      const shots = await this.visualQa.capture({
        jobId: opts.job.id,
        projectId: opts.project.id,
        baseUrl: server.baseUrl,
        routes: opts.config.scenarios.map((scenario) => scenario.route),
        scenarios: opts.config.scenarios,
        signal: opts.signal,
        headRef: opts.headRef,
        cycle: opts.cycle,
      });
      if (shots.some((shot) => shot.status !== 'captured')) {
        outcome = { kind: 'infrastructure', error: 'visual QA did not capture every scenario' };
      } else {
        const review = await this.visualReviewer.review({
          jobId: opts.job.id,
          cwd: opts.cwd,
          goal: opts.job.goal,
          acceptance: opts.job.acceptance,
          shots,
          ...(opts.implementerProvider ? { implementerProvider: opts.implementerProvider } : {}),
          selfDevelopment: opts.project.isSelf,
          signal: opts.signal,
        });
        outcome =
          review.verdict === 'error'
            ? { kind: 'infrastructure', error: review.error ?? 'visual reviewer failed' }
            : review.verdict === 'needs_fix'
              ? { kind: 'blocking', review, shots }
              : { kind: 'pass', review, shots };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.visualQa.recordFailure({
        jobId: opts.job.id,
        projectId: opts.project.id,
        route: '(candidate runtime)',
        error: `Could not start the dev server for visual QA: ${message}`,
        headRef: opts.headRef,
        cycle: opts.cycle,
      });
      this.deps.bus.emit({
        type: 'visual_qa.completed',
        jobId: opts.job.id,
        payload: { error: message, captured: 0 },
      });
      outcome = { kind: 'infrastructure', error: message };
    } finally {
      try {
        await server?.stop();
      } catch (error) {
        outcome = {
          kind: 'infrastructure',
          error: `candidate runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return outcome;
  }

  private async runAgentStage(opts: {
    jobId: string;
    role: 'implementer' | 'fixer' | 'visual_fixer';
    cwd: string;
    prompt: string;
    contextPackId: string;
    signal: AbortSignal;
    preferredProvider?: ProviderId;
    resumeSessionId?: string;
    imagePaths?: string[];
  }): Promise<Awaited<ReturnType<JobPipeline['runAgent']>> & { provider?: ProviderId }> {
    let preferred = opts.preferredProvider;
    let resumeSessionId = opts.resumeSessionId;
    let last:
      (Awaited<ReturnType<JobPipeline['runAgent']>> & { provider?: ProviderId }) | undefined;
    for (let attempt = 0; attempt <= this.config.pipeline.agentStageRetries; attempt++) {
      const routed = await this.deps.agents.route(opts.role, {
        ...(preferred ? { prefer: preferred } : {}),
        jobId: opts.jobId,
        taskProfile: {
          selfDevelopment: this.deps.projects.get(this.deps.jobs.get(opts.jobId)?.projectId ?? '')
            ?.isSelf,
        },
      });
      if (!routed.provider) {
        last = {
          status: 'failed',
          result: '',
          error: `No healthy provider: ${routed.reason}`,
          proposals: [],
          runId: '',
        };
      } else {
        const provider = routed.provider.id;
        const result = await this.runAgent({
          ...opts,
          provider,
          model: routed.decision.model ?? undefined,
          ...(resumeSessionId && provider === preferred ? { resumeSessionId } : {}),
        });
        last = { ...result, provider };
        if (result.status === 'completed' || result.status === 'cancelled') return last;
        preferred = undefined;
        resumeSessionId = undefined;
      }
      this.deps.bus.emit({
        type: 'agent.stage.retry',
        jobId: opts.jobId,
        payload: {
          stage: opts.role,
          attempt: attempt + 1,
          provider: last.provider,
          error: last.error,
        },
      });
    }
    return last as Awaited<ReturnType<JobPipeline['runAgent']>> & { provider?: ProviderId };
  }

  private async runAgent(opts: {
    jobId: string;
    provider: ProviderId;
    role: Extract<AgentRole, 'implementer' | 'fixer' | 'visual_fixer'>;
    cwd: string;
    prompt: string;
    contextPackId: string;
    model?: string;
    signal: AbortSignal;
    resumeSessionId?: string | undefined;
    imagePaths?: string[];
  }): Promise<{
    status: string;
    result: string;
    error?: string | undefined;
    sessionId?: string | undefined;
    proposals: ReturnType<typeof proposalToInput>[];
    runId: string;
  }> {
    const { jobs, agents, bus } = this.deps;
    const provider = agents.get(opts.provider);
    const run = jobs.startRun({
      jobId: opts.jobId,
      provider: opts.provider,
      role: opts.role,
      cwd: opts.cwd,
      contextPackId: opts.contextPackId,
      model: opts.model ?? null,
    });

    const onEvent = (event: AgentEvent) => {
      switch (event.kind) {
        case 'started':
          if (event.sessionId) {
            jobs.checkpointRunSession(run.id, event.sessionId);
            jobs.patch(opts.jobId, {
              lastProvider: opts.provider,
              resumeSessionId: event.sessionId,
            });
          }
          break;
        case 'text':
          bus.emit({
            type: 'agent.output',
            jobId: opts.jobId,
            runId: run.id,
            payload: { text: event.text.slice(0, 4000) },
          });
          break;
        case 'thinking':
          bus.emit({
            type: 'agent.thinking',
            jobId: opts.jobId,
            runId: run.id,
            payload: { chars: event.text.length },
          });
          break;
        case 'tool_started':
          bus.emit({
            type: 'agent.tool.started',
            jobId: opts.jobId,
            runId: run.id,
            payload: { tool: event.tool, id: event.id },
          });
          break;
        case 'tool_completed':
          bus.emit({
            type: 'agent.tool.completed',
            jobId: opts.jobId,
            runId: run.id,
            payload: { tool: event.tool, id: event.id, isError: event.isError },
          });
          break;
        case 'waiting':
          bus.emit({
            type: 'agent.waiting',
            jobId: opts.jobId,
            runId: run.id,
            payload: { note: event.note },
          });
          break;
        default:
          break;
      }
    };

    let result: AgentRunResult;
    try {
      result = await provider.run(
        {
          cwd: opts.cwd,
          prompt: opts.prompt,
          role: opts.role,
          ...(opts.model ? { model: opts.model } : {}),
          signal: opts.signal,
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(opts.imagePaths?.length ? { imagePaths: opts.imagePaths } : {}),
        },
        onEvent,
      );
    } catch (error) {
      result = {
        status: 'failed',
        result: '',
        error: error instanceof Error ? error.message : String(error),
        memoryProposals: [],
      };
    }

    agents.recordResult?.(opts.provider, result);

    jobs.finishRun(run.id, {
      status: result.status === 'completed' ? 'completed' : result.status,
      result: result.result,
      error: result.error ?? null,
      externalSessionId: result.sessionId ?? null,
      usage: result.usage ?? {},
    });
    jobs.patch(opts.jobId, {
      lastProvider: opts.provider,
      resumeSessionId: result.sessionId ?? opts.resumeSessionId ?? null,
    });
    bus.emit({
      type: result.status === 'completed' ? 'agent.completed' : 'agent.failed',
      jobId: opts.jobId,
      runId: run.id,
      payload: { status: result.status, error: result.error, sessionId: result.sessionId },
    });

    return {
      status: result.status,
      result: result.result,
      error: result.error,
      sessionId: result.sessionId,
      proposals: result.memoryProposals.map((p) =>
        proposalToInput(p, {
          projectId: this.deps.jobs.get(opts.jobId)?.projectId ?? null,
          sessionId: this.deps.jobs.get(opts.jobId)?.sessionId ?? null,
          jobId: opts.jobId,
          runId: run.id,
        }),
      ),
      runId: run.id,
    };
  }

  private pause(jobId: string, resumeStage: Job['stage'], reason: string): void {
    this.deps.jobs.transition(jobId, 'paused', {
      resumeStage,
      pauseReason: reason.slice(0, 20_000),
      error: reason.slice(0, 20_000),
    });
    this.deps.bus.emit({
      type: 'system.recovery',
      jobId,
      payload: { reason: 'pipeline_paused', resumeStage, detail: reason.slice(0, 2_000) },
    });
  }

  /**
   * End-of-job consolidation.
   *
   * Produces exactly ONE compact episode plus any validated durable project
   * knowledge. Deterministic: the episode is assembled from structured job
   * results, not by asking a model to summarise a transcript.
   */
  private async consolidate(input: {
    job: Job;
    project: Project;
    changes: {
      commits: { sha: string; subject: string }[];
      files: { path: string }[];
      head: string;
    };
    verification: VerificationReport;
    review: Review;
    implementerSummary: string;
    proposals: ReturnType<typeof proposalToInput>[];
    runId: string;
  }): Promise<string | null> {
    const { memory } = this.deps;

    const verificationLine = input.verification.ran
      ? input.verification.results.map((r) => `${r.name}:${r.status}`).join(', ')
      : 'no verification commands configured';
    const blocking = input.review.findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );

    const episode = [
      `${input.job.createdAt.slice(0, 10)} — Job: ${input.job.goal}`,
      ``,
      `Outcome: ${firstSentences(input.implementerSummary, 3)}`,
      `Files changed: ${input.changes.files.length}${
        input.changes.files.length
          ? ` (${input.changes.files
              .slice(0, 6)
              .map((f) => f.path)
              .join(', ')}${input.changes.files.length > 6 ? ', ...' : ''})`
          : ''
      }`,
      `Verification: ${verificationLine}`,
      `Review: ${input.review.verdict}${input.review.findings.length ? ` — ${input.review.findings.length} finding(s), ${blocking.length} blocking` : ' — no findings'}`,
      input.review.summary ? `Reviewer said: ${firstSentences(input.review.summary, 2)}` : '',
      `Candidate: branch ${input.job.branch ?? 'n/a'} @ ${input.changes.head.slice(0, 8)}`,
    ]
      .filter(Boolean)
      .join('\n');

    const outcome = await memory.remember({
      scope: 'project',
      scopeId: input.project.id,
      kind: 'episode',
      subject: `job.${input.job.id}`,
      content: episode.slice(0, this.config.memory.maxContentChars),
      importance: input.review.verdict === 'approve' && input.verification.passed ? 0.72 : 0.66,
      confidence: 0.95,
      sourceType: 'job_consolidation',
      sourceRef: {
        jobId: input.job.id,
        runId: input.runId,
        sessionId: input.job.sessionId ?? undefined,
      },
      metadata: {
        verdict: input.review.verdict,
        verified: input.verification.passed,
        branch: input.job.branch,
        head: input.changes.head,
        findings: input.review.findings.length,
      },
      explicit: true, // lifecycle boundary: always worth an episode
    });

    // Promote durable project knowledge the agent proposed during work we already paid for.
    const valid = input.proposals.filter(
      (p): p is MemoryInput => p !== null && p.kind !== 'episode',
    );
    if (valid.length) await memory.rememberMany(valid);

    // Unresolved review findings become explicit open items, not silent debt.
    for (const finding of blocking.slice(0, 3)) {
      await memory.remember({
        scope: 'project',
        scopeId: input.project.id,
        kind: 'unresolved',
        content:
          `Open review finding from "${input.job.goal}": ${finding.description} (recommendation: ${finding.recommendation})`.slice(
            0,
            600,
          ),
        importance: finding.severity === 'critical' ? 0.85 : 0.7,
        confidence: 0.8,
        sourceType: 'job_consolidation',
        sourceRef: { jobId: input.job.id },
        explicit: true,
      });
    }

    return outcome.status === 'stored' || outcome.status === 'duplicate' ? outcome.memory.id : null;
  }
}

export function candidateRejectionReason(
  verification: Pick<VerificationReport, 'passed' | 'ran' | 'failureSummary'>,
  reviewVerdict: Review['verdict'],
): string | null {
  if (!verification.passed) {
    return verification.ran === 0 && !verification.failureSummary
      ? 'No deterministic verification commands are configured; candidate remains unverified.'
      : 'Deterministic verification failed; candidate requires changes.';
  }
  return reviewVerdict === 'approve'
    ? null
    : `Independent review did not approve the candidate (${reviewVerdict}).`;
}

function firstSentences(text: string, count: number): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .slice(0, count)
    .join(' ');
  return sentences.length > 400
    ? `${sentences.slice(0, 397)}...`
    : sentences || '(no summary provided)';
}

export function renderProjectSnapshot(project: Project): string {
  const lines = [
    `Name: ${project.name}`,
    `Path: ${project.rootPath}`,
    project.stack.languages.length ? `Languages: ${project.stack.languages.join(', ')}` : '',
    project.stack.frameworks.length ? `Frameworks: ${project.stack.frameworks.join(', ')}` : '',
    project.stack.packageManager ? `Package manager: ${project.stack.packageManager}` : '',
    Object.entries(project.commands).length
      ? `Commands: ${Object.entries(project.commands)
          .map(([k, v]) => `${k}='${v}'`)
          .join(', ')}`
      : '',
    project.summary ? `Summary: ${project.summary}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function buildImplementerPrompt(input: {
  job: Job;
  project: Project;
  contextPack: string;
}): string {
  return `You are a senior engineer working inside an isolated git worktree created for this task.

## Task
${input.job.request}

## Goal
${input.job.goal}
${input.job.acceptance.length ? `\n## Acceptance criteria\n${input.job.acceptance.map((a) => `- ${a}`).join('\n')}` : ''}

${input.contextPack ? `# Context Jarvis retrieved for you\n\n${input.contextPack}\n` : ''}

## Working rules
- You are in a dedicated worktree on branch \`${input.job.branch}\`. Changes here do NOT touch the user's checkout.
- Make the change. Keep the diff focused on the task.
- Follow the conventions already present in the codebase.
- Do NOT run the project's full test/build suite to prove your work — Jarvis runs
  verification itself afterwards and records the real exit codes.
- Finish with a short summary: what you changed, why, and anything you deliberately did not do.

${MEMORY_PROPOSAL_INSTRUCTIONS}`;
}

function buildFixerPrompt(input: { job: Job; failures: string }): string {
  return `Verification failed on the change you just made. Fix it.

## Original goal
${input.job.goal}

## What Jarvis ran and what failed
${input.failures.slice(0, 12_000)}

Fix the underlying cause, not the symptom. Do not disable, skip or weaken checks
to make them pass. If a failure is pre-existing and unrelated to your change, say
so explicitly in your summary instead of papering over it.`;
}

function resolveVisualConfig(
  job: Job,
  project: Project,
): { required?: boolean; scenarios: VisualQaScenario[] } | null {
  if (job.visualQaConfig) return job.visualQaConfig;
  const visual = project.config.visualQa;
  if (!visual) return null;
  const routes = visual.routes?.length
    ? visual.routes
    : project.stack.webRoutes?.length
      ? project.stack.webRoutes
      : ['/'];
  return {
    required: visual.required,
    scenarios: visual.scenarios?.length
      ? visual.scenarios
      : routes.map((route) => ({
          name: route === '/' ? 'default' : route,
          route,
          ...(visual.interactions ? { interactions: visual.interactions } : {}),
        })),
  };
}

function renderCodeBlockers(findings: ReviewFinding[]): string {
  return `Code review repair budget exhausted. Blocking findings:\n${JSON.stringify(findings, null, 2)}`;
}

function renderVisualBlockers(review: VisualReview): string {
  return `Visual repair budget exhausted. Blocking findings:\n${JSON.stringify(review.findings, null, 2)}`;
}

function buildReviewFixerPrompt(input: {
  job: Job;
  blockers: ReviewFinding[];
  verification: VerificationReport;
}): string {
  return `Fix the exact blocking findings from an independent code review in this same worktree.

## Request
${input.job.request}

## Acceptance criteria
${input.job.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}

## Blocking structured findings
${JSON.stringify(input.blockers, null, 2)}

## Latest deterministic verification
${input.verification.results.map((result) => `- ${result.name}: ${result.status}`).join('\n')}

Do not weaken checks or address advisory findings unless the blocking fix requires it. Finish with a concise summary.`;
}

function buildVisualFixerPrompt(input: { job: Job; review: VisualReview; diff: string }): string {
  return `Fix only the visible product issues shown in the attached screenshots.

## Request
${input.job.request}

## Acceptance criteria
${input.job.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}

## Blocking structured visual findings
${JSON.stringify(input.review.findings, null, 2)}

## Current diff summary
${input.diff.slice(0, 12_000)}

The screenshots are evidence. Do not infer or rewrite unrelated hidden behavior. Finish with a concise summary.`;
}

function buildResumePrompt(job: Job, stage: Job['stage']): string {
  return `Resume the interrupted ${stage} stage in the existing worktree.

Original request: ${job.request}
Acceptance criteria:\n${job.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}

Checkpoint reason and exact known stage context:
${job.pauseReason ?? job.error ?? 'orchestrator interruption'}

Inspect the current worktree first; it may contain partial edits from the interrupted session. Continue safely without creating another worktree or changing Git history outside this branch.`;
}
