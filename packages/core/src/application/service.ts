import fs from 'node:fs';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { GitWorkspace, repoStatus } from '../git/workspace.js';
import { newId, nowIso } from '../ids.js';
import { candidateRejectionReason } from '../jobs/pipeline.js';
import type { JobService } from '../jobs/service.js';
import type { ProjectService, VisualQaScenario } from '../projects/service.js';
import type { ReviewEngine } from '../review/engine.js';
import type { VerificationEngine } from '../verification/engine.js';
import { validateVisualEvidence } from '../visualqa/engine.js';
import type { VisualQaPlan } from '../visualqa/surfaces.js';
import { parseVisualReview } from '../visualqa/reviewer.js';

export type CandidateApplicationStatus =
  'approved' | 'applying' | 'applied' | 'failed' | 'inspection_required';

export interface CandidateApplication {
  id: string;
  jobId: string;
  projectId: string;
  status: CandidateApplicationStatus;
  reviewId: string;
  verificationCycle: number;
  candidateBase: string;
  candidateHead: string;
  targetRoot: string | null;
  targetBranch: string | null;
  targetHeadBefore: string | null;
  targetHeadAfter: string | null;
  method: 'ff-only';
  failure: string | null;
  approvedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export class CandidateApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CandidateApplicationError';
  }
}

type Row = Record<string, unknown>;

