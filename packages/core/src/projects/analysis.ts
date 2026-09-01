import path from 'node:path';
import { z } from 'zod';
import type { JarvisConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import { classifyAgentFailure, describeAgentFailure } from '../agents/registry.js';
import { parseStructured } from '../agents/structured.js';
import type { MemoryService } from '../memory/service.js';
import { GitWorkspace, repoStatus } from '../git/workspace.js';
import { createLogger } from '../logger.js';
import { newId, nowIso } from '../ids.js';
import type { Project, ProjectService } from './service.js';
import {
  PROJECT_PROFILE_VERSION,
  ProjectProfileResultSchema,
  isSubstantiveProfile,
  type ProjectProfile,
} from './profile.js';

const log = createLogger('project-analysis');

export interface ProjectAnalysisDeps {
  config: JarvisConfig;
  bus: EventBus;
  agents: AgentRegistry;
  projects: ProjectService;
  memory: MemoryService;
}

export type ProjectAnalysisOutcome =
  | { status: 'analyzed'; project: Project; profile: ProjectProfile; memories: number }
  | { status: 'failed'; project: Project | null; error: string }
  | { status: 'cancelled'; project: Project | null };

/**
 * Reconnaissance on a registered repository.
 *
 * Deliberately NOT a Job. A Job means a worktree that gets edited, verification,
 * code review, visual QA and an application transaction — an entire pipeline
 * whose whole purpose is to change source safely. Analysis changes nothing, so
 * paying that price would be theatre: it is one bounded read-only agent run
 * that returns a structured description and stops.
 *
 * Four properties are load-bearing:
 *
 * - It reads a DISPOSABLE worktree pinned to the project's committed HEAD, not
 *   the user's checkout. Uncommitted work is never seen and never at risk, and
 *   the commit that was read is recorded so staleness is a fact rather than a
 *   guess.
 * - The agent runs read-only (see `buildClaudeArgs`): no Bash, no Edit, no
 *   commit, no push.
 * - Its output is parsed against a bounded schema and nothing outside that
 *   schema is persisted. In particular no model-produced string ever becomes a
 *   `Project.commands` entry: describing a build workflow is not authority to
 *   run one.
 * - Failure is inert. The previous profile survives, the project stays fully
 *   usable, and the error is shown with a retry.
 */
export class ProjectAnalysisService {
  /** One analysis per project, so a double click cannot spend quota twice. */
  private readonly running = new Map<string, AbortController>();
  private readonly git: GitWorkspace;

  constructor(private readonly deps: ProjectAnalysisDeps) {
    this.git = new GitWorkspace(deps.config.worktreesDir);
  }

  /**
   * Clear analysis state left behind by a process that died mid-run.
   *
   * The in-memory `running` claim vanishes on restart, but the persisted
   * `queued`/`running` state does not, and nothing else would ever move it: the
   * card would show "analysing" forever with the button disabled, Stop would
   * report that no analysis is running, and the project registry would tell
   * every conversation "analysis: running" indefinitely. The disposable worktree
   * and branch are named by the persisted `runId`, so they can be disposed of
   * exactly rather than by wildcard.
   *
   * Idempotent, and safe to run on every boot.
   */
  async recoverInterrupted(): Promise<number> {
    const stranded = this.deps.projects
      .list()
      .filter(
        (project) =>
          project.analysis?.status === 'running' || project.analysis?.status === 'queued',
      );
    for (const project of stranded) {
      const runId = project.analysis?.runId;
      this.deps.projects.setAnalysisState(project.id, {
        status: 'failed',
        startedAt: project.analysis?.startedAt ?? nowIso(),
        finishedAt: nowIso(),
        error: 'the analysis was interrupted by a restart; run it again when you want to',
        ...(runId ? { runId } : {}),
      });
      if (runId) {
        await this.git
          .removeWorktree(project.rootPath, path.join(this.deps.config.worktreesDir, runId), {
            deleteBranch: `jarvis-analysis/${runId}`,
          })
          .catch(() => undefined);
      }
    }
    if (stranded.length) {
      log.warn('project analyses were interrupted by a restart', { projects: stranded.length });
    }
    return stranded.length;
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  cancel(projectId: string): boolean {
    const controller = this.running.get(projectId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Fire-and-forget entry point for the tool boundary and the UI.
   *
   * An analysis takes as long as a provider takes, which is far longer than an
   * HTTP request should. The run state on the project row is the progress
   * report; the caller gets an immediate answer and watches events.
   */
  start(projectId: string, executionId?: string): boolean {
    if (this.running.has(projectId)) return false;
    this.deps.projects.setAnalysisState(projectId, { status: 'queued', startedAt: nowIso() });
    void this.analyze(projectId, executionId).catch((error: unknown) => {
      log.warn('project analysis crashed', { projectId, error: String(error) });
    });
    return true;
  }

  async analyze(projectId: string, executionId?: string): Promise<ProjectAnalysisOutcome> {
    const { projects, bus } = this.deps;
    const project = projects.get(projectId);
    if (!project) return { status: 'failed', project: null, error: 'project not found' };
    // Claimed synchronously, before the first await: two clicks a millisecond
    // apart must not both reach a provider.
    if (this.running.has(projectId)) {
      return { status: 'failed', project, error: 'an analysis is already running' };
    }
    const controller = new AbortController();
    this.running.set(projectId, controller);
    const runId = newId('panalysis');
    let worktree: { path: string; branch: string } | null = null;

    try {
      const status = await repoStatus(project.rootPath).catch(() => null);
      if (!status?.isRepo || !status.head) {
        return this.fail(
          project,
          status?.isRepo
            ? 'the repository has no commits yet, so there is nothing to analyse'
            : `${project.rootPath} is not a git repository`,
          undefined,
          undefined,
          executionId,
        );
      }
      const commit = status.head;

      // `runId` is persisted so a restart sweep can name the exact worktree and
      // branch it has to clean up, rather than guessing at a wildcard.
      projects.setAnalysisState(projectId, {
        status: 'running',
        startedAt: nowIso(),
        runId,
        ...(executionId ? { executionId } : {}),
      });
      bus.emit({
        type: 'project.analysis.started',
        runId,
        payload: { projectId, commit, ...(executionId ? { executionId } : {}) },
      });

      const routed = await this.deps.agents.route('project_analyst', {
        taskProfile: { modelProfile: 'balanced' },
      });
      if (!routed.provider) {
        return this.fail(
          project,
          `no analysis provider is available: ${routed.reason}`,
          undefined,
          undefined,
          executionId,
        );
      }

      // A throwaway worktree at the exact commit: the user's checkout — dirty or
      // not — is never handed to an agent, and nothing here is ever committed.
      worktree = await this.git.createWorktree({
        repoRoot: project.rootPath,
        jobId: runId,
        branchPrefix: 'jarvis-analysis',
        baseRef: commit,
      });

      const result = await routed.provider.run(
        {
          cwd: worktree.path,
          prompt: buildAnalystPrompt(project),
          role: 'project_analyst',
          ...(routed.decision.model ? { model: routed.decision.model } : {}),
          ephemeral: true,
          safeMode: true,
          timeoutMs: this.deps.config.agents.runTimeoutMs,
          signal: controller.signal,
        },
        () => {
          /* Analysis has no live surface: only the final structured answer counts. */
        },
      );
      this.deps.agents.recordResult(routed.provider.id, result);

      if (controller.signal.aborted || result.status === 'cancelled') {
        projects.setAnalysisState(projectId, null);
        return { status: 'cancelled', project: projects.get(projectId) };
      }
      if (result.status !== 'completed') {
        return this.fail(
          project,
          describeAgentFailure(classifyAgentFailure(result), result.error),
          routed.provider.id,
          routed.decision.model ?? undefined,
          executionId,
        );
      }

      const parsed = parseAnalystResult(result.result);
      if (!parsed || !isSubstantiveProfile(parsed)) {
        return this.fail(
          project,
          'the analysis agent did not return a usable structured result',
          routed.provider.id,
          routed.decision.model ?? undefined,
          executionId,
        );
      }

      const profile: ProjectProfile = {
        ...parsed,
        version: PROJECT_PROFILE_VERSION,
        analyzedAt: nowIso(),
        analyzedCommit: commit,
        provider: routed.provider.id,
        model: routed.decision.model ?? null,
        memoryIds: [],
      };
      profile.memoryIds = await this.recordMemories(project, profile, runId);
      const updated = projects.setProfile(projectId, profile);
      bus.emit({
        type: 'project.analysis.completed',
        runId,
        payload: {
          projectId,
          commit,
          memories: profile.memoryIds.length,
          ...(executionId ? { executionId } : {}),
        },
      });
      log.info('project analysed', { projectId, commit, memories: profile.memoryIds.length });
      return {
        status: 'analyzed',
        project: updated ?? project,
        profile,
        memories: profile.memoryIds.length,
      };
    } catch (error) {
      return this.fail(
        project,
        error instanceof Error ? error.message : String(error),
        undefined,
        undefined,
        executionId,
      );
    } finally {
      this.running.delete(projectId);
      if (worktree) {
        await this.git
          .removeWorktree(project.rootPath, worktree.path, { deleteBranch: worktree.branch })
          .catch((reason: unknown) => {
            log.warn('could not dispose analysis worktree', { projectId, error: String(reason) });
          });
      }
    }
  }

  private fail(
    project: Project,
    error: string,
    provider?: string,
    model?: string,
    executionId?: string,
  ): ProjectAnalysisOutcome {
    // The previous profile is untouched on purpose: a failed re-analysis must
    // leave the project exactly as usable as it was a minute earlier.
    this.deps.projects.setAnalysisState(project.id, {
      status: 'failed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      error: error.slice(0, 600),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    });
    // The terminal outcome is emitted against the tool execution that started
    // it, so the audit trail can answer "what did this analysis actually do"
    // even though the tool itself returned as soon as the run was claimed.
    this.deps.bus.emit({
      type: 'project.analysis.failed',
      payload: {
        projectId: project.id,
        error: error.slice(0, 600),
        ...(executionId ? { executionId } : {}),
      },
    });
    return { status: 'failed', project: this.deps.projects.get(project.id), error };
  }

  /**
   * Turn the analysis into a small number of durable project memories.
   *
   * Not a second copy of the profile — the profile is already stored and
   * already injected. This is the one-line version a person would actually
   * repeat, and a re-analysis supersedes the previous ones rather than adding
   * to a growing pile of near-duplicates.
   */
  private async recordMemories(
    project: Project,
    profile: ProjectProfile,
    runId: string,
  ): Promise<string[]> {
    // Each slot gets a STABLE, DISTINCT subject. Distinct, so the three facts
    // from one run do not supersede each other on the way in; stable, so the
    // next run's "purpose" replaces the previous run's "purpose" through
    // MemoryService's own subject supersession rather than through bookkeeping
    // here that could drift out of step with what was actually stored.
    const candidates: { subject: string; content: string }[] = [
      {
        subject: 'project analysis: purpose',
        content: profile.purpose ? `${project.name} is ${lowerFirst(profile.purpose)}` : '',
      },
      ...profile.memorable.map((content, index) => ({
        subject: `project analysis: note ${index + 1}`,
        content,
      })),
    ]
      .map((candidate) => ({ ...candidate, content: candidate.content.trim() }))
      .filter((candidate) => candidate.content)
      .slice(0, 3);

    const ids: string[] = [];
    for (const candidate of candidates) {
      const outcome = await this.deps.memory.remember({
        scope: 'project',
        scopeId: project.id,
        kind: 'project_knowledge',
        subject: candidate.subject,
        content: candidate.content,
        sourceType: 'project_analysis',
        sourceRef: { runId, note: `analysis of ${profile.analyzedCommit.slice(0, 12)}` },
        importance: 0.7,
        confidence: 0.7,
      });
      if (outcome.status === 'stored' || outcome.status === 'duplicate') {
        ids.push(outcome.memory.id);
      }
    }
    return ids;
  }
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** The analyst's bounded structured answer, or nothing. */
export function parseAnalystResult(raw: string): z.infer<typeof ProjectProfileResultSchema> | null {
  return parseStructured(raw, ProjectProfileResultSchema);
}

function buildAnalystPrompt(project: Project): string {
  return `You are inspecting a local git repository so that a colleague who has never seen it
can orient quickly. This is a READ-ONLY reconnaissance pass: you have file reading
and search tools only, and you must not attempt to change, run or install anything.

Repository: ${project.name}
Working directory: a disposable worktree pinned to the project's current commit.

Read enough to be accurate — manifests, the directory layout, entry points, the
test setup, CI configuration, and any repository guidance file such as README or
CLAUDE.md — then answer with ONE JSON object and nothing else.

Shape (every field is required; use "" or [] when something genuinely does not
apply, and never invent):

{
  "purpose": "one or two sentences on what this project is for",
  "architecture": "how it is put together: the major pieces and how they relate",
  "languages": ["typescript"],
  "frameworks": ["react"],
  "modules": [{"name": "core", "path": "packages/core", "purpose": "domain logic"}],
  "entrypoints": ["apps/web/src/main.tsx"],
  "importantPaths": ["packages/core/src/db"],
  "testStrategy": "what kinds of tests exist and how they are organised",
  "buildWorkflow": "how a developer builds and runs this day to day",
  "deploymentNotes": "how it ships or runs in production, if that is knowable",
  "conventions": ["patterns a newcomer must follow"],
  "integrations": ["external services or APIs this talks to"],
  "dataStores": ["databases, caches, queues, file stores"],
  "risks": ["gotchas that would bite someone changing this"],
  "inspectFirst": ["files worth reading before any change"],
  "memorable": ["at most three short facts worth remembering permanently"]
}

Rules:
- Describe commands in prose. Do NOT expect anything you write to be executed:
  Jarvis takes its build and test commands from its own detection, never from you.
- Never include a secret, token, password or connection string, even one you find
  in the repository. Say that credentials exist and where, not what they are.
- Keep every string short. Long is not better; a colleague has to read this.
- Output the JSON object alone, with no commentary before or after it.`;
}
