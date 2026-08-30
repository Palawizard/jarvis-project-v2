import fs from 'node:fs';
import path from 'node:path';
import type { JarvisConfig } from '../config.js';
import { GitWorkspace, repoStatus } from '../git/workspace.js';
import type { ProjectService } from '../projects/service.js';
import type { JobPipeline } from './pipeline.js';
import type { Job, JobService, JobTombstone } from './service.js';

/**
 * Why a paused Job can no longer be resumed against its target.
 *
 * A paused candidate is only meaningful relative to the base it branched from.
 * Once the target has moved past that base — which is exactly what happens after
 * Jarvis self-updates — resuming would run old reviewed work against a
 * repository it has never seen.
 */
export interface StaleJobReport {
  stale: boolean;
  reason: string;
  jobBase: string | null;
  targetHead: string | null;
  detail: string;
}

export interface JobDeletionPlan {
  eligible: boolean;
  reason: string;
  removes: string[];
  preserves: string[];
}

/**
 * Destructive Job operations that touch the filesystem as well as the database.
 *
 * Kept out of JobService on purpose: JobService is pure persistence, and the
 * order here matters — cancel, then release the worktree, then drop rows, so a
 * failure part-way leaves a Job that still describes its own leftovers.
 */
export class JobLifecycle {
  private readonly git: GitWorkspace;

  constructor(
    private readonly deps: {
      jobs: JobService;
      projects: ProjectService;
      pipeline: JobPipeline;
      config: JarvisConfig;
    },
  ) {
    this.git = new GitWorkspace(deps.config.worktreesDir);
  }

  deletionPlan(jobId: string): JobDeletionPlan {
    return this.deps.jobs.deleteEligibility(jobId);
  }

  /**
   * Abandon a candidate and erase its disposable state.
   *
   * Refuses outright for anything that was applied or self-upgraded: that
   * evidence is immutable and Archive is the only offer.
   */
  async delete(jobId: string, reason = 'deleted by the user'): Promise<JobTombstone> {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new Error('job not found');
    const plan = this.deletionPlan(jobId);
    if (!plan.eligible) throw new Error(plan.reason);
    if (this.deps.pipeline.isRunning(jobId)) {
      throw new Error('job is still running in this process; cancel it first');
    }

    await this.releaseWorkspace(job);
    this.removeArtifacts(jobId);
    const tombstone = this.deps.jobs.hardDelete(jobId, reason);
    if (!tombstone) throw new Error('job disappeared during deletion');
    return tombstone;
  }

  /** Remove the candidate worktree and branch. Never touches the user's checkout. */
  private async releaseWorkspace(job: Job): Promise<void> {
    if (!job.worktreePath) return;
    const project = this.deps.projects.get(job.projectId);
    if (!project) throw new Error('cannot safely release the worktree: project is missing');
    // Containment: only ever a path Jarvis itself created under worktreesDir.
    const root = path.resolve(this.deps.config.worktreesDir);
    const target = path.resolve(job.worktreePath);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('refusing to remove a worktree outside the Jarvis worktrees directory');
    }
    await this.git.removeWorktree(project.rootPath, job.worktreePath, {
      ...(job.branch ? { deleteBranch: job.branch } : {}),
    });
    if (fs.existsSync(target)) throw new Error('Git did not remove the candidate worktree');
  }

  private removeArtifacts(jobId: string): void {
    const dir = path.join(this.deps.config.artifactsDir, jobId);
    const root = path.resolve(this.deps.config.artifactsDir);
    const target = path.resolve(dir);
    if (!target.startsWith(root + path.sep)) return;
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }

  /**
   * Does resuming this paused Job still make sense?
   *
   * Checks the project, its repository and the base/HEAD relationship. Read-only
   * and side-effect free, so the UI can call it just to explain the situation.
   */
  async staleness(jobId: string): Promise<StaleJobReport> {
    const job = this.deps.jobs.get(jobId);
    if (!job) {
      return {
        stale: true,
        reason: 'job_missing',
        jobBase: null,
        targetHead: null,
        detail: 'job not found',
      };
    }
    const project = this.deps.projects.get(job.projectId);
    if (!project) {
      return {
        stale: true,
        reason: 'project_missing',
        jobBase: job.baseRef,
        targetHead: null,
        detail: 'the project this Job targets is no longer registered',
      };
    }
    if (!fs.existsSync(project.rootPath)) {
      return {
        stale: true,
        reason: 'repository_missing',
        jobBase: job.baseRef,
        targetHead: null,
        detail: `${project.rootPath} no longer exists on disk`,
      };
    }
    const status = await repoStatus(project.rootPath);
    const targetHead = status.head ?? null;
    if (!job.baseRef) {
      return {
        stale: true,
        reason: 'no_checkpoint',
        jobBase: null,
        targetHead,
        detail: 'this paused Job has no recoverable worktree checkpoint',
      };
    }
    if (!job.worktreePath || !fs.existsSync(job.worktreePath)) {
      return {
        stale: true,
        reason: 'worktree_missing',
        jobBase: job.baseRef,
        targetHead,
        detail: 'the candidate worktree for this Job is gone.',
      };
    }
    if (targetHead && targetHead !== job.baseRef) {
      return {
        stale: true,
        reason: 'base_advanced',
        jobBase: job.baseRef,
        targetHead,
        detail:
          `This Job was based on ${job.baseRef.slice(0, 8)}. ` +
          `The target is now ${targetHead.slice(0, 8)}.`,
      };
    }
    return {
      stale: false,
      reason: 'current',
      jobBase: job.baseRef,
      targetHead,
      detail: 'the candidate is still based on the target head',
    };
  }
}