/** Explicit approval plus a separate, fail-closed FF-only application transaction. */
export class CandidateApplicationService {
  private readonly git: GitWorkspace;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly jobs: JobService,
    private readonly projects: ProjectService,
    private readonly verification: VerificationEngine,
    private readonly review: ReviewEngine,
    worktreesDir: string,
    private readonly artifactsDir: string,
  ) {
    this.git = new GitWorkspace(worktreesDir);
  }

  getForJob(jobId: string): CandidateApplication | null {
    const row = this.db
      .prepare('SELECT * FROM candidate_applications WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    return row ? rowToApplication(row) : null;
  }

  async approve(jobId: string): Promise<CandidateApplication> {
    const current = this.getForJob(jobId);
    if (current?.status === 'applied') return current;
    if (current?.status === 'applying' || current?.status === 'inspection_required') {
      throw new CandidateApplicationError(
        `application is ${current.status}; inspect it before another approval`,
        'application_in_progress_or_ambiguous',
      );
    }

    const evidence = await this.approvalEvidence(jobId);
    if (
      current?.status === 'approved' &&
      current.reviewId === evidence.reviewId &&
      current.verificationCycle === evidence.verificationCycle &&
      current.candidateHead === evidence.candidateHead
    ) {
      return current;
    }

    const now = nowIso();
    if (current) {
      this.db
        .prepare(
          `UPDATE candidate_applications SET status='approved', review_id=?, verification_cycle=?,
            candidate_base=?, candidate_head=?, target_root=NULL, target_branch=NULL,
            target_head_before=NULL, target_head_after=NULL, failure=NULL, approved_at=?,
            started_at=NULL, completed_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(
          evidence.reviewId,
          evidence.verificationCycle,
          evidence.candidateBase,
          evidence.candidateHead,
          now,
          now,
          current.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO candidate_applications (id, job_id, project_id, status, review_id,
            verification_cycle, candidate_base, candidate_head, method, approved_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          newId('app'),
          jobId,
          evidence.projectId,
          'approved',
          evidence.reviewId,
          evidence.verificationCycle,
          evidence.candidateBase,
          evidence.candidateHead,
          'ff-only',
          now,
          now,
        );
    }

    const application = this.getForJob(jobId);
    if (!application) throw new Error('approved application was not persisted');
    this.bus.emit({
      type: 'candidate.approved',
      jobId,
      payload: { applicationId: application.id, candidateHead: application.candidateHead },
    });
    return application;
  }

  async apply(jobId: string): Promise<CandidateApplication> {
    let application = this.getForJob(jobId);
    if (!application) {
      throw new CandidateApplicationError('candidate has not been approved', 'approval_required');
    }
    if (application.status === 'applied') {
      const job = this.jobs.get(jobId);
      if (job?.stage === 'awaiting_user') this.jobs.transition(jobId, 'completed');
      return application;
    }
    if (application.status === 'applying' || application.status === 'inspection_required') {
      throw new CandidateApplicationError(
        `application is ${application.status}; inspect it before retrying`,
        'application_in_progress_or_ambiguous',
      );
    }

    const evidence = await this.approvalEvidence(jobId);
    if (
      evidence.reviewId !== application.reviewId ||
      evidence.verificationCycle !== application.verificationCycle ||
      evidence.candidateBase !== application.candidateBase ||
      evidence.candidateHead !== application.candidateHead
    ) {
      throw new CandidateApplicationError(
        'approved evidence no longer matches the candidate',
        'approved_evidence_changed',
      );
    }

    const project = this.projects.get(application.projectId);
    const job = this.jobs.get(jobId);
    if (!project || !job?.worktreePath) {
      throw new CandidateApplicationError(
        'project or candidate worktree is unavailable',
        'candidate_missing',
      );
    }
    if (project.isSelf) {
      throw new CandidateApplicationError(
        'Jarvis candidates must be activated through the supervised self-upgrade path',
        'supervised_upgrade_required',
      );
    }
    const startedAt = nowIso();
    const claimed = this.db
      .prepare(
        `UPDATE candidate_applications SET status='applying', target_root=?, target_branch=NULL,
          target_head_before=NULL, target_head_after=NULL, failure=NULL, started_at=?, updated_at=?
         WHERE id=? AND status IN ('approved','failed')`,
      )
      .run(project.rootPath, startedAt, startedAt, application.id);
    if (Number(claimed.changes) !== 1) {
      application = this.getForJob(jobId);
      if (application?.status === 'applied') return application;
      throw new CandidateApplicationError(
        'application is already being processed',
        'application_busy',
      );
    }
    this.bus.emit({
      type: 'candidate.apply.started',
      jobId,
      payload: {
        applicationId: application.id,
        candidateHead: application.candidateHead,
      },
    });

    let preflight: Awaited<ReturnType<GitWorkspace['preflightFastForward']>> | null = null;
    let applied: Awaited<ReturnType<GitWorkspace['fastForward']>>;
    try {
      preflight = await this.git.preflightFastForward({
        targetRoot: project.rootPath,
        worktreePath: job.worktreePath,
        baseRef: application.candidateBase,
        expectedHead: application.candidateHead,
      });
      this.db
        .prepare(
          `UPDATE candidate_applications SET target_root=?, target_branch=?, target_head_before=?,
            updated_at=? WHERE id=? AND status='applying'`,
        )
        .run(
          preflight.targetRoot,
          preflight.targetBranch,
          preflight.targetHead,
          nowIso(),
          application.id,
        );
      applied = await this.git.fastForward({
        targetRoot: project.rootPath,
        worktreePath: job.worktreePath,
        baseRef: application.candidateBase,
        expectedHead: application.candidateHead,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const target = await repoStatus(project.rootPath).catch(() => null);
      const unchanged =
        preflight === null || (target?.head === preflight.targetHead && target.dirty === false);
      const status: CandidateApplicationStatus = unchanged ? 'failed' : 'inspection_required';
      const failedAt = nowIso();
      this.db
        .prepare(
          `UPDATE candidate_applications SET status=?, target_head_after=?, failure=?, updated_at=?
           WHERE id=? AND status='applying'`,
        )
        .run(status, target?.head ?? null, message, failedAt, application.id);
      this.bus.emit({
        type: 'candidate.apply.failed',
        jobId,
        payload: { applicationId: application.id, status, error: message },
      });
      throw new CandidateApplicationError(message, status === 'failed' ? 'apply_failed' : status);
    }

    const completedAt = nowIso();
    const persisted = this.db
      .prepare(
        `UPDATE candidate_applications SET status='applied', target_head_after=?, failure=NULL,
          completed_at=?, updated_at=? WHERE id=? AND status='applying'`,
      )
      .run(applied.targetHeadAfter, completedAt, completedAt, application.id);
    if (Number(persisted.changes) !== 1) {
      throw new CandidateApplicationError(
        'candidate was applied but its transaction state could not be finalized',
        'inspection_required',
      );
    }
    if (job.stage === 'awaiting_user') this.jobs.transition(jobId, 'completed');
    this.bus.emit({
      type: 'candidate.apply.completed',
      jobId,
      payload: {
        applicationId: application.id,
        method: 'ff-only',
        targetHeadBefore: preflight.targetHead,
        targetHeadAfter: applied.targetHeadAfter,
      },
    });
    const completed = this.getForJob(jobId);
    if (!completed) throw new Error('applied application was not persisted');
    return completed;
  }

  /** A crash during Git mutation is never guessed safe on restart. */
  recoverInterrupted(): number {
    const rows = this.db
      .prepare("SELECT id, job_id FROM candidate_applications WHERE status = 'applying'")
      .all() as Array<{ id: string; job_id: string }>;
    const now = nowIso();
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE candidate_applications SET status='inspection_required', failure=?, updated_at=?
           WHERE id=? AND status='applying'`,
        )
        .run(
          'Jarvis restarted during candidate application; inspect target HEAD before recovery.',
          now,
          row.id,
        );
      this.bus.emit({
        type: 'candidate.apply.failed',
        jobId: row.job_id,
        payload: { applicationId: row.id, status: 'inspection_required', reason: 'restart' },
      });
    }
    return rows.length;
  }

  /**
   * The persisted plan, read raw so a malformed value fails closed instead of
   * decaying into "no plan" and re-demanding broad project defaults.
   */
  private persistedVisualPlan(jobId: string): VisualQaPlan | null {
    const row = this.db.prepare('SELECT visual_qa_plan FROM jobs WHERE id=?').get(jobId) as
      { visual_qa_plan: string | null } | undefined;
    const raw = row?.visual_qa_plan;
    if (!raw) return null;
    const invalid = () =>
      new CandidateApplicationError('persisted visual QA plan is malformed', 'visual_plan_invalid');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    const plan = parsed as VisualQaPlan;
    if (
      !plan ||
      typeof plan !== 'object' ||
      !Array.isArray(plan.scenarios) ||
      plan.scenarios.length === 0 ||
      (plan.required !== undefined && typeof plan.required !== 'boolean') ||
      !plan.scenarios.every(
        (scenario) =>
          !!scenario &&
          typeof scenario.name === 'string' &&
          typeof scenario.route === 'string' &&
          (scenario.viewports === undefined ||
            (Array.isArray(scenario.viewports) &&
              scenario.viewports.length > 0 &&
              scenario.viewports.every((v) => v === 'desktop' || v === 'mobile'))),
      )
    ) {
      throw invalid();
    }
    return plan;
  }

  private async approvalEvidence(jobId: string): Promise<{
    projectId: string;
    reviewId: string;
    verificationCycle: number;
    candidateBase: string;
    candidateHead: string;
  }> {
    const job = this.jobs.get(jobId);
    if (!job) throw new CandidateApplicationError('job not found', 'job_not_found');
    if (job.stage !== 'awaiting_user') {
      throw new CandidateApplicationError(
        `job is ${job.stage}, not awaiting_user`,
        'job_not_eligible',
      );
    }
    const report = this.verification.latestReport(jobId);
    const latestReview = this.review.list(jobId).at(-1);
    const rejection = candidateRejectionReason(report, latestReview?.verdict ?? 'error');
    if (rejection) throw new CandidateApplicationError(rejection, 'evidence_rejected');
    if (
      !latestReview ||
      !job.worktreePath ||
      !job.baseRef ||
      !job.headRef ||
      !fs.existsSync(job.worktreePath)
    ) {
      throw new CandidateApplicationError(
        'candidate worktree or reviewed identity is unavailable',
        'candidate_missing',
      );
    }
    if (
      latestReview.headRef !== job.headRef ||
      latestReview.blocking ||
      job.reviewedHead !== job.headRef
    ) {
      throw new CandidateApplicationError(
        'code review identity is stale or still blocking',
        'review_identity_mismatch',
      );
    }
    await this.git.validateCandidate(job.worktreePath, job.baseRef, job.headRef);
    const project = this.projects.get(job.projectId);
    const plan = this.persistedVisualPlan(jobId);
    const visualRequired =
      plan?.required ?? job.visualQaConfig?.required ?? project?.config.visualQa?.required;
    if (visualRequired || job.visualHead) {
      if (job.visualHead !== job.headRef) {
        throw new CandidateApplicationError(
          'visual evidence identity is stale',
          'visual_identity_mismatch',
        );
      }
      const rows = this.db
        .prepare(
          `SELECT id,scenario_name,route,viewport,screenshot_path,status,reviewed_by,review_findings FROM visual_qa
           WHERE job_id=? AND head_ref=? ORDER BY created_at DESC, rowid DESC`,
        )
        .all(jobId, job.headRef) as Array<{
        id: string;
        scenario_name: string;
        route: string;
        viewport: string;
        screenshot_path: string | null;
        status: string;
        reviewed_by: string | null;
        review_findings: string | null;
      }>;
      // The plan the pipeline resolved is the evidence contract: it is what was
      // captured and reviewed. Reconstructing scenarios here would demand
      // evidence nobody was ever asked to produce. Legacy pre-plan jobs only.
      const projectVisual = project?.config.visualQa;
      const configuredScenarios = job.visualQaConfig?.scenarios ?? projectVisual?.scenarios;
      const scenarios: VisualQaScenario[] = plan
        ? plan.scenarios
        : configuredScenarios?.length
          ? configuredScenarios
          : (projectVisual?.routes?.length
              ? projectVisual.routes
              : (project?.stack.webRoutes ?? ['/'])
            ).map((route) => ({ name: route === '/' ? 'default' : route, route }));
      const selected = scenarios.flatMap((scenario) =>
        (scenario.viewports ?? ['desktop', 'mobile']).flatMap((viewport) => {
          const row = rows.find(
            (candidate) =>
              candidate.scenario_name === scenario.name &&
              candidate.route === scenario.route &&
              candidate.viewport === viewport,
          );
          return row ? [row] : [];
        }),
      );
      const expectedCount = scenarios.reduce(
        (count, scenario) => count + (scenario.viewports ?? ['desktop', 'mobile']).length,
        0,
      );
      let passed =
        selected.length === expectedCount &&
        selected.every(
          (row) =>
            row.status === 'captured' &&
            !!row.reviewed_by &&
            !!row.review_findings &&
            validateVisualEvidence(row.screenshot_path, this.artifactsDir),
        );
      const persistedReviews = new Set(selected.map((row) => row.review_findings));
      if (passed && persistedReviews.size === 1) {
        try {
          const parsed = parseVisualReview(
            JSON.parse(selected[0]?.review_findings ?? ''),
            selected.map((row) => ({
              id: row.id,
              scenarioName: row.scenario_name,
              route: row.route,
              viewport: row.viewport as 'desktop' | 'mobile',
              status: 'captured' as const,
              screenshotPath: row.screenshot_path,
            })),
          );
          passed = parsed.verdict === 'pass';
        } catch {
          passed = false;
        }
      } else {
        passed = false;
      }
      if (!passed) {
        throw new CandidateApplicationError(
          'required visual review is missing, failed, or contains blocking findings',
          'visual_review_rejected',
        );
      }
    }
    const verificationCycle = report.results.reduce(
      (latest, result) => Math.max(latest, result.cycle),
      -1,
    );
    return {
      projectId: job.projectId,
      reviewId: latestReview.id,
      verificationCycle,
      candidateBase: job.baseRef,
      candidateHead: job.headRef,
    };
  }
}

function rowToApplication(row: Row): CandidateApplication {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    projectId: row.project_id as string,
    status: row.status as CandidateApplicationStatus,
    reviewId: row.review_id as string,
    verificationCycle: Number(row.verification_cycle),
    candidateBase: row.candidate_base as string,
    candidateHead: row.candidate_head as string,
    targetRoot: (row.target_root as string) ?? null,
    targetBranch: (row.target_branch as string) ?? null,
    targetHeadBefore: (row.target_head_before as string) ?? null,
    targetHeadAfter: (row.target_head_after as string) ?? null,
    method: 'ff-only',
    failure: (row.failure as string) ?? null,
    approvedAt: row.approved_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    updatedAt: row.updated_at as string,
  };
}
