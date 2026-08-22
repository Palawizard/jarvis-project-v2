import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  detectExplicitCommand,
  normaliseGoal,
  renderProjectSnapshot,
  PIPELINE_STAGES,
  type Jarvis,
  type MemoryKind,
  type MemoryScope,
} from '@jarvis/core';

/**
 * HTTP surface. Thin on purpose: every route delegates to a core service, so the
 * API can be replaced (or joined by a CLI / MCP server) without touching domain logic.
 */
export function createRoutes(jarvis: Jarvis): Hono {
  const app = new Hono();

  const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

  // ------------------------------------------------------------------ health --
  app.get('/api/health', async (c) => {
    const capabilities = await jarvis.agents.capabilities();
    return c.json({
      ok: true,
      version: '0.1.0',
      home: jarvis.config.home,
      artifactsDir: jarvis.config.artifactsDir,
      providers: capabilities,
      memory: { ...jarvis.memory.stats(), embeddings: jarvis.memory.embeddingStatus() },
      context: { budgetTokens: jarvis.config.context.budgetTokens },
    });
  });

  // ------------------------------------------------------------------ events --
  // SSE with replay: `afterId` lets a reconnecting client catch up from the
  // persisted log instead of silently missing events.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const afterId = Number(c.req.query('afterId') ?? '0');
      let lastId = Number.isFinite(afterId) ? afterId : 0;

      for (const event of jarvis.bus.list({ afterId: lastId, limit: 200 })) {
        lastId = event.id ?? lastId;
        await stream.writeSSE({ id: String(lastId), event: event.type, data: JSON.stringify(event) });
      }

      const queue: string[] = [];
      const unsubscribe = jarvis.bus.on((event) => {
        queue.push(JSON.stringify(event));
      });

      try {
        while (!stream.closed) {
          const next = queue.shift();
          if (next) {
            const parsed = JSON.parse(next) as { id?: number; type: string };
            await stream.writeSSE({ id: String(parsed.id ?? ''), event: parsed.type, data: next });
          } else {
            // Comment frames keep proxies from closing an idle connection.
            await stream.writeSSE({ data: '', event: 'ping' });
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  // ---------------------------------------------------------------- projects --
  app.get('/api/projects', (c) => c.json(jarvis.projects.list()));

  app.post('/api/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { rootPath?: string; name?: string; devUrl?: string };
    if (!body.rootPath) return fail('rootPath is required');
    try {
      const project = await jarvis.projects.register({
        rootPath: body.rootPath,
        ...(body.name ? { name: body.name } : {}),
        ...(body.devUrl ? { devUrl: body.devUrl } : {}),
      });
      return c.json(project, 201);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  app.get('/api/projects/:id', (c) => {
    const project = jarvis.projects.get(c.req.param('id'));
    if (!project) return fail('project not found', 404);
    return c.json({
      project,
      snapshot: renderProjectSnapshot(project),
      jobs: jarvis.jobs.list({ projectId: project.id, limit: 20 }),
      memory: jarvis.memory.list({ scope: 'project', scopeId: project.id, limit: 100 }),
    });
  });

  app.patch('/api/projects/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, never>;
    const updated = jarvis.projects.update(c.req.param('id'), body);
    if (!updated) return fail('project not found', 404);
    return c.json(updated);
  });

  app.post('/api/projects/:id/refresh', (c) => {
    const updated = jarvis.projects.refreshDetection(c.req.param('id'));
    if (!updated) return fail('project not found', 404);
    return c.json(updated);
  });

  /** Delete an entire project's Jarvis memory. Deliberately explicit and separate. */
  app.delete('/api/projects/:id/memory', (c) => {
    const removed = jarvis.memory.purgeScope('project', c.req.param('id'));
    return c.json({ removed });
  });

  // ---------------------------------------------------------------- sessions --
  app.get('/api/session', (c) => {
    const session = jarvis.sessions.current();
    return c.json({
      session,
      rendered: jarvis.sessions.renderState(session.state),
      messages: jarvis.sessions.messages(session.id, 100),
    });
  });

  app.post('/api/sessions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; projectId?: string };
    return c.json(jarvis.sessions.create(body), 201);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: string | null };
    if (body.projectId !== undefined) {
      const updated = jarvis.sessions.setProject(c.req.param('id'), body.projectId);
      if (!updated) return fail('session not found', 404);
      return c.json(updated);
    }
    return fail('nothing to update');
  });

  // ----------------------------------------------------------------- command --
  /**
   * The Home/Command surface.
   *
   * Stage A of the memory pipeline runs here: explicit remember/forget/update is
   * detected deterministically and handled without any model call. Only an actual
   * coding request spends agent quota.
   */
  app.post('/api/command', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      sessionId?: string;
      projectId?: string | null;
      autostart?: boolean;
    };
    const text = body.text?.trim();
    if (!text) return fail('text is required');

    const session = body.sessionId ? jarvis.sessions.get(body.sessionId) : jarvis.sessions.current();
    if (!session) return fail('session not found', 404);
    jarvis.sessions.addMessage(session.id, 'user', text);

    const explicit = detectExplicitCommand(text);
    if (explicit) {
      const projectId = body.projectId ?? session.projectId;
      if (explicit.action === 'remember') {
        const outcome = await jarvis.memory.remember({
          scope: projectId ? 'project' : 'user',
          scopeId: projectId ?? null,
          kind: 'preference',
          content: explicit.payload,
          sourceType: 'user_explicit',
          sourceRef: { sessionId: session.id },
          explicit: true,
        });
        const reply =
          outcome.status === 'stored'
            ? `Remembered${outcome.supersededId ? ' (and superseded the previous value)' : ''}.`
            : outcome.status === 'duplicate'
              ? 'I already knew that — kept the existing memory.'
              : `Not stored: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`;
        jarvis.sessions.addMessage(session.id, 'assistant', reply);
        return c.json({ kind: 'memory', action: 'remember', outcome, reply });
      }

      if (explicit.action === 'forget') {
        const matches = await jarvis.memory.retrieve({
          query: explicit.payload,
          scopes: [
            { scope: 'user', scopeId: null },
            ...(projectId ? [{ scope: 'project' as MemoryScope, scopeId: projectId }] : []),
          ],
          limit: 5,
        });
        const target = matches[0];
        if (!target) {
          const reply = `I could not find a memory matching "${explicit.payload}".`;
          jarvis.sessions.addMessage(session.id, 'assistant', reply);
          return c.json({ kind: 'memory', action: 'forget', reply, candidates: [] });
        }
        jarvis.memory.forget(target.memory.id);
        const reply = `Forgot: "${target.memory.content}"`;
        jarvis.sessions.addMessage(session.id, 'assistant', reply);
        return c.json({
          kind: 'memory',
          action: 'forget',
          reply,
          forgotten: target.memory,
          candidates: matches.slice(1).map((m) => m.memory),
        });
      }

      // update/correction
      const matches = await jarvis.memory.retrieve({
        query: explicit.payload,
        scopes: [
          { scope: 'user', scopeId: null },
          ...(projectId ? [{ scope: 'project' as MemoryScope, scopeId: projectId }] : []),
        ],
        limit: 3,
      });
      const target = matches[0];
      const outcome = target
        ? await jarvis.memory.correct(target.memory.id, explicit.payload, { sessionId: session.id })
        : await jarvis.memory.remember({
            scope: projectId ? 'project' : 'user',
            scopeId: projectId ?? null,
            kind: 'correction',
            content: explicit.payload,
            sourceType: 'user_explicit',
            sourceRef: { sessionId: session.id },
            explicit: true,
          });
      const reply = target ? 'Updated — the previous version is kept as superseded.' : 'Noted as a new memory.';
      jarvis.sessions.addMessage(session.id, 'assistant', reply);
      return c.json({ kind: 'memory', action: 'update', outcome, reply });
    }

    // Not a memory command: treat it as a development request.
    const projectId = body.projectId ?? session.projectId;
    if (!projectId) {
      const reply = 'Select a project first — I need a target repository for a development job.';
      jarvis.sessions.addMessage(session.id, 'assistant', reply);
      return c.json({ kind: 'need_project', reply });
    }
    const job = jarvis.jobs.create({ projectId, sessionId: session.id, request: text });
    jarvis.sessions.updateState(session.id, { goal: job.goal, activeJobIds: [job.id] });
    if (body.autostart !== false) jarvis.pipeline.start(job.id);
    const reply = `Started job "${job.goal}".`;
    jarvis.sessions.addMessage(session.id, 'assistant', reply);
    return c.json({ kind: 'job', job, reply });
  });

  // -------------------------------------------------------------------- jobs --
  app.get('/api/jobs', (c) => {
    const projectId = c.req.query('projectId');
    return c.json(jarvis.jobs.list({ ...(projectId ? { projectId } : {}), limit: 50 }));
  });

  app.post('/api/jobs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      request?: string;
      acceptance?: string[];
      sessionId?: string;
      autostart?: boolean;
    };
    if (!body.projectId || !body.request) return fail('projectId and request are required');
    if (!jarvis.projects.get(body.projectId)) return fail('project not found', 404);
    const job = jarvis.jobs.create({
      projectId: body.projectId,
      request: body.request,
      acceptance: body.acceptance ?? [],
      sessionId: body.sessionId ?? null,
    });
    if (body.autostart) jarvis.pipeline.start(job.id);
    return c.json(job, 201);
  });

  app.get('/api/jobs/:id', (c) => {
    const job = jarvis.jobs.get(c.req.param('id'));
    if (!job) return fail('job not found', 404);
    const runs = jarvis.jobs.runs(job.id);
    const packIds = [...new Set(runs.map((r) => r.contextPackId).filter(Boolean))] as string[];
    return c.json({
      job,
      stages: PIPELINE_STAGES,
      running: jarvis.pipeline.isRunning(job.id),
      runs,
      verifications: jarvis.verification.list(job.id),
      reviews: jarvis.review.list(job.id),
      visualQa: jarvis.visualQa.list(job.id),
      events: jarvis.bus.list({ jobId: job.id, limit: 400 }),
      episode: job.episodeId ? jarvis.memory.get(job.episodeId) : null,
      contextPacks: packIds.map((id) => jarvis.context.getPack(id)).filter(Boolean),
      project: jarvis.projects.get(job.projectId),
    });
  });

  app.post('/api/jobs/:id/start', (c) => {
    const job = jarvis.jobs.get(c.req.param('id'));
    if (!job) return fail('job not found', 404);
    if (job.stage !== 'queued') return fail(`job is already ${job.stage}`, 409);
    jarvis.pipeline.start(job.id);
    return c.json({ started: true });
  });

  app.post('/api/jobs/:id/cancel', (c) => {
    const cancelled = jarvis.pipeline.cancel(c.req.param('id'));
    return c.json({ cancelled });
  });

  /** User accepts the candidate. V1 never auto-merges; this only records the decision. */
  app.post('/api/jobs/:id/accept', (c) => {
    const job = jarvis.jobs.get(c.req.param('id'));
    if (!job) return fail('job not found', 404);
    if (job.stage !== 'awaiting_user') return fail(`job is ${job.stage}, not awaiting_user`, 409);
    return c.json(jarvis.jobs.transition(job.id, 'completed'));
  });

  // ------------------------------------------------------------------ memory --
  app.get('/api/memory', (c) => {
    const q = c.req.query();
    return c.json(
      jarvis.memory.list({
        ...(q.scope ? { scope: q.scope as MemoryScope } : {}),
        ...(q.scopeId ? { scopeId: q.scopeId } : {}),
        ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
        ...(q.status ? { status: q.status as 'active' | 'all' } : {}),
        ...(q.search ? { search: q.search } : {}),
        limit: Number(q.limit ?? 100),
        offset: Number(q.offset ?? 0),
      }),
    );
  });

  app.post('/api/memory/search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      query?: string;
      projectId?: string | null;
      limit?: number;
    };
    if (!body.query) return fail('query is required');
    const results = await jarvis.memory.retrieve({
      query: body.query,
      scopes: [
        { scope: 'user', scopeId: null },
        ...(body.projectId ? [{ scope: 'project' as MemoryScope, scopeId: body.projectId }] : []),
      ],
      limit: body.limit ?? 12,
    });
    return c.json(results);
  });

  app.post('/api/memory', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: MemoryScope;
      scopeId?: string | null;
      kind?: MemoryKind;
      subject?: string | null;
      content?: string;
      importance?: number;
    };
    if (!body.content) return fail('content is required');
    const outcome = await jarvis.memory.remember({
      scope: body.scope ?? 'user',
      scopeId: body.scopeId ?? null,
      kind: body.kind ?? 'fact',
      subject: body.subject ?? null,
      content: body.content,
      ...(body.importance !== undefined ? { importance: body.importance } : {}),
      sourceType: 'user_explicit',
      explicit: true,
    });
    return c.json(outcome, outcome.status === 'rejected' ? 422 : 201);
  });

  app.get('/api/memory/:id', (c) => {
    const memory = jarvis.memory.get(c.req.param('id'));
    if (!memory) return fail('memory not found', 404);
    return c.json({
      memory,
      supersedes: memory.supersedes ? jarvis.memory.get(memory.supersedes) : null,
      supersededBy: memory.supersededBy ? jarvis.memory.get(memory.supersededBy) : null,
    });
  });

  app.patch('/api/memory/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { pinned?: boolean; content?: string };
    if (body.pinned !== undefined) {
      if (!jarvis.memory.setPinned(id, body.pinned)) return fail('memory not found', 404);
    }
    if (body.content) {
      const outcome = await jarvis.memory.correct(id, body.content);
      return c.json(outcome, outcome.status === 'rejected' ? 422 : 200);
    }
    return c.json(jarvis.memory.get(id));
  });

  app.delete('/api/memory/:id', (c) => {
    const hard = c.req.query('hard') === 'true';
    const ok = hard ? jarvis.memory.purge(c.req.param('id')) : jarvis.memory.forget(c.req.param('id'));
    if (!ok) return fail('memory not found', 404);
    return c.json({ deleted: true, mode: hard ? 'hard' : 'soft' });
  });

  app.get('/api/context-packs/:id', (c) => {
    const pack = jarvis.context.getPack(c.req.param('id'));
    if (!pack) return fail('context pack not found', 404);
    // Attach the live memory rows so the UI can show what was injected and why.
    return c.json({
      ...pack,
      selections: pack.selections.map((s) => ({ ...s, memory: jarvis.memory.get(s.memoryId) })),
    });
  });

  // --------------------------------------------------------------- visual QA --
  app.post('/api/visual-qa', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      jobId?: string;
      baseUrl?: string;
      routes?: string[];
    };
    if (!body.baseUrl) return fail('baseUrl is required');
    const shots = await jarvis.visualQa.capture({
      ...(body.projectId ? { projectId: body.projectId } : {}),
      ...(body.jobId ? { jobId: body.jobId } : {}),
      baseUrl: body.baseUrl,
      routes: body.routes?.length ? body.routes : ['/'],
    });
    return c.json(shots);
  });

  /** Serve screenshots. Path-confined to the artifacts directory. */
  app.get('/api/artifacts/*', (c) => {
    const requested = decodeURIComponent(c.req.path.replace('/api/artifacts/', ''));
    const root = path.resolve(jarvis.config.artifactsDir);
    const target = path.resolve(root, requested);
    // Reject traversal: the resolved path must stay under the artifacts root.
    if (target !== root && !target.startsWith(root + path.sep)) return fail('forbidden', 403);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail('not found', 404);
    const ext = path.extname(target).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'text/plain';
    return new Response(fs.readFileSync(target) as unknown as BodyInit, { headers: { 'content-type': type } });
  });

  // ------------------------------------------------------------------- tools --
  app.get('/api/tools', (c) => c.json(jarvis.tools.list()));

  app.post('/api/tools/:name', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { input?: unknown; maxRisk?: string };
    try {
      const result = await jarvis.tools.execute(c.req.param('name'), body.input ?? {}, {
        maxRisk: (body.maxRisk as 'observe') ?? 'reversible_modification',
      });
      return c.json({ ok: true, result });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 422);
    }
  });

  app.get('/api/goal-preview', (c) => c.json({ goal: normaliseGoal(c.req.query('text') ?? '') }));

  return app;
}
