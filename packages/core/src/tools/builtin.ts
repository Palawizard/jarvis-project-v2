import { z } from 'zod';
import { ToolRegistry, type ToolRegistryOptions } from './registry.js';
import type { MemoryService } from '../memory/service.js';
import type { ProjectService } from '../projects/service.js';
import type { ProjectAnalysisService } from '../projects/analysis.js';
import type { JobService } from '../jobs/service.js';
import { StoredJobBriefSchema } from '../jobs/brief.js';
import type { JobLifecycle } from '../jobs/lifecycle.js';
import type { JobPipeline } from '../jobs/pipeline.js';
import type { SessionService } from '../sessions/service.js';
import type { MemoryKind, MemoryScope } from '../memory/types.js';

const SCOPES = ['user', 'project', 'session', 'procedure'] as const;
const KINDS = [
  'preference',
  'fact',
  'constraint',
  'decision',
  'project_knowledge',
  'episode',
  'procedure',
  'unresolved',
  'correction',
  'other',
] as const;

export interface BuiltinToolDeps {
  memory: MemoryService;
  projects: ProjectService;
  projectAnalysis: ProjectAnalysisService;
  jobs: JobService;
  sessions: SessionService;
  pipeline: JobPipeline;
  lifecycle: JobLifecycle;
}

/**
 * Every capability Jarvis can exercise, from a button or from a sentence.
 *
 * There is deliberately no second implementation for natural language: the chat
 * dispatcher and the HTTP routes call the same tools, so a management operation
 * gets the same policy evaluation, the same audit row and the same confirmation
 * requirement whichever way it was asked for. The only thing a new tool has to
 * get right is its `risk` — policy.ts does the rest.
 */
