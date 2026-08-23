import type { Db } from '../db/index.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import type { JobService, Job } from './service.js';
import type { ProjectService, Project } from '../projects/service.js';
import type { SessionService } from '../sessions/service.js';
import type { MemoryService } from '../memory/service.js';
import type { ContextPackBuilder } from '../context/pack.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { VerificationEngine, VerificationReport } from '../verification/engine.js';
import type { ReviewEngine, Review } from '../review/engine.js';
import { VisualQaEngine, startDevServer } from '../visualqa/engine.js';
import { GitWorkspace } from '../git/workspace.js';
import { MEMORY_PROPOSAL_INSTRUCTIONS } from '../agents/proposals.js';
import {
  proposalToInput,
  type AgentEvent,
  type AgentRunResult,
  type ProviderId,
} from '../agents/types.js';
import type { MemoryInput } from '../memory/types.js';

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
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: PipelineDeps) {
    this.config = deps.config ?? getConfig();
    this.git = new GitWorkspace(this.config.worktreesDir);
    this.visualQa = new VisualQaEngine(deps.db, this.config.artifactsDir, deps.bus);
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
    if (this.running.has(jobId)) return;
    const controller = new AbortController();
    this.running.set(jobId, controller);
    void this.execute(jobId, controller.signal)
      .catch((error: unknown) => {
        log.error('pipeline crashed', { jobId, error: String(error) });
        try {
          const job = this.deps.jobs.get(jobId);
          if (job && job.status === 'running') {
            this.deps.jobs.transition(jobId, 'failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch {
          /* job already terminal */
        }
      })
      .finally(() => this.running.delete(jobId));
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const { jobs, projects, context, agents, verification, review, sessions, bus } = this.deps;
    let job = jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const project = projects.get(job.projectId);
    if (!project) throw new Error(`project not found: ${job.projectId}`);

    // ------------------------------------------------------------- planning --
    job = jobs.transition(jobId, 'planning');
    const worktree = await this.git
      .createWorktree({ repoRoot: project.rootPath, jobId })
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

    const session = job.sessionId ? sessions.get(job.sessionId) : null;
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

    // --------------------------------------------------------- implementing --
    job = jobs.transition(jobId, 'implementing');
    const routed = await agents.route('implementer', {
      prefer: this.config.agents.implementerProvider,
    });
    if (!routed.provider) {
      jobs.transition(jobId, 'failed', { error: `No coding agent available: ${routed.reason}` });
      return;
    }
    const providerId = routed.provider.id as ProviderId;

    const implResult = await this.runAgent({
      jobId,
      provider: providerId,
      role: 'implementer',
      cwd: worktree.path,
      contextPackId: pack.id,
      prompt: buildImplementerPrompt({ job, project, contextPack: pack.rendered }),
      signal,
    });

    if (implResult.status === 'cancelled' || signal.aborted) {
      jobs.transition(jobId, 'cancelled');
      return;
    }
    if (implResult.status !== 'completed') {
      jobs.transition(jobId, 'failed', {
        error: `Implementer failed: ${implResult.error ?? 'unknown'}`,
      });
      return;
    }

    // Agents do not reliably commit; make the candidate a real ref either way.
    await this.git.commitPending(worktree.path, `jarvis: ${job.goal}`);

    // ------------------------------------------------ verifying (+ fixing) ---
    let verificationReport: VerificationReport | null = null;
    let cycle = 0;
    for (;;) {
      if (signal.aborted) return void jobs.transition(jobId, 'cancelled');
      jobs.transition(jobId, 'verifying');
      verificationReport = await verification.run({
        jobId,
        cwd: worktree.path,
        commands: project.commands,
        cycle,
        signal,
      });
      if (verificationReport.passed || verificationReport.ran === 0) break;
      if (cycle >= this.config.pipeline.maxFixCycles) {
        bus.emit({
          type: 'verification.completed',
          jobId,
          payload: {
            note: `verification still failing after ${cycle} fix cycle(s); continuing to review`,
          },
        });
        break;
      }

      cycle += 1;
      jobs.transition(jobId, 'fixing', { fixCycles: cycle });
      const fixResult = await this.runAgent({
        jobId,
        provider: providerId,
        role: 'fixer',
        cwd: worktree.path,
        contextPackId: pack.id,
        prompt: buildFixerPrompt({ job, failures: verificationReport.failureSummary }),
        signal,
        // Resuming the implementer's session keeps its working context without
        // re-sending it, which is both cheaper and more accurate.
        resumeSessionId: implResult.sessionId,
      });
      await this.git.commitPending(worktree.path, `jarvis: fix cycle ${cycle}`);
      if (fixResult.status === 'cancelled') return void jobs.transition(jobId, 'cancelled');
    }

    await this.git.commitPending(worktree.path, 'jarvis: deterministic verification updates');
    const changes = await this.git.validateCandidate(worktree.path, worktree.baseRef);
    job = jobs.patch(jobId, { headRef: changes.head });

    // ------------------------------------------------------------ reviewing --
    if (signal.aborted) return void jobs.transition(jobId, 'cancelled');
    const reviewerPack = await context.build({
      role: 'reviewer',
      query: `${job.goal}\n${job.request}`,
      projectId: project.id,
      sessionId: job.sessionId,
      jobId,
      projectSnapshot: renderProjectSnapshot(project),
      sessionState: session ? sessions.renderState(session.state) : null,
    });
    jobs.transition(jobId, 'reviewing');
    const reviewResult = await review.review({
      jobId,
      cwd: worktree.path,
      request: job.request,
      goal: job.goal,
      acceptance: job.acceptance,
      diff: changes.diff,
      files: changes.files,
      verification: verificationReport,
      contextPack: reviewerPack.rendered,
      contextPackId: reviewerPack.id,
      implementerProvider: providerId,
      implementerSummary: implResult.result,
      signal,
    });

    if (signal.aborted) return void jobs.transition(jobId, 'cancelled');
    const rejection = candidateRejectionReason(verificationReport, reviewResult.verdict);
    if (rejection) {
      const episodeId = await this.consolidate({
        job,
        project,
        changes,
        verification: verificationReport,
        review: reviewResult,
        implementerSummary: implResult.result,
        proposals: [],
        runId: implResult.runId,
      });
      jobs.transition(jobId, 'failed', {
        episodeId,
        error: rejection,
      });
      return;
    }

    // ------------------------------------------------------------ visual QA --
    const shouldVisualQa = Boolean(project.commands.dev && project.devUrl);
    if (shouldVisualQa) {
      jobs.transition(jobId, 'visual_qa');
      await this.runVisualQa(jobId, project, worktree.path, signal);
    }
    if (signal.aborted) return void jobs.transition(jobId, 'cancelled');

    try {
      await this.git.validateCandidate(worktree.path, worktree.baseRef, changes.head);
    } catch (error) {
      jobs.transition(jobId, 'failed', {
        error: `Candidate changed after review: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    // ------------------------------------------- memory consolidation + done --
    const episodeId = await this.consolidate({
      job,
      project,
      changes,
      verification: verificationReport,
      review: reviewResult,
      implementerSummary: implResult.result,
      proposals: implResult.proposals,
      runId: implResult.runId,
    });
    if (signal.aborted) return void jobs.transition(jobId, 'cancelled', { episodeId });

    // V1 safety rule: a successful job NEVER auto-merges. The user decides.
    jobs.transition(jobId, 'awaiting_user', { episodeId });
    log.info('job finished', {
      jobId,
      verdict: reviewResult.verdict,
      verified: verificationReport.passed,
    });
  }

  private async runVisualQa(
    jobId: string,
    project: Project,
    cwd: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!project.commands.dev || !project.devUrl) return;
    let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
    try {
      server = await startDevServer({
        command: project.commands.dev,
        cwd,
        url: project.devUrl,
        signal,
      });
      await this.visualQa.capture({
        jobId,
        projectId: project.id,
        baseUrl: project.devUrl,
        routes: project.stack.webRoutes?.length ? project.stack.webRoutes : ['/'],
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      // Visual QA failing must never fail the job — it is evidence, not a gate.
      // But record WHY, as a real row: an empty screenshot list with no
      // explanation is indistinguishable from "the page was fine".
      const message = error instanceof Error ? error.message : String(error);
      this.visualQa.recordFailure({
        jobId,
        projectId: project.id,
        route: project.devUrl ?? '(dev server)',
        error: `Could not start the dev server for visual QA: ${message}`,
      });
      this.deps.bus.emit({
        type: 'visual_qa.completed',
        jobId,
        payload: { error: message, captured: 0 },
      });
    } finally {
      await server?.stop();
    }
  }

  private async runAgent(opts: {
    jobId: string;
    provider: ProviderId;
    role: 'implementer' | 'fixer';
    cwd: string;
    prompt: string;
    contextPackId: string;
    signal: AbortSignal;
    resumeSessionId?: string | undefined;
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
    });

    const onEvent = (event: AgentEvent) => {
      switch (event.kind) {
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
          signal: opts.signal,
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
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

    jobs.finishRun(run.id, {
      status: result.status === 'completed' ? 'completed' : result.status,
      result: result.result,
      error: result.error ?? null,
      externalSessionId: result.sessionId ?? null,
      usage: result.usage ?? {},
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
