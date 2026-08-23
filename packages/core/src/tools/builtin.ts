import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import type { MemoryService } from '../memory/service.js';
import type { ProjectService } from '../projects/service.js';
import type { JobService } from '../jobs/service.js';
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

/**
 * The tools the initial vertical slice actually needs.
 *
 * Everything else in the roadmap (screen, desktop control, gmail, calendar)
 * registers the same way; none of it is stubbed here, because a stub that
 * returns nothing is worse than an honestly absent tool.
 */
export function registerBuiltinTools(deps: {
  memory: MemoryService;
  projects: ProjectService;
  jobs: JobService;
}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'memory.search',
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
    description: 'Soft-delete a memory. It stops being retrievable but stays auditable.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string() }),
    async execute(input) {
      return { forgotten: deps.memory.forget(input.id) };
    },
  });

  registry.register({
    name: 'memory.update',
    description: 'Correct a memory: stores the new value and supersedes the old one.',
    risk: 'reversible_modification',
    input: z.object({ id: z.string(), content: z.string().min(1) }),
    async execute(input, ctx) {
      return deps.memory.correct(input.id, input.content, {
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      });
    },
  });

  registry.register({
    name: 'project.list',
    description: 'List projects Jarvis knows about.',
    risk: 'observe',
    input: z.object({}),
    async execute() {
      return deps.projects.list().map((p) => ({
        id: p.id,
        name: p.name,
        rootPath: p.rootPath,
        isSelf: p.isSelf,
        stack: p.stack,
      }));
    },
  });

  registry.register({
    name: 'project.inspect',
    description: 'Full detail for one project, including detected commands.',
    risk: 'observe',
    input: z.object({ id: z.string() }),
    async execute(input) {
      return deps.projects.get(input.id);
    },
  });

  registry.register({
    name: 'job.create',
    description: 'Create a development job against a project. Does not start it.',
    risk: 'reversible_modification',
    input: z.object({
      projectId: z.string(),
      request: z.string().min(3),
      acceptance: z.array(z.string()).default([]),
    }),
    async execute(input, ctx) {
      return deps.jobs.create({
        projectId: input.projectId,
        request: input.request,
        acceptance: input.acceptance,
        sessionId: ctx.sessionId ?? null,
      });
    },
  });

  registry.register({
    name: 'job.status',
    description: 'Current stage, status and agent runs for a job.',
    risk: 'observe',
    input: z.object({ id: z.string() }),
    async execute(input) {
      const job = deps.jobs.get(input.id);
      if (!job) return null;
      return { job, runs: deps.jobs.runs(job.id) };
    },
  });

  return registry;
}