export function registerBuiltinTools(
  deps: BuiltinToolDeps,
  options: ToolRegistryOptions,
): ToolRegistry {
  const registry = new ToolRegistry(options);

  // ------------------------------------------------------------------ memory --

  registry.register({
    name: 'memory.search',
    revision: '1',
    description: 'Search Jarvis memory. Local-only: never makes a model or network call.',
    risk: 'observe',
    input: z.object({
      query: z.string().min(1),
      projectId: z.string().nullish(),
      kinds: z.array(z.enum(KINDS)).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    async execute(input) {
      const scopes: { scope: MemoryScope; scopeId: string | null }[] = [
        { scope: 'user', scopeId: null },
      ];
      if (input.projectId) scopes.push({ scope: 'project', scopeId: input.projectId });
      const results = await deps.memory.retrieve({
        query: input.query,
        scopes,
        ...(input.kinds ? { kinds: input.kinds as MemoryKind[] } : {}),
        limit: input.limit,
      });
      return results.map((r) => ({
        id: r.memory.id,
        scope: r.memory.scope,
        kind: r.memory.kind,
        subject: r.memory.subject,
        content: r.memory.content,
        score: Number(r.score.toFixed(4)),
        reason: r.reason,
      }));
    },
  });

  registry.register({
    name: 'memory.store',
    revision: '1',
    description:
      'Store a durable memory. Runs the full write policy (secrets, dedupe, supersession).',
    risk: 'reversible_modification',
    input: z.object({
      scope: z.enum(SCOPES),
      scopeId: z.string().nullish(),
      kind: z.enum(KINDS),
      subject: z.string().max(120).nullish(),
      content: z.string().min(1),
      importance: z.number().min(0).max(1).optional(),
      explicit: z.boolean().default(false),
    }),
    async execute(input, ctx) {
      return deps.memory.remember({
        scope: input.scope as MemoryScope,
        scopeId: input.scopeId ?? (input.scope === 'project' ? ctx.projectId : null),
        kind: input.kind as MemoryKind,
        subject: input.subject ?? null,
        content: input.content,
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        sourceType: input.explicit ? 'user_explicit' : 'system',
        sourceRef: {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
        },
        explicit: input.explicit,
      });
    },
  });

  registry.register({
    name: 'memory.forget',
    revision: '1',
    description: 'Soft-delete a memory. It stops being retrievable but stays auditable.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string() }),
    async execute(input) {
      return { forgotten: deps.memory.forget(input.id) };
    },
  });

  registry.register({
    name: 'memory.purge',
    revision: '1',
    description:
      'Permanently erase a memory and its embedding. There is no undo and no audit copy of the content.',
    risk: 'destructive',
    input: z.object({ id: z.string() }),
    async execute(input) {
      return { purged: deps.memory.purge(input.id) };
    },
  });

  registry.register({
    name: 'memory.purge_project',
    revision: '1',
    description: 'Permanently erase every Jarvis memory belonging to one existing project.',
    risk: 'destructive',
    input: z.object({
      projectId: z
        .string()
        .min(1)
        .refine((id) => deps.projects.get(id) !== null, 'project not found'),
    }),
    async execute(input) {
      return { purged: deps.memory.purgeScope('project', input.projectId) };
    },
  });

  registry.register({
    name: 'memory.update',
    revision: '1',
    description: 'Correct a memory: stores the new value and supersedes the old one.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), content: z.string().min(1) }),
    async execute(input, ctx) {
      return deps.memory.correct(input.id, input.content, {
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      });
    },
  });

  // ---------------------------------------------------------------- projects --

  registry.register({
    name: 'project.list',
    revision: '2',
    description: 'List projects Jarvis knows about.',
    risk: 'observe',
    input: z.object({
      status: z.enum(['active', 'archived', 'all']).default('active'),
      search: z.string().max(120).optional(),
    }),
    async execute(input) {
      return deps.projects
        .list({ status: input.status, ...(input.search ? { search: input.search } : {}) })
        .map((p) => ({
          id: p.id,
          name: p.name,
          aliases: p.aliases,
          rootPath: p.rootPath,
          isSelf: p.isSelf,
          archived: Boolean(p.archivedAt),
          stack: p.stack,
        }));
    },
  });

  registry.register({
    name: 'project.inspect',
    revision: '1',
    description: 'Full detail for one project, including detected commands.',
    risk: 'observe',
    input: z.object({ id: z.string() }),
    async execute(input) {
      return deps.projects.get(input.id);
    },
  });

  registry.register({
    name: 'project.update',
    revision: '1',
    description: 'Change a project’s display name, aliases, dev URL or summary.',
    risk: 'reversible_modification',
    input: z
      .object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
        devUrl: z.string().max(300).nullish(),
        summary: z.string().max(2000).nullish(),
      })
      .strict(),
    async execute(input) {
      const patch: Parameters<ProjectService['update']>[1] = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.aliases !== undefined) patch.aliases = input.aliases;
      if (input.devUrl !== undefined) patch.devUrl = input.devUrl ?? null;
      if (input.summary !== undefined) patch.summary = input.summary ?? null;
      const updated = deps.projects.update(input.id, patch);
      if (!updated) throw new Error('project not found');
      return updated;
    },
  });

  registry.register({
    name: 'project.archive',
    revision: '1',
    description:
      'Hide a project from active views and resolution. Jobs, history and memory are kept.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), archived: z.boolean().default(true) }).strict(),
    async execute(input) {
      const updated = deps.projects.setArchived(input.id, input.archived);
      if (!updated) throw new Error('project not found');
      return updated;
    },
  });

  registry.register({
    name: 'project.redetect',
    revision: '1',
    description: 'Re-run stack and command detection against the current filesystem.',
    risk: 'safe_action',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      const updated = deps.projects.refreshDetection(input.id);
      if (!updated) throw new Error('project not found');
      return updated;
    },
  });

  registry.register({
    name: 'project.analyze',
    revision: '1',
    description:
      'Start a bounded read-only agent analysis of a registered project. It reads a disposable ' +
      'worktree pinned to the project’s committed HEAD, never the working checkout, and it ' +
      'never edits, commits or runs anything. Spends provider quota.',
    // Not `safe_action`: this spends provider quota and creates a real (if
    // disposable) worktree and branch inside the user's repository, which is
    // exactly why `job.create` sits here too. Nothing routes an agent to it
    // today, and this is what would make that fail closed if anything ever did.
    risk: 'reversible_modification',
    input: z.object({ id: z.string() }).strict(),
    async execute(input, ctx) {
      const project = deps.projects.get(input.id);
      if (!project) throw new Error('project not found');
      // Returns as soon as the run is claimed: an analysis outlives any HTTP
      // request, and the project row carries its status for whoever is watching.
      // The execution id travels with the run so its terminal outcome is
      // attributable, since this row necessarily settles before the work does.
      if (!deps.projectAnalysis.start(project.id, ctx.executionId)) {
        throw new Error('an analysis is already running for this project');
      }
      return deps.projects.get(project.id) ?? project;
    },
  });

  registry.register({
    name: 'project.analyze.cancel',
    revision: '1',
    description: 'Stop an in-flight project analysis. The previous profile is left untouched.',
    risk: 'safe_action',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      const cancelled = deps.projectAnalysis.cancel(input.id);
      if (!cancelled) throw new Error('no analysis is running for this project');
      return { cancelled: true };
    },
  });

  registry.register({
    name: 'project.unregister',
    revision: '1',
    description:
      'Remove a project registration. The repository on disk is never deleted; when Jobs or ' +
      'memory reference the project it is archived instead so history stays understandable.',
    risk: 'destructive',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      return deps.projects.unregister(input.id);
    },
  });

  // -------------------------------------------------------------------- jobs --

  registry.register({
    name: 'job.create',
    // 5: an optional `brief` field, the Job Brief Compiler's derived context.
    // It changes what the coding agent is told (not what it is authorised to
    // do, and not `request`, which stays the authority), so an approval bound
    // to revision 4 has to be granted again.
    //
    // 4: the input became `.strict()`, and the tool became idempotent in
    // `originMessageId` -- a message that already has a Job gets that Job back
    // rather than a second one. Both change what an approval means, so a
    // standing permission bound to revision 3 has to be granted again.
    revision: '5',
    description:
      'Create a development job against a project, optionally starting it. Runs in an isolated ' +
      'worktree and is never merged automatically.',
    // Creating a Job -- and, with `autostart`, handing an agent a shell in a
    // fresh worktree plus provider quota -- is a real modification of the
    // user's world. It stays at the level the pre-conversational tool had, so
    // an agent-originated request becomes a confirmation the human answers
    // rather than an unattended pipeline start.
    risk: 'reversible_modification',
    // `.strict()` like its neighbours. This is the one write-capable tool a
    // conversation can reach, so an unexpected key is a refusal rather than
    // something silently stripped on the way to starting an agent.
    input: z
      .object({
        projectId: z.string(),
        request: z.string().min(3),
        acceptance: z.array(z.string()).default([]),
        autostart: z.boolean().default(false),
        originMessageId: z.string().nullish(),
        // Derived context, never authority. `request` above is the user's own
        // message and stays the instruction; this is the compiled brief that
        // accompanies it. No conversational action carries this field, so a
        // model cannot put one here -- only trusted code that ran the compiler
        // after routing settled. Re-validated against the compiler's own caps
        // so an over-long or unknown-shaped brief is refused at the boundary.
        brief: StoredJobBriefSchema.nullish(),
      })
      .strict(),
    async execute(input, ctx) {
      // Idempotent in `originMessageId`: see `JobService.create`. A retried
      // turn, a double-clicked button and a confirmation approved twice all
      // land on the Job that already exists.
      const job = deps.jobs.create({
        projectId: input.projectId,
        request: input.request,
        acceptance: input.acceptance,
        brief: input.brief ?? null,
        sessionId: ctx.sessionId ?? null,
        originMessageId: input.originMessageId ?? null,
      });
      // Linking here rather than in the chat turn: creation may land later,
      // from a human confirming the request, and the conversation still has to
      // end up pointing at the Job it asked for.
      if (ctx.sessionId) {
        const state = deps.sessions.get(ctx.sessionId)?.state;
        if (state) {
          deps.sessions.updateState(ctx.sessionId, {
            goal: job.goal,
            activeJobIds: [...new Set([...(state.activeJobIds ?? []), job.id])],
          });
        }
        if (input.originMessageId) deps.sessions.linkMessageJob(input.originMessageId, job.id);
        // What the conversation is about follows the Job that really exists.
        // Recording it earlier changed the conversation's project even when the
        // human went on to refuse the Job it was resolved for, and recording it
        // in the chat dispatcher missed the Job a human confirms later.
        deps.sessions.setProject(ctx.sessionId, job.projectId);
      }
      if (input.autostart) deps.pipeline.start(job.id);
      return job;
    },
  });

  registry.register({
    name: 'job.status',
    revision: '2',
    description: 'Current stage, status, staleness and agent runs for a job.',
    risk: 'observe',
    input: z.object({ id: z.string() }),
    async execute(input) {
      const job = deps.jobs.get(input.id);
      if (!job) {
        const tombstone = deps.jobs.tombstone(input.id);
        return tombstone ? { job: null, tombstone } : null;
      }
      return {
        job,
        runs: deps.jobs.runs(job.id),
        running: deps.pipeline.isRunning(job.id),
        ...(job.stage === 'paused' ? { staleness: await deps.lifecycle.staleness(job.id) } : {}),
      };
    },
  });

  registry.register({
    name: 'job.list',
    revision: '1',
    description: 'List jobs with the same filters the Jobs page uses.',
    risk: 'observe',
    input: z
      .object({
        projectId: z.string().optional(),
        sessionId: z.string().optional(),
        status: z
          .enum([
            'pending',
            'running',
            'paused',
            'awaiting_user',
            'completed',
            'failed',
            'cancelled',
          ])
          .optional(),
        archived: z.enum(['active', 'archived', 'all']).default('active'),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).default(20),
      })
      .strict(),
    async execute(input) {
      return deps.jobs.list(input as Parameters<JobService['list']>[0]);
    },
  });

  registry.register({
    name: 'job.archive',
    revision: '2',
    description: 'Move a finished job out of History. Every artifact and audit record is kept.',
    // Not scratch state: this durably changes what the user sees in their own
    // sidebar or Job list, so an agent has to land on a confirmation for it.
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), archived: z.boolean().default(true) }).strict(),
    async execute(input) {
      const job = deps.jobs.setArchived(input.id, input.archived);
      if (!job) throw new Error('job not found');
      return job;
    },
  });

  registry.register({
    name: 'job.resume',
    revision: '1',
    description: 'Resume a paused job after validating its repository, base and worktree.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      const job = deps.jobs.get(input.id);
      if (!job) throw new Error('job not found');
      if (job.stage !== 'paused') throw new Error(`job is ${job.stage}, not paused`);
      const staleness = await deps.lifecycle.staleness(input.id);
      if (staleness.stale) {
        throw new Error(`${staleness.detail} Restart it as a new Job instead.`);
      }
      deps.pipeline.resume(input.id);
      return { resumed: true };
    },
  });

  registry.register({
    name: 'job.retry',
    revision: '1',
    description:
      'Run a finished job again as a NEW job against the project’s current base, keeping a ' +
      'provenance link to its predecessor.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), autostart: z.boolean().default(false) }).strict(),
    async execute(input, ctx) {
      const job = deps.jobs.retryAsNew(input.id, {
        sessionId: ctx.sessionId ?? undefined,
      });
      if (input.autostart) deps.pipeline.start(job.id);
      return job;
    },
  });

  registry.register({
    name: 'job.cancel',
    revision: '1',
    description:
      'Stop a running job. Work already done in its worktree stays, so the effect is partial ' +
      'by nature.',
    risk: 'sensitive',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      if (!deps.pipeline.cancel(input.id)) throw new Error('job is not running');
      return { cancelled: true };
    },
  });

  registry.register({
    name: 'job.delete',
    revision: '1',
    description:
      'Abandon a candidate and erase its disposable state: worktree, branch, screenshots and ' +
      'pipeline rows. Refused for any job whose candidate was applied or self-upgraded.',
    risk: 'destructive',
    input: z.object({ id: z.string(), reason: z.string().max(500).optional() }).strict(),
    async execute(input) {
      return deps.lifecycle.delete(input.id, input.reason ?? 'deleted by the user');
    },
  });

  // ----------------------------------------------------------- conversations --

  registry.register({
    name: 'conversation.create',
    revision: '1',
    description: 'Start a new conversation with fresh working state.',
    risk: 'safe_action',
    input: z.object({ title: z.string().max(120).optional() }).strict(),
    async execute(input) {
      return deps.sessions.create(input.title ? { title: input.title } : {});
    },
  });

  registry.register({
    name: 'conversation.rename',
    revision: '2',
    description: 'Rename a conversation.',
    // Not scratch state: this durably changes what the user sees in their own
    // sidebar or Job list, so an agent has to land on a confirmation for it.
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), title: z.string().min(1).max(120) }).strict(),
    async execute(input) {
      const updated = deps.sessions.rename(input.id, input.title);
      if (!updated) throw new Error('conversation not found');
      return updated;
    },
  });

  registry.register({
    name: 'conversation.pin',
    revision: '1',
    description: 'Pin or unpin a conversation in the sidebar.',
    risk: 'safe_action',
    input: z.object({ id: z.string(), pinned: z.boolean() }).strict(),
    async execute(input) {
      const updated = deps.sessions.setPinned(input.id, input.pinned);
      if (!updated) throw new Error('conversation not found');
      return updated;
    },
  });

  registry.register({
    name: 'conversation.archive',
    revision: '2',
    description: 'Archive or unarchive a conversation. The transcript is kept.',
    // Not scratch state: this durably changes what the user sees in their own
    // sidebar or Job list, so an agent has to land on a confirmation for it.
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), archived: z.boolean().default(true) }).strict(),
    async execute(input) {
      const updated = deps.sessions.setArchived(input.id, input.archived);
      if (!updated) throw new Error('conversation not found');
      return updated;
    },
  });

  registry.register({
    name: 'conversation.set_project',
    revision: '1',
    description: 'Set or clear the registered project context for a conversation.',
    risk: 'safe_action',
    input: z.object({ id: z.string(), projectId: z.string().nullable() }).strict(),
    async execute(input) {
      if (input.projectId && !deps.projects.get(input.projectId))
        throw new Error('project not found');
      const updated = deps.sessions.setProject(input.id, input.projectId);
      if (!updated) throw new Error('conversation not found');
      return updated;
    },
  });

  registry.register({
    name: 'conversation.delete',
    revision: '1',
    description:
      'Delete a conversation and its transcript. Jobs created from it, project memory and ' +
      'global user memory are all preserved.',
    risk: 'destructive',
    input: z.object({ id: z.string() }).strict(),
    async execute(input) {
      const outcome = deps.sessions.delete(input.id);
      if (!outcome.deleted) throw new Error('conversation not found');
      return outcome;
    },
  });

  // ------------------------------------------------------------------ search --

  registry.register({
    name: 'search.everything',
    revision: '1',
    description:
      'Local typed search across conversations, projects and jobs. Never makes a model call.',
    risk: 'observe',
    input: z
      .object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(30).default(8),
      })
      .strict(),
    async execute(input) {
      return searchEverything(deps, input.query, input.limit);
    },
  });

  return registry;
}

