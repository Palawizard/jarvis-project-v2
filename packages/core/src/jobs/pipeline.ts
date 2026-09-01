import type { Db } from '../db/index.js';
import fs from 'node:fs';
import { getConfig, type JarvisConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import type { JobService, Job } from './service.js';
import type { ProjectService, Project } from '../projects/service.js';
import { renderProjectProfile } from '../projects/profile.js';
import type { SessionService } from '../sessions/service.js';
import type { MemoryService } from '../memory/service.js';
import type { ContextPackBuilder } from '../context/pack.js';
import {
  classifyAgentFailure,
  describeAgentFailure,
  INFRASTRUCTURE_FAILURE_KINDS,
  type AgentFailureKind,
  type AgentRegistry,
} from '../agents/registry.js';
import type { VerificationEngine, VerificationReport } from '../verification/engine.js';
import type { ReviewEngine, Review, ReviewFinding } from '../review/engine.js';
import { VisualQaEngine, isEvidenceCoverageFailure } from '../visualqa/engine.js';
import type { VisualQaPlan } from '../visualqa/surfaces.js';
import {
  isSelfUiFile,
  resolveVisualPlanForCandidate,
  VisualQaPlanningError,
} from '../visualqa/candidate-plan.js';
import { VisualReviewer } from '../visualqa/reviewer.js';
import { startCandidateRuntime } from '../runtime/candidate.js';
import { GitWorkspace, repoStatus } from '../git/workspace.js';
import { MEMORY_PROPOSAL_INSTRUCTIONS } from '../agents/proposals.js';
import {
  proposalToInput,
  type AgentEvent,
  type AgentRunResult,
  type ProviderId,
} from '../agents/types.js';
import type { MemoryInput } from '../memory/types.js';
import { redactSecrets } from '../memory/secrets.js';
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

/** One agent stage's outcome, including *why* it failed if it did. */
export interface AgentStageOutcome {
  status: string;
  result: string;
  error?: string | undefined;
  /** Absent on success. Infrastructure kinds must never invoke a source fixer. */
  failureKind?: AgentFailureKind | undefined;
  sessionId?: string | undefined;
  provider?: ProviderId;
  proposals: ReturnType<typeof proposalToInput>[];
  runId: string;
}

/**
 * Pause text for a failed agent stage.
 *
 * An infrastructure failure says so in its first line, because "agent reported
 * an error" on a quota pause is what makes a provider outage look like broken
 * code — and what would tempt anyone reading it to send a fixer at the source.
 */
export function agentStagePauseReason(outcome: AgentStageOutcome, fallback: string): string {
  const kind = outcome.failureKind;
  if (!kind) return outcome.error ?? fallback;
  const headline = describeAgentFailure(kind, outcome.error);
  const infrastructure = INFRASTRUCTURE_FAILURE_KINDS.includes(kind);
  return [
    headline,
    infrastructure ? 'No source fix was attempted: nothing about the candidate caused this.' : '',
    outcome.error ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
    let infrastructureAttempts = 0;
    let verificationMutationCycles = 0;
    let verificationCycle =
      Number(
        (
          this.deps.db
            .prepare('SELECT MAX(cycle) AS cycle FROM verifications WHERE job_id=?')
            .get(jobId) as { cycle?: number | null }
        ).cycle ?? -1,
      ) + 1;
    for (;;) {
      job = jobs.get(jobId) as Job;
      if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');

      // Verification failures have their own bounded repair budget.
      let report: VerificationReport;
      let verifiedHead = '';
      for (;;) {
        const verificationPatch = {
          pauseReason: null,
          error: null,
          restartReason: null,
          repairKind: null,
          repairCheckpoint: null,
        };
        if (job.stage === 'verifying') jobs.patch(jobId, verificationPatch);
        else jobs.transition(jobId, 'verifying', verificationPatch);
        job = jobs.get(jobId) as Job;
        verifiedHead = await this.git.resolveCommit(input.cwd, 'HEAD');
        report = await verification.run({
          jobId,
          cwd: input.cwd,
          commands: input.project.commands,
          steps: input.project.config.verification?.steps,
          cycle: verificationCycle++,
          signal: input.signal,
        });
        if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');
        if (job.validationOnly) {
          try {
            await this.git.validateMaterializedCandidate(
              input.cwd,
              job.baseRef as string,
              job.headRef as string,
              job.candidateSourceSha as string,
            );
          } catch (error) {
            this.pause(
              jobId,
              'verifying',
              `Validation-only source identity changed during verification: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        } else if (!report.passed) {
          try {
            await this.git.validateCandidate(input.cwd, job.baseRef as string, verifiedHead);
          } catch (error) {
            this.pause(
              jobId,
              'verifying',
              `Verification changed candidate source before failing; fixer evidence is untrusted: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        }
        if (report.passed) break;
        if (report.failureKind === 'cancelled') {
          jobs.transition(jobId, 'cancelled');
          return;
        }
        if (report.failureKind === 'infrastructure') {
          if (infrastructureAttempts < this.config.pipeline.verificationInfraRetries) {
            infrastructureAttempts += 1;
            this.deps.bus.emit({
              type: 'verification.retry',
              jobId,
              payload: { attempt: infrastructureAttempts, failureKind: report.failureKind },
            });
            continue;
          }
          this.pause(
            jobId,
            'verifying',
            `Verification infrastructure attempts exhausted (${infrastructureAttempts + 1} total).\n\n${report.failureSummary}`,
          );
          return;
        }
        if (job.validationOnly) {
          this.pause(
            jobId,
            'verifying',
            `Validation-only verification failed; source fixers are disabled.\n\n${report.failureSummary}`,
          );
          return;
        }
        if (job.fixCycles >= this.config.pipeline.maxFixCycles) {
          this.pause(
            jobId,
            'verifying',
            report.failureSummary || 'deterministic verification failed',
          );
          return;
        }
        const cycle = job.fixCycles + 1;
        jobs.transition(jobId, 'fixing', {
          fixCycles: cycle,
          repairKind: 'verification',
          repairCheckpoint: {
            kind: 'verification',
            verification: {
              resultIds: report.results.map((result) => result.id),
              cycle: report.results[0]?.cycle ?? 0,
              failureSummary: report.failureSummary,
            },
          },
        });
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
            `${agentStagePauseReason(fixed, 'verification fixer provider attempts exhausted')}\n\n${report.failureSummary}`,
          );
          return;
        }
        provider = fixed.provider;
        await this.git.commitPending(input.cwd, `jarvis: verification fix ${cycle}`);
        job = jobs.patch(jobId, {
          reviewedHead: null,
          visualHead: null,
          headRef: await this.git.resolveCommit(input.cwd, 'HEAD'),
          repairKind: null,
          repairCheckpoint: null,
        });
      }

      if (!job.validationOnly) {
        await this.git.commitPending(input.cwd, 'jarvis: deterministic verification updates');
        const headAfterVerification = await this.git.resolveCommit(input.cwd, 'HEAD');
        if (headAfterVerification !== verifiedHead) {
          if (verificationMutationCycles >= this.config.pipeline.maxFixCycles) {
            this.pause(
              jobId,
              'verifying',
              'Verification kept changing candidate source; fresh evidence could not stabilize.',
            );
            return;
          }
          verificationMutationCycles += 1;
          job = jobs.patch(jobId, {
            headRef: headAfterVerification,
            reviewedHead: null,
            visualHead: null,
          });
          continue;
        }
      }
      const changes = job.validationOnly
        ? await this.git.validateMaterializedCandidate(
            input.cwd,
            job.baseRef as string,
            job.headRef as string,
            job.candidateSourceSha as string,
          )
        : await this.git.validateCandidate(input.cwd, job.baseRef as string, verifiedHead);
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
        if (job.validationOnly) {
          this.pause(
            jobId,
            'reviewing',
            `Validation-only review found blocking issues; source fixers are disabled.\n\n${renderCodeBlockers(blockers)}`,
          );
          return;
        }
        if (job.reviewFixCycles >= this.config.pipeline.maxReviewFixCycles) {
          this.pause(jobId, 'reviewing', renderCodeBlockers(blockers));
          return;
        }
        const cycle = job.reviewFixCycles + 1;
        jobs.transition(jobId, 'fixing', {
          reviewFixCycles: cycle,
          repairKind: 'code_review',
          repairCheckpoint: {
            kind: 'code_review',
            verification: {
              resultIds: report.results.map((result) => result.id),
              cycle: report.results[0]?.cycle ?? 0,
              failureSummary: report.failureSummary,
            },
            review: { id: reviewResult.id, findings: blockers },
          },
        });
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
            `${agentStagePauseReason(fixed, 'code-review fixer provider attempts exhausted')}\n\n${renderCodeBlockers(blockers)}`,
          );
          return;
        }
        provider = fixed.provider;
        await this.git.commitPending(input.cwd, `jarvis: code review fix ${cycle}`);
        jobs.patch(jobId, {
          reviewedHead: null,
          visualHead: null,
          repairKind: null,
          repairCheckpoint: null,
        });
        continue;
      }
      job = jobs.patch(jobId, { reviewedHead: changes.head });

      const changedFiles = changes.files.map((file) => file.path);
      // The plan comes from the diff, not from a static default list. Capturing
      // surfaces the candidate never touched is what let unrelated findings
      // block narrow jobs and sent the visual fixer at innocent source.
      // For a Jarvis self-candidate the catalog that matters is the CANDIDATE's,
      // not this running version's: a candidate that deletes a view would
      // otherwise be photographed against a surface it no longer has.
      let visualPlan: VisualQaPlan | null = null;
      try {
        visualPlan = await resolveVisualPlanForCandidate({
          job,
          project: input.project,
          changedFiles,
          deletedFiles: changes.deleted,
          head: changes.head,
          signal: input.signal,
        });
      } catch (error) {
        if (!(error instanceof VisualQaPlanningError)) throw error;
        // Planning infrastructure, not a product defect: no source fixer runs.
        jobs.transition(jobId, 'visual_qa');
        this.pause(
          jobId,
          'visual_qa',
          `Visual-QA planning infrastructure: ${error.message}. ` +
            'The candidate could not be mapped onto its own visual surfaces, so no ' +
            'evidence was captured and no source fix was attempted.',
        );
        return;
      }
      if (visualPlan === null && input.project.isSelf) {
        // A self candidate with nothing rendered in its diff plans no evidence
        // rather than borrowing the running parent's stale self scenarios. That
        // decision is persisted as an explicit plan, so approval reads
        // "no evidence required" as a recorded fact rather than an absence.
        const emptyPlan: VisualQaPlan = {
          source: 'changed_surface',
          plannerSource: 'candidate_catalog',
          plannerHead: changes.head,
          required: false,
          scenarios: [],
          reasons: ['no changed rendered self UI'],
          fixtures: [],
        };
        jobs.patch(jobId, { visualQaPlan: emptyPlan });
        this.deps.bus.emit({
          type: 'visual_qa.plan.resolved',
          jobId,
          payload: {
            plannerSource: 'candidate_catalog',
            plannerHead: changes.head,
            skipped: 'no changed rendered self UI',
            changedFiles,
            scenarios: [],
            reasons: emptyPlan.reasons,
            fixtures: [],
          },
        });
      }
      // For the self project, share the planner's own predicate: a narrower gate
      // here would resolve a self plan and then silently drop it for UI the
      // planner does recognise. Other projects keep the original heuristic --
      // widening it would photograph every repo that happens to hold a .tsx.
      const uiChanged = changedFiles.some((file) =>
        input.project.isSelf
          ? isSelfUiFile(file)
          : /^(?:apps\/web\/|src\/.*\.(?:css|html|tsx|jsx|vue|svelte)$)/i.test(file),
      );
      const shouldVisualQa = Boolean(
        visualPlan && (visualPlan.required === true || uiChanged || job.visualQaConfig),
      );
      if (shouldVisualQa && visualPlan) {
        jobs.transition(jobId, 'visual_qa', { visualQaPlan: visualPlan });
        this.deps.bus.emit({
          type: 'visual_qa.plan.resolved',
          jobId,
          payload: {
            source: visualPlan.source,
            plannerSource: visualPlan.plannerSource ?? 'parent',
            ...(visualPlan.plannerHead ? { plannerHead: visualPlan.plannerHead } : {}),
            ...(visualPlan.catalogVersion ? { catalogVersion: visualPlan.catalogVersion } : {}),
            ...(visualPlan.catalogBlobSha ? { catalogBlobSha: visualPlan.catalogBlobSha } : {}),
            ...(visualPlan.catalogDigest ? { catalogDigest: visualPlan.catalogDigest } : {}),
            changedFiles,
            scenarios: visualPlan.scenarios.map((scenario) => ({
              name: scenario.name,
              viewports: scenario.viewports ?? ['desktop', 'mobile'],
            })),
            reasons: visualPlan.reasons,
            fixtures: visualPlan.fixtures,
          },
        });
        const visual = await this.runVisualQa({
          job,
          project: input.project,
          cwd: input.cwd,
          signal: input.signal,
          plan: visualPlan,
          changedFiles,
          implementerProvider: provider,
          headRef: changes.head,
          cycle: job.visualFixCycles,
        });
        if (input.signal.aborted) return void jobs.transition(jobId, 'cancelled');
        if (visual.kind === 'infrastructure' || visual.kind === 'insufficient_evidence') {
          // Neither a browser failure nor a missing screenshot is a product
          // defect, and editing source cannot conjure the missing evidence.
          // These pause for a human; the visual fixer is never invoked.
          this.pause(jobId, 'visual_qa', visual.error);
          return;
        }
        // Only findings on scenarios this diff actually selected may block. An
        // incidental defect on a surface the candidate never touched is
        // advisory: it is pre-existing, not this candidate's regression.
        const planned = new Set(visualPlan.scenarios.map((scenario) => scenario.name));
        const blockingFindings =
          visual.kind === 'product_needs_fix'
            ? visual.review.findings.filter(
                (finding) =>
                  this.config.pipeline.visualBlockingSeverities.includes(finding.severity) &&
                  planned.has(finding.scenarioName),
              )
            : [];
        if (visual.kind === 'product_needs_fix' && blockingFindings.length > 0) {
          const blockingReview = { ...visual.review, findings: blockingFindings };
          if (job.validationOnly) {
            this.pause(
              jobId,
              'visual_qa',
              `Validation-only visual review found blocking issues; source fixers are disabled.\n\n${renderVisualBlockers(blockingReview)}`,
            );
            return;
          }
          if (job.visualFixCycles >= this.config.pipeline.maxVisualFixCycles) {
            this.pause(jobId, 'visual_qa', renderVisualBlockers(blockingReview));
            return;
          }
          const cycle = job.visualFixCycles + 1;
          jobs.transition(jobId, 'fixing', {
            visualFixCycles: cycle,
            repairKind: 'visual',
            repairCheckpoint: {
              kind: 'visual',
              visual: {
                shotIds: visual.shots.map((shot) => shot.id),
                findings: blockingReview.findings,
                cycle: job.visualFixCycles,
              },
            },
          });
          const fixed = await this.runAgentStage({
            jobId,
            role: 'visual_fixer',
            cwd: input.cwd,
            contextPackId: input.contextPackId,
            prompt: buildVisualFixerPrompt({
              job,
              review: blockingReview,
              diff: changes.diff,
              changedFiles,
              plan: visualPlan,
            }),
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
              `${agentStagePauseReason(fixed, 'visual fixer provider attempts exhausted')}\n\n${renderVisualBlockers(blockingReview)}`,
            );
            return;
          }
          provider = fixed.provider;
          await this.git.commitPending(input.cwd, `jarvis: visual fix ${cycle}`);
          jobs.patch(jobId, {
            reviewedHead: null,
            visualHead: null,
            repairKind: null,
            repairCheckpoint: null,
          });
          continue;
        } else {
          job = jobs.patch(jobId, { visualHead: changes.head });
        }
      }

      if (job.validationOnly) {
        await this.git.validateMaterializedCandidate(
          input.cwd,
          job.baseRef as string,
          changes.head,
          job.candidateSourceSha as string,
        );
      } else {
        await this.git.validateCandidate(input.cwd, job.baseRef as string, changes.head);
      }
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
      if (job.validationOnly && (resumeStage === 'implementing' || resumeStage === 'fixing')) {
        jobs.patch(jobId, {
          pauseReason: 'Resume refused: validation-only jobs cannot enter a source-editing stage',
          error: 'Resume refused: validation-only jobs cannot enter a source-editing stage',
        });
        return;
      }
      // The target may have moved on since this candidate was checkpointed —
      // exactly what happens after Jarvis self-updates. Old reviewed work must
      // not be resumed against a repository it has never seen.
      const target = await repoStatus(project.rootPath);
      if (target.head && target.head !== job.baseRef) {
        const detail =
          `Resume refused: this Job was based on ${job.baseRef.slice(0, 8)}, ` +
          `but the target is now ${target.head.slice(0, 8)}. ` +
          'Restart it as a new Job against the current base, or archive it.';
        jobs.patch(jobId, { pauseReason: detail, error: detail });
        bus.emit({
          type: 'system.recovery',
          jobId,
          payload: { reason: 'stale_base', jobBase: job.baseRef, targetHead: target.head },
        });
        return;
      }
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
        let role: 'implementer' | 'fixer' | 'visual_fixer' = 'implementer';
        let prompt = buildResumePrompt(job, resumeStage);
        let imagePaths: string[] | undefined;
        if (resumeStage === 'fixing') {
          const checkpoint = job.repairCheckpoint;
          if (!checkpoint || checkpoint.kind !== job.repairKind) {
            jobs.patch(jobId, {
              pauseReason: 'Resume refused: exact repair checkpoint is missing',
              error: 'Resume refused: exact repair checkpoint is missing',
            });
            return;
          }
          if (checkpoint.kind === 'verification' && checkpoint.verification) {
            role = 'fixer';
            prompt = buildFixerPrompt({
              job,
              failures: checkpoint.verification.failureSummary,
            });
          } else if (
            checkpoint.kind === 'code_review' &&
            checkpoint.review &&
            checkpoint.verification
          ) {
            role = 'fixer';
            prompt = buildReviewFixerPrompt({
              job,
              blockers: checkpoint.review.findings,
              verification: this.deps.verification.reportForResults(
                jobId,
                checkpoint.verification.resultIds,
                checkpoint.verification.failureSummary,
              ),
            });
          } else if (checkpoint.kind === 'visual' && checkpoint.visual) {
            role = 'visual_fixer';
            const changes = await this.git.collectChanges(job.worktreePath, job.baseRef);
            const shots = this.visualQa
              .list(jobId)
              .filter((shot) => checkpoint.visual?.shotIds.includes(shot.id));
            imagePaths = shots.flatMap((shot) =>
              shot.screenshotPath && fs.existsSync(shot.screenshotPath)
                ? [shot.screenshotPath]
                : [],
            );
            if (imagePaths.length !== checkpoint.visual.shotIds.length) {
              jobs.patch(jobId, {
                pauseReason: 'Resume refused: persisted visual repair evidence is incomplete',
                error: 'Resume refused: persisted visual repair evidence is incomplete',
              });
              return;
            }
            prompt = buildVisualFixerPrompt({
              job,
              review: {
                verdict: 'needs_fix',
                findings: checkpoint.visual.findings,
                provider: null,
                model: null,
              },
              diff: changes.diff,
            });
          } else {
            jobs.patch(jobId, {
              pauseReason: 'Resume refused: repair checkpoint is malformed',
              error: 'Resume refused: repair checkpoint is malformed',
            });
            return;
          }
        }
        jobs.transition(jobId, resumeStage, {
          pauseReason: null,
          error: null,
          restartReason: null,
        });
        const resumed = await this.runAgentStage({
          jobId,
          role,
          cwd: job.worktreePath,
          contextPackId: pack.id,
          prompt,
          signal,
          preferredProvider: provider,
          resumeSessionId: job.resumeSessionId ?? undefined,
          ...(imagePaths ? { imagePaths } : {}),
        });
        if (resumed.status === 'cancelled' || signal.aborted) {
          jobs.transition(jobId, 'cancelled');
          return;
        }
        if (resumed.status !== 'completed') {
          this.pause(
            jobId,
            resumeStage,
            agentStagePauseReason(resumed, 'resumed agent stage exhausted'),
          );
          return;
        }
        await this.git.commitPending(job.worktreePath, `jarvis: resume ${resumeStage}`);
        jobs.patch(jobId, {
          headRef: await this.git.resolveCommit(job.worktreePath, 'HEAD'),
          repairKind: null,
          repairCheckpoint: null,
        });
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
      headRef: worktree.baseRef,
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
      this.pause(jobId, 'implementing', agentStagePauseReason(implResult, 'Implementer failed'));
      return;
    }
    await this.git.commitPending(worktree.path, `jarvis: ${job.goal}`);
    jobs.patch(jobId, { headRef: await this.git.resolveCommit(worktree.path, 'HEAD') });
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
    plan: VisualQaPlan;
    changedFiles: string[];
    implementerProvider?: ProviderId;
    headRef: string;
    cycle: number;
  }): Promise<VisualQaOutcome> {
    // Fail closed: if neither the try nor the catch ever assigns (a throw from
    // the catch itself), the finally block and the caller still see a bounded
    // infrastructure outcome rather than an unassigned read.
    let outcome: VisualQaOutcome = {
      kind: 'infrastructure',
      error: 'visual QA did not complete',
    };
    let server: Awaited<ReturnType<typeof startCandidateRuntime>> | undefined;
    try {
      server = await startCandidateRuntime({
        project: opts.project,
        cwd: opts.cwd,
        jobId: opts.job.id,
        config: this.config,
        signal: opts.signal,
        fixtures: opts.plan.fixtures,
        expectedCommit: opts.headRef,
      });
      const shots = await this.visualQa.capture({
        jobId: opts.job.id,
        projectId: opts.project.id,
        baseUrl: server.baseUrl,
        controlCredential: server.controlCredential(),
        routes: opts.plan.scenarios.map((scenario) => scenario.route),
        scenarios: opts.plan.scenarios,
        signal: opts.signal,
        headRef: opts.headRef,
        cycle: opts.cycle,
        expectedDevServerNoise: true,
      });
      await server.stop();
      server = undefined;
      // Deterministic coverage first. The reviewer never gets to decide whether
      // the evidence it was handed is complete, and no source fixer can run on
      // the strength of evidence that was never captured.
      const coverage = checkVisualCoverage(opts.plan, shots, opts.headRef);
      if (coverage) {
        outcome = coverage;
      } else {
        const review = await this.visualReviewer.review({
          jobId: opts.job.id,
          cwd: opts.cwd,
          goal: opts.job.goal,
          acceptance: opts.job.acceptance,
          shots,
          changedFiles: opts.changedFiles,
          planReasons: opts.plan.reasons,
          ...(opts.implementerProvider ? { implementerProvider: opts.implementerProvider } : {}),
          selfDevelopment: opts.project.isSelf,
          signal: opts.signal,
        });
        outcome =
          review.verdict === 'error'
            ? { kind: 'infrastructure', error: review.error ?? 'visual reviewer failed' }
            : review.verdict === 'insufficient_evidence'
              ? {
                  kind: 'insufficient_evidence',
                  error:
                    'Visual review could not see the changed surface in the captured evidence. ' +
                    'This is a QA plan problem, not a product defect; no source fix was attempted.',
                }
              : review.verdict === 'needs_fix'
                ? { kind: 'product_needs_fix', review, shots }
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
        const cleanup = `candidate runtime cleanup also failed: ${error instanceof Error ? error.message : String(error)}`;
        outcome =
          outcome && 'error' in outcome
            ? { ...outcome, error: `${outcome.error}\n\n${cleanup}` }
            : { kind: 'infrastructure', error: cleanup };
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
  }): Promise<AgentStageOutcome> {
    let preferred = opts.preferredProvider;
    // A provider session has authority only as the pair (provider, id). A legacy
    // id without an owner is retired by omission rather than guessed.
    //
    // `lastProvider` is written in the same patch as `resumeSessionId`, so it is
    // the recorded owner of that id. Requiring it to match here makes the
    // one-provider-per-session invariant structural rather than a convention
    // every call site has to remember: a Claude thread can never reach the Codex
    // CLI, whichever caller assembled the pair.
    const sessionOwner = this.deps.jobs.get(opts.jobId)?.lastProvider ?? null;
    let resumeSessionId =
      preferred && opts.resumeSessionId && sessionOwner === preferred
        ? opts.resumeSessionId
        : undefined;
    let last: AgentStageOutcome | undefined;
    const maxAttempts = this.config.pipeline.agentStageRetries;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const routed = await this.deps.agents.route(opts.role, {
        ...(preferred ? { prefer: preferred } : {}),
        jobId: opts.jobId,
        taskProfile: {
          selfDevelopment: this.deps.projects.get(this.deps.jobs.get(opts.jobId)?.projectId ?? '')
            ?.isSelf,
        },
      });
      if (!routed.provider) {
        // Every provider is unusable. That is infrastructure state, and saying
        // so verbatim is what stops it from being read as a code problem.
        last = {
          status: 'failed',
          result: '',
          error: `No healthy provider: ${routed.reason}`,
          failureKind: 'unavailable',
          proposals: [],
          runId: '',
        };
      } else {
        const provider = routed.provider.id;
        const result = await this.runAgent({
          ...opts,
          provider,
          model: routed.decision.model ?? undefined,
          resumeSessionId: resumeSessionId && provider === preferred ? resumeSessionId : undefined,
        });
        last = { ...result, provider };
        if (result.status === 'completed' || result.status === 'cancelled') return last;
        if (
          resumeSessionId &&
          provider === preferred &&
          attempt < maxAttempts &&
          (result.failureKind === 'session_invalid' || result.failureKind === 'protocol')
        ) {
          // Retire the broken external session so nothing replays it: not this
          // loop, and not a later Resume reading it back off the Job row.
          this.deps.jobs.patch(opts.jobId, { resumeSessionId: null });
          this.deps.bus.emit({
            type: 'agent.stage.retry',
            jobId: opts.jobId,
            payload: {
              stage: opts.role,
              attempt: attempt + 1,
              provider,
              recovery: 'fresh_context',
              failureKind: result.failureKind,
              error: result.error,
            },
          });
          // Same provider, same worktree, same prompt - a fresh agent context.
          const fresh = await this.runAgent({
            ...opts,
            provider,
            model: routed.decision.model ?? undefined,
            resumeSessionId: undefined,
          });
          last = { ...fresh, provider };
          if (fresh.status === 'completed' || fresh.status === 'cancelled') return last;
          // The fresh-context recovery is a real provider execution and consumes
          // the next attempt in the existing stage budget.
          attempt += 1;
        }
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
          failureKind: last.failureKind,
          error: last.error,
        },
      });
    }
    return last as AgentStageOutcome;
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
  }): Promise<Omit<AgentStageOutcome, 'provider'>> {
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
            payload: { text: redactSecrets(event.text).slice(0, 4000) },
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
            payload: { note: redactSecrets(event.note) },
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

    agents.recordResult?.(opts.provider, result, { resumed: Boolean(opts.resumeSessionId) });
    // Classified on the raw error, which is the only place the provider's own
    // wording survives. Everything that leaves this boundary is redacted.
    const failureKind = result.status === 'completed' ? undefined : classifyAgentFailure(result);

    // Provider text crosses into prompts, recovery state, events and durable
    // rows after this point. Keep the raw error only for local health
    // classification above; everything leaving this boundary is redacted.
    const safeResult = redactSecrets(result.result);
    const safeError = result.error ? redactSecrets(result.error) : undefined;

    jobs.finishRun(run.id, {
      status: result.status === 'completed' ? 'completed' : result.status,
      result: safeResult,
      error: safeError ?? null,
      externalSessionId: result.sessionId ?? null,
      usage: result.usage ?? {},
    });
    jobs.patch(opts.jobId, {
      lastProvider: opts.provider,
      // A session that just proved unresumable is not a checkpoint. Dropping it
      // here is what stops a later Resume from replaying the same dead thread.
      resumeSessionId:
        failureKind === 'session_invalid'
          ? null
          : (result.sessionId ?? opts.resumeSessionId ?? null),
    });
    bus.emit({
      type: result.status === 'completed' ? 'agent.completed' : 'agent.failed',
      jobId: opts.jobId,
      runId: run.id,
      payload: {
        status: result.status,
        ...(failureKind ? { failureKind } : {}),
        error: safeError,
        sessionId: result.sessionId,
      },
    });

    return {
      status: result.status,
      result: safeResult,
      error: safeError,
      ...(failureKind ? { failureKind } : {}),
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
    reason = redactSecrets(reason);
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

export function renderProjectSnapshot(project: Project, options: { stale?: boolean } = {}): string {
  const lines = [
    `Name: ${project.name}`,
    `Path: ${project.rootPath}`,
    project.aliases.length ? `Also known as: ${project.aliases.join(', ')}` : '',
    `Default branch: ${project.defaultBranch}`,
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
  const base = lines.filter(Boolean).join('\n');
  if (!project.profile) return base;
  // The learned profile is appended rather than merged: the lines above are
  // deterministic facts Jarvis measured, the block below is what a model
  // reported. Keeping them visibly separate is why a stale profile can never
  // masquerade as the current command set.
  return [
    base,
    '',
    'What a previous analysis learned about this project. Orientation only: the',
    'repository on disk is the authority, and nothing below is executable.',
    renderProjectProfile(project.profile, options.stale === true),
  ].join('\n');
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

type VisualShots = Awaited<ReturnType<VisualQaEngine['capture']>>;

/**
 * The distinct things "visual QA did not pass" can mean. Only
 * `product_needs_fix` describes the product; the other failure kinds describe
 * our own evidence, and must never reach a source-editing fixer.
 */
type VisualQaOutcome =
  | { kind: 'pass'; review: VisualReview; shots: VisualShots }
  | { kind: 'product_needs_fix'; review: VisualReview; shots: VisualShots }
  | { kind: 'insufficient_evidence'; error: string }
  | { kind: 'infrastructure'; error: string };

/**
 * Deterministic evidence-coverage gate, run before any reviewer sees an image.
 *
 * Checks that every planned scenario/viewport was captured, that each declared
 * surface selector was actually reached, and that the evidence belongs to the
 * exact candidate HEAD. Returns null when coverage is complete.
 */
export function checkVisualCoverage(
  plan: VisualQaPlan,
  shots: VisualShots,
  headRef: string,
): Extract<VisualQaOutcome, { error: string }> | null {
  const unreached = shots.filter(isEvidenceCoverageFailure);
  if (unreached.length > 0) {
    return {
      kind: 'insufficient_evidence',
      error:
        'Visual QA could not reach the changed surface, so there is no evidence to judge. ' +
        'This is a QA plan/fixture problem, not a product defect.\n' +
        unreached.map((shot) => `- ${shot.error ?? 'unreached'}`).join('\n'),
    };
  }
  if (shots.some((shot) => shot.status !== 'captured')) {
    return { kind: 'infrastructure', error: 'visual QA did not capture every scenario' };
  }
  const captured = new Set(shots.map((shot) => `${shot.scenarioName} ${shot.viewport}`));
  const missing = plan.scenarios.flatMap((scenario) =>
    (scenario.viewports ?? ['desktop', 'mobile']).flatMap((viewport) =>
      captured.has(`${scenario.name} ${viewport}`) ? [] : [`${scenario.name} - ${viewport}`],
    ),
  );
  if (missing.length > 0) {
    return {
      kind: 'insufficient_evidence',
      error:
        `Visual QA plan required evidence that was never captured: ${missing.join(', ')}. ` +
        'No source fix can create a missing screenshot.',
    };
  }
  // Evidence must belong to the exact reviewed candidate, never an older cycle.
  if (shots.some((shot) => shot.headRef !== headRef)) {
    return {
      kind: 'infrastructure',
      error: 'visual evidence does not match the exact candidate HEAD',
    };
  }
  return null;
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

function buildVisualFixerPrompt(input: {
  job: Job;
  review: VisualReview;
  diff: string;
  changedFiles?: string[];
  plan?: VisualQaPlan;
}): string {
  return `Fix only the visible product issues shown in the attached screenshots.

## Request
${input.job.request}

## Acceptance criteria
${input.job.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}

## Files this candidate changed
${input.changedFiles?.map((file) => `- ${file}`).join('\n') || '- unknown'}

## Why these surfaces were captured
${input.plan?.reasons.map((reason) => `- ${reason}`).join('\n') || '- project default scenarios'}

## Blocking structured visual findings
${JSON.stringify(input.review.findings, null, 2)}

## Current diff summary
${input.diff.slice(0, 12_000)}

## Scope
Do NOT edit a surface that is not implicated by the candidate diff above, even
if it appears in a screenshot. A pre-existing problem on an unrelated surface is
out of scope: leave it alone and say so in your summary. The one exception is a
cross-surface regression the evidence proves this candidate introduced - for
example when the diff changes a global stylesheet or shared layout component.

Never "fix" missing evidence. If a finding is that something is not visible or
was not captured, that is a QA plan problem: change no source, and say so.

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