export interface SearchHit {
  type: 'conversation' | 'project' | 'job';
  id: string;
  title: string;
  subtitle: string;
}

/**
 * Global search. Deliberately lexical and local: an ordinary "find my sitepilot
 * chat" must never cost agent quota or leave the machine.
 */
export function searchEverything(
  deps: Pick<BuiltinToolDeps, 'sessions' | 'projects' | 'jobs'>,
  query: string,
  limit = 8,
): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const hits: SearchHit[] = [];
  for (const conversation of deps.sessions.conversations({
    status: 'all',
    search: trimmed,
    limit,
  })) {
    hits.push({
      type: 'conversation',
      id: conversation.id,
      title: conversation.title ?? 'Untitled conversation',
      subtitle: conversation.preview ?? `${conversation.messageCount} messages`,
    });
  }
  for (const project of deps.projects.list({ status: 'all', search: trimmed }).slice(0, limit)) {
    hits.push({
      type: 'project',
      id: project.id,
      title: project.name,
      subtitle: project.archivedAt ? `archived · ${project.rootPath}` : project.rootPath,
    });
  }
  for (const job of deps.jobs.list({ search: trimmed, archived: 'all', limit })) {
    hits.push({
      type: 'job',
      id: job.id,
      title: job.goal,
      subtitle: `${job.stage}${job.archivedAt ? ' · archived' : ''}`,
    });
  }
  return hits;
}
