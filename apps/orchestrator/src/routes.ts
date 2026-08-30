import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  candidateRejectionReason,
  GitWorkspace,
  repoStatus,
  normaliseGoal,
  renderProjectSnapshot,
  searchEverything,
  PIPELINE_STAGES,
  RISK_LEVELS,
  type Jarvis,
  type JobStage,
  type JobStatus,
  type MemoryKind,
  type MemoryScope,
  type RiskLevel,
  type ToolExecutionStatus,
  type ToolExecutionOutcome,
  type VisualInteraction,
  agentIsolationPreflight,
} from '@jarvis/core';

const JOB_STATUSES = new Set<string>([
  'pending',
  'running',
  'paused',
  'awaiting_user',
  'completed',
  'failed',
  'cancelled',
]);

const MEMORY_SCOPES = new Set<MemoryScope>(['user', 'project', 'session', 'agent', 'procedure']);
const MEMORY_KINDS = new Set<MemoryKind>([
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
]);
const MEMORY_STATUSES = new Set<string>(['active', 'superseded', 'expired', 'deleted', 'all']);

/**
 * HTTP surface. Thin on purpose: every route delegates to a core service, so the
 * API can be replaced (or joined by a CLI / MCP server) without touching domain logic.
 */
export function createRoutes(jarvis: Jarvis): Hono {
  const app = new Hono();
  const git = new GitWorkspace(jarvis.config.worktreesDir);

  const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
  /**
   * Answer with an outcome that really succeeded, or say plainly that it did not.
   *
   * For a tool the caller can run directly -- no confirmation in its path -- a
   * non-succeeded outcome means the mutation did not happen, and answering 200
   * with it made the browser report success for a write that never landed.
   * Routes whose tool legitimately returns `pending_approval` (the destructive
   * ones) must NOT use this: there, 200 plus the pending outcome is the contract.
   */
  const settled = (outcome: ToolExecutionOutcome) => {
    if (outcome.status === 'succeeded') return Response.json(outcome);
    const detail = 'error' in outcome && outcome.error ? `: ${outcome.error}` : '';
    return fail(`${outcome.execution.toolName} did not run (${outcome.status}${detail})`, 409);
  };
  const allowedOrigin = (origin: string | undefined) =>
    Boolean(origin && jarvis.config.controlOrigins.includes(origin));

  // Loopback is not authentication. Only pairing/status and preflight bypass
  // the browser capability; every other /api route, including reads and SSE,
  // is private.
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (c.req.method === 'OPTIONS' || path === '/api/auth/status' || path === '/api/auth/pair') {
      await next();
      return;
    }
    if (!jarvis.control.authenticated(c.req.header('x-jarvis-control'))) {
      return c.json({ error: 'human control authentication required' }, 401);
    }
    if (!['GET', 'HEAD'].includes(c.req.method) && !allowedOrigin(c.req.header('origin'))) {
      return c.json({ error: 'human control origin rejected' }, 403);
    }
    await next();
  });

  app.get('/api/auth/status', (c) =>
    c.json({
      authenticated: jarvis.control.authenticated(c.req.header('x-jarvis-control')),
      paired: jarvis.control.paired(),
    }),
  );

  app.post('/api/auth/pair', async (c) => {
    if (!allowedOrigin(c.req.header('origin'))) return fail('pairing origin rejected', 403);
    const body = (await c.req.json().catch(() => ({}))) as { bootstrap?: unknown };
    if (typeof body.bootstrap !== 'string') return fail('pairing token is required', 401);
    const credential = jarvis.control.pair(body.bootstrap);
    return credential
      ? c.json({ credential })
      : fail('pairing token is invalid, expired, or already used', 401);
  });

  app.post('/api/auth/revoke', (c) => {
    jarvis.control.revoke();
    return c.json({ revoked: true, restartRequired: true });
  });

  const health = async () => {
    let db: 'ok' | 'error' = 'ok';
    try {
      jarvis.db.prepare('SELECT 1').get();
    } catch {
      db = 'error';
    }
    const self = jarvis.projects.getSelf();
    const commit = self ? (await repoStatus(self.rootPath)).head : null;
    return {
      status: db === 'ok' ? ('ok' as const) : ('error' as const),
      version: '0.1.0',
      commit: process.env.JARVIS_COMMIT ?? commit ?? 'unknown',
      db,
      runtimeNonce: process.env.JARVIS_RUNTIME_NONCE ?? null,
    };
  };

  // ------------------------------------------------------------------ health --
  app.get('/health', async (c) => c.json(await health()));
  app.get('/api/health', async (c) => {
    const capabilities = await jarvis.agents.capabilities();
    const state = await health();
    return c.json({
      ...state,
      ok: state.status === 'ok',
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
      const queue: string[] = [];
      const unsubscribe = jarvis.bus.on((event) => {
        queue.push(JSON.stringify(event));
      });

      try {
        // Subscribe before replay so an event emitted between the SELECT and
        // listener registration cannot disappear. Page through the full gap;
        // the cursor de-duplicates events also seen by the live listener.
        for (;;) {
          const replay = jarvis.bus.list({ afterId: lastId, limit: 500 });
          for (const event of replay) {
            lastId = event.id ?? lastId;
            await stream.writeSSE({ id: String(lastId), data: JSON.stringify(event) });
          }
          if (replay.length < 500) break;
        }

        while (!stream.closed) {
          const next = queue.shift();
          if (next) {
            const parsed = JSON.parse(next) as { id?: number; type: string };
            if (parsed.id && parsed.id <= lastId) continue;
            lastId = parsed.id ?? lastId;
            // Default SSE messages are intentionally unnamed: the authenticated
            // fetch-stream consumer handles every normalized Jarvis event.
            await stream.writeSSE({ id: String(parsed.id ?? ''), data: next });
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
  app.get('/api/projects', (c) => {
    const status = c.req.query('status');
    const search = c.req.query('search');
    if (status && !['active', 'archived', 'all'].includes(status)) return fail('invalid status');
    return c.json(
      jarvis.projects.list({
        status: (status as 'active' | 'archived' | 'all') ?? 'all',
        ...(search ? { search } : {}),
      }),
    );
  });

  app.post('/api/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      rootPath?: string;
      name?: string;
      devUrl?: string;
    };
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

  /**
   * Editable project metadata. Everything goes through the tool boundary so the
   * button and the sentence "rename project X to Y" share one implementation
   * and one audit trail.
   */
  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.projects.get(id)) return fail('project not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      aliases?: unknown;
      devUrl?: unknown;
      summary?: unknown;
    };
    const input: Record<string, unknown> = { id };
    if (body.name !== undefined) input.name = body.name;
    if (body.aliases !== undefined) input.aliases = body.aliases;
    if (body.devUrl !== undefined) input.devUrl = body.devUrl;
    if (body.summary !== undefined) input.summary = body.summary;
    if (Object.keys(input).length === 1) return fail('nothing to update');
    return settled(
      await jarvis.tools.execute('project.update', input, { actor: 'user', projectId: id }),
    );
  });

  app.post('/api/projects/:id/archive', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.projects.get(id)) return fail('project not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    return settled(
      await jarvis.tools.execute(
        'project.archive',
        { id, archived: body.archived ?? true },
        { actor: 'user', projectId: id },
      ),
    );
  });

  /** What unregistering would do, so the confirmation dialog can say it exactly. */
  app.get('/api/projects/:id/unregister-preflight', (c) => {
    if (!jarvis.projects.get(c.req.param('id'))) return fail('project not found', 404);
    return c.json(jarvis.projects.unregisterPreflight(c.req.param('id')));
  });

  /**
   * Unregister. Destructive by policy, so this returns a pending approval that
   * the human answers through /api/tool-executions/:id/approve — the browser
   * modal is the explanation, never the authority.
   */
  app.delete('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.projects.get(id)) return fail('project not found', 404);
    return c.json(await jarvis.tools.execute('project.unregister', { id }, { actor: 'user' }));
  });

  app.post('/api/projects/:id/refresh', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.projects.get(id)) return fail('project not found', 404);
    return settled(
      await jarvis.tools.execute('project.redetect', { id }, { actor: 'user', projectId: id }),
    );
  });

  /** Delete an entire project's Jarvis memory. Deliberately explicit and separate. */
  app.delete('/api/projects/:id/memory', async (c) => {
    const projectId = c.req.param('id');
    if (!jarvis.projects.get(projectId)) return fail('project not found', 404);
    return c.json(
      await jarvis.tools.execute(
        'memory.purge_project',
        { projectId },
        { actor: 'user', projectId },
      ),
    );
  });

  // ----------------------------------------------------------- conversations --
  const conversationDetail = (id: string) => {
    const conversation = jarvis.sessions.get(id);
    if (!conversation) return null;
    const messages = jarvis.sessions.messages(id, 400);
    const executionIds = new Set(
      messages
        .map((message) => message.metadata.executionId)
        .filter((executionId): executionId is string => typeof executionId === 'string'),
    );
    return {
      conversation,
      rendered: jarvis.sessions.renderState(conversation.state),
      messages,
      toolExecutions: [...executionIds]
        .map((executionId) => jarvis.tools.getExecution(executionId))
        .filter((execution) => execution?.sessionId === id),
      // Job cards render live from these; a deleted Job renders its tombstone.
      jobs: jarvis.jobs.list({ sessionId: id, archived: 'all', limit: 50 }),
      tombstones: jarvis.jobs.tombstonesForSession(id),
      responding: jarvis.chat.isResponding(id),
    };
  };

  app.get('/api/conversations', (c) => {
    const status = c.req.query('status') ?? 'active';
    if (!['active', 'archived', 'all'].includes(status)) return fail('invalid status');
    const search = c.req.query('search');
    return c.json(
      jarvis.sessions.conversations({
        status: status as 'active' | 'archived' | 'all',
        ...(search ? { search } : {}),
        limit: Math.min(200, Number.parseInt(c.req.query('limit') ?? '80', 10) || 80),
      }),
    );
  });

  app.post('/api/conversations', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    if (body.title !== undefined && typeof body.title !== 'string') {
      return fail('title must be a string');
    }
    const outcome = await jarvis.tools.execute(
      'conversation.create',
      body.title ? { title: body.title } : {},
      { actor: 'user' },
    );
    if (outcome.status !== 'succeeded') return fail('could not create a conversation', 409);
    return c.json(outcome.result, 201);
  });

  app.get('/api/conversations/:id', (c) => {
    const detail = conversationDetail(c.req.param('id'));
    if (!detail) return fail('conversation not found', 404);
    return c.json(detail);
  });

  app.patch('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.sessions.get(id)) return fail('conversation not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: unknown;
      pinned?: unknown;
      archived?: unknown;
      projectId?: unknown;
    };
    const fields = Object.keys(body);
    if (
      fields.length !== 1 ||
      !['title', 'pinned', 'archived', 'projectId'].includes(fields[0] as string)
    ) {
      return fail('exactly one supported conversation field is required');
    }
    // Every mutation goes through the permission boundary, so every mutation has
    // an outcome. Reporting success for a rename that is awaiting approval,
    // denied, failed or of unknown effect would leave the UI showing state the
    // database does not have.
    const mutate = async (tool: string, input: Record<string, unknown>, what: string) => {
      const outcome = await jarvis.tools.execute(tool, input, { actor: 'user', sessionId: id });
      if (outcome.status === 'succeeded') return null;
      const detail = 'error' in outcome ? `: ${outcome.error}` : '';
      // 409 for every non-succeeded outcome, exactly as the projectId branch
      // below already does: the endpoint promises the conversation now holds
      // this state, and a pending or denied mutation means it does not.
      return fail(`could not ${what} (${outcome.status}${detail})`, 409);
    };
    // A single field of the wrong type, or a blank title, matched no branch
    // below and still answered 200 -- a success for a mutation that never
    // happened, which is the same lie the outcome checks exist to prevent.
    let dispatched = false;
    if (typeof body.title === 'string' && body.title.trim()) {
      dispatched = true;
      const rejected = await mutate(
        'conversation.rename',
        { id, title: body.title.trim() },
        'rename the conversation',
      );
      if (rejected) return rejected;
    }
    if (typeof body.pinned === 'boolean') {
      dispatched = true;
      const rejected = await mutate(
        'conversation.pin',
        { id, pinned: body.pinned },
        'pin the conversation',
      );
      if (rejected) return rejected;
    }
    if (typeof body.archived === 'boolean') {
      dispatched = true;
      const rejected = await mutate(
        'conversation.archive',
        { id, archived: body.archived },
        'archive the conversation',
      );
      if (rejected) return rejected;
    }
    if (body.projectId !== undefined) {
      dispatched = true;
      if (body.projectId !== null && typeof body.projectId !== 'string') {
        return fail('projectId must be a string or null');
      }
      if (body.projectId && !jarvis.projects.get(body.projectId)) {
        return fail('project not found', 404);
      }
      const projectId = (body.projectId as string | null) ?? null;
      const outcome = await jarvis.tools.execute(
        'conversation.set_project',
        { id, projectId },
        { actor: 'user', sessionId: id, projectId },
      );
      if (outcome.status !== 'succeeded') return fail('could not update project context', 409);
    }
    if (!dispatched) return fail('the supported conversation field had an unusable value');
    return c.json(jarvis.sessions.get(id));
  });

  /** Destructive: returns a pending approval the human must answer explicitly. */
  app.delete('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.sessions.get(id)) return fail('conversation not found', 404);
    return c.json(
      await jarvis.tools.execute('conversation.delete', { id }, { actor: 'user', sessionId: id }),
    );
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return fail('text is required');
    try {
      return c.json(await jarvis.chat.send({ conversationId: id, text: body.text }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/conversations/:id/stop', (c) =>
    c.json({ stopped: jarvis.chat.stop(c.req.param('id')) }),
  );

  app.post('/api/conversations/:id/retry', async (c) => {
    try {
      return c.json(await jarvis.chat.retry(c.req.param('id')));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/conversations/:id/edit-last', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return fail('text is required');
    try {
      return c.json(await jarvis.chat.editLastUserMessage(c.req.param('id'), body.text));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  // ------------------------------------------------------------------ search --
  app.get('/api/search', (c) => {
    const query = c.req.query('q') ?? '';
    if (!query.trim()) return c.json([]);
    return c.json(
      searchEverything(
        { sessions: jarvis.sessions, projects: jarvis.projects, jobs: jarvis.jobs },
        query,
        Math.min(20, Number.parseInt(c.req.query('limit') ?? '6', 10) || 6),
      ),
    );
  });

  // -------------------------------------------- sessions (compatibility shim) --
  // The old single "current session" surface. Kept so an existing client keeps
  // working; the new UI addresses conversations by id and never relies on it.
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
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: unknown };
    if (body.projectId !== undefined) {
      if (body.projectId !== null && typeof body.projectId !== 'string') {
        return fail('projectId must be a string or null');
      }
      if (body.projectId && !jarvis.projects.get(body.projectId))
        return fail('project not found', 404);
      const id = c.req.param('id');
      const outcome = await jarvis.tools.execute(
        'conversation.set_project',
        { id, projectId: body.projectId },
        { actor: 'user', sessionId: id, projectId: body.projectId },
      );
      if (outcome.status !== 'succeeded') return fail('session not found', 404);
      return c.json(outcome.result);
    }
    return fail('nothing to update');
  });

  // ----------------------------------------------------------------- command --
  /**
   * Compatibility shim for the pre-conversation Command surface.
   *
   * Everything it used to decide now lives in ChatService: explicit memory
   * commands stay deterministic and local, and a non-memory message is an
   * ordinary conversation rather than an automatic development job.
   */
  app.post('/api/command', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      sessionId?: string;
      projectId?: unknown;
    };
    const text = body.text?.trim();
    if (!text) return fail('text is required');
    const conversation = body.sessionId
      ? jarvis.sessions.get(body.sessionId)
      : jarvis.sessions.current();
    if (!conversation) return fail('conversation not found', 404);
    if (body.projectId !== undefined) {
      if (body.projectId !== null && typeof body.projectId !== 'string') {
        return fail('projectId must be a string or null');
      }
      if (body.projectId && !jarvis.projects.get(body.projectId))
        return fail('project not found', 404);
      const outcome = await jarvis.tools.execute(
        'conversation.set_project',
        { id: conversation.id, projectId: body.projectId },
        { actor: 'user', sessionId: conversation.id, projectId: body.projectId },
      );
      if (outcome.status !== 'succeeded') return fail('could not update project context', 409);
    }
    try {
      const turn = await jarvis.chat.send({ conversationId: conversation.id, text });
      return c.json({ ...turn, kind: turn.kind, job: turn.job ?? undefined });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  // -------------------------------------------------------------------- jobs --
  app.get('/api/jobs', (c) => {
    const q = c.req.query();
    if (q.archived && !['active', 'archived', 'all'].includes(q.archived)) {
      return fail('invalid archived filter');
    }
    if (q.status && !JOB_STATUSES.has(q.status)) return fail('invalid status');
    if (q.stage && !PIPELINE_STAGES.includes(q.stage as (typeof PIPELINE_STAGES)[number])) {
      return fail('invalid stage');
    }
    return c.json(
      jarvis.jobs.list({
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.status ? { status: q.status as JobStatus } : {}),
        ...(q.stage ? { stage: q.stage as JobStage } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(q.since ? { since: q.since } : {}),
        ...(q.until ? { until: q.until } : {}),
        ...(q.sort === 'updated' ? { sort: 'updated' as const } : {}),
        archived: (q.archived as 'active' | 'archived' | 'all') ?? 'active',
        limit: Math.min(200, Number.parseInt(q.limit ?? '100', 10) || 100),
      }),
    );
  });

  app.post('/api/jobs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      request?: string;
      acceptance?: string[];
      sessionId?: string;
      originMessageId?: string;
      autostart?: boolean;
      validationOnly?: boolean;
      candidateSource?: { baseSha?: string; sourceSha?: string };
      visualQa?: {
        required?: boolean;
        scenarios?: Array<{
          name?: string;
          route?: string;
          viewports?: Array<'desktop' | 'mobile'>;
          interactions?: Array<Record<string, unknown>>;
          viewportInteractions?: Partial<
            Record<'desktop' | 'mobile', Array<Record<string, unknown>>>
          >;
        }>;
      };
    };
    if (!body.projectId || !body.request) return fail('projectId and request are required');
    const project = jarvis.projects.get(body.projectId);
    if (!project) return fail('project not found', 404);
    if (body.validationOnly && !body.candidateSource) {
      return fail('validationOnly requires candidateSource');
    }
    if (body.candidateSource && !body.validationOnly) {
      return fail('candidateSource requires validationOnly');
    }
    if (body.visualQa?.scenarios && body.visualQa.scenarios.length === 0) {
      return fail('visualQa.scenarios must not be empty');
    }
    let candidateSource: { baseSha: string; sourceSha: string } | undefined;
    if (body.candidateSource) {
      if (!body.candidateSource.baseSha || !body.candidateSource.sourceSha) {
        return fail('candidateSource.baseSha and candidateSource.sourceSha are required');
      }
      try {
        candidateSource = await git.validateCandidateSource(
          project.rootPath,
          body.candidateSource.baseSha,
          body.candidateSource.sourceSha,
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), 422);
      }
    }
    let visualQa;
    try {
      visualQa = body.visualQa?.scenarios
        ? {
            required: body.visualQa.required,
            scenarios: body.visualQa.scenarios.map((scenario, index) => {
              if (!scenario.name?.trim() || !isConfinedVisualRoute(scenario.route)) {
                throw new Error(`invalid visual QA scenario at index ${index}`);
              }
              if ((scenario.interactions?.length ?? 0) > 50) {
                throw new Error(`visual QA scenario ${scenario.name} exceeds 50 interactions`);
              }
              for (const [viewport, steps] of Object.entries(scenario.viewportInteractions ?? {})) {
                if (!['desktop', 'mobile'].includes(viewport) || !Array.isArray(steps)) {
                  throw new Error(`visual QA scenario ${scenario.name} has an invalid viewport`);
                }
                if ((steps?.length ?? 0) > 50) {
                  throw new Error(`visual QA scenario ${scenario.name} exceeds 50 interactions`);
                }
              }
              return {
                name: scenario.name.trim(),
                route: scenario.route,
                ...(scenario.viewports ? { viewports: scenario.viewports } : {}),
                ...(scenario.interactions
                  ? { interactions: scenario.interactions.map(parseVisualInteraction) }
                  : {}),
                ...(scenario.viewportInteractions
                  ? {
                      viewportInteractions: Object.fromEntries(
                        Object.entries(scenario.viewportInteractions).map(([viewport, steps]) => [
                          viewport,
                          steps?.map(parseVisualInteraction),
                        ]),
                      ),
                    }
                  : {}),
              };
            }),
          }
        : undefined;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const job = jarvis.jobs.create({
      projectId: body.projectId,
      request: body.request,
      acceptance: body.acceptance ?? [],
      sessionId: body.sessionId ?? null,
      ...(body.originMessageId ? { originMessageId: body.originMessageId } : {}),
      ...(candidateSource ? { candidateSource } : {}),
      validationOnly: body.validationOnly ?? false,
      ...(visualQa ? { visualQa } : {}),
    });
    if (body.autostart) jarvis.pipeline.start(job.id);
    return c.json(job, 201);
  });

  app.get('/api/jobs/:id', async (c) => {
    const job = jarvis.jobs.get(c.req.param('id'));
    if (!job) return fail('job not found', 404);
    const runs = jarvis.jobs.runs(job.id);
    const packIds = [...new Set(runs.map((r) => r.contextPackId).filter(Boolean))] as string[];
    const running = jarvis.pipeline.isRunning(job.id);
    const reviews = jarvis.review.list(job.id);
    const acceptanceError = candidateRejectionReason(
      jarvis.verification.latestReport(job.id),
      reviews.at(-1)?.verdict ?? 'error',
    );
    const terminal = ['paused', 'awaiting_user', 'completed', 'failed', 'cancelled'].includes(
      job.stage,
    );
    let candidate: Awaited<ReturnType<GitWorkspace['collectChanges']>> | null = null;
    if (
      (terminal || !running) &&
      job.worktreePath &&
      job.baseRef &&
      fs.existsSync(job.worktreePath)
    ) {
      candidate = await git.collectChanges(job.worktreePath, job.baseRef).catch(() => null);
    }
    return c.json({
      job,
      stages: PIPELINE_STAGES,
      running,
      acceptanceEligible: job.stage === 'awaiting_user' && !acceptanceError,
      acceptanceError,
      application: jarvis.applications.getForJob(job.id),
      upgrade: jarvis.upgrades.getForJob(job.id),
      routingDecisions: jarvis.agents.decisions(job.id),
      runs,
      candidate,
      verifications: jarvis.verification.list(job.id),
      reviews,
      visualQa: jarvis.visualQa.list(job.id),
      events: jarvis.bus.list({ jobId: job.id, limit: 400 }),
      episode: job.episodeId ? jarvis.memory.get(job.episodeId) : null,
      contextPacks: packIds.map((id) => jarvis.context.getPack(id)).filter(Boolean),
      project: jarvis.projects.get(job.projectId),
      // Resuming a candidate whose target has moved on is the failure mode this
      // surfaces before the button is ever pressed.
      staleness: job.stage === 'paused' ? await jarvis.lifecycle.staleness(job.id) : null,
      deletionPlan: jarvis.lifecycle.deletionPlan(job.id),
    });
  });

  app.post('/api/jobs/:id/start', (c) => {
    const job = jarvis.jobs.get(c.req.param('id'));
    if (!job) return fail('job not found', 404);
    if (job.stage !== 'queued') return fail(`job is already ${job.stage}`, 409);
    jarvis.pipeline.start(job.id);
    return c.json({ started: true });
  });

  /** Cancelling is `sensitive`: its effect is partial by nature, so it confirms. */
  app.post('/api/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.jobs.get(id)) return fail('job not found', 404);
    return c.json(await jarvis.tools.execute('job.cancel', { id }, { actor: 'user', jobId: id }));
  });

  app.post('/api/jobs/:id/resume', async (c) => {
    const id = c.req.param('id');
    const job = jarvis.jobs.get(id);
    if (!job) return fail('job not found', 404);
    if (job.stage !== 'paused') return fail(`job is ${job.stage}, not paused`, 409);
    const outcome = await jarvis.tools.execute('job.resume', { id }, { actor: 'user', jobId: id });
    return settled(outcome);
  });

  /** Why a paused Job may or may not be resumable right now. Read-only. */
  app.get('/api/jobs/:id/staleness', async (c) => {
    if (!jarvis.jobs.get(c.req.param('id'))) return fail('job not found', 404);
    return c.json(await jarvis.lifecycle.staleness(c.req.param('id')));
  });

  app.post('/api/jobs/:id/archive', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.jobs.get(id)) return fail('job not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    const outcome = await jarvis.tools.execute(
      'job.archive',
      { id, archived: body.archived ?? true },
      { actor: 'user', jobId: id },
    );
    return settled(outcome);
  });

  /** Run again: always a NEW Job on the current base, never a resurrected candidate. */
  app.post('/api/jobs/:id/retry', async (c) => {
    const id = c.req.param('id');
    const job = jarvis.jobs.get(id);
    if (!job) return fail('job not found', 404);
    const body = (await c.req.json().catch(() => ({}))) as { autostart?: unknown };
    const outcome = await jarvis.tools.execute(
      'job.retry',
      { id, autostart: body.autostart !== false },
      { actor: 'user', jobId: id, sessionId: job.sessionId },
    );
    return settled(outcome);
  });

  /** What deleting this Job would remove and preserve. Powers the confirmation. */
  app.get('/api/jobs/:id/deletion-plan', (c) => {
    if (!jarvis.jobs.get(c.req.param('id'))) return fail('job not found', 404);
    return c.json(jarvis.lifecycle.deletionPlan(c.req.param('id')));
  });

  app.delete('/api/jobs/:id', async (c) => {
    const id = c.req.param('id');
    if (!jarvis.jobs.get(id)) return fail('job not found', 404);
    return c.json(await jarvis.tools.execute('job.delete', { id }, { actor: 'user', jobId: id }));
  });

  const approveCandidate = async (jobId: string) => {
    try {
      return { application: await jarvis.applications.approve(jobId), error: null };
    } catch (error) {
      return { application: null, error: error instanceof Error ? error.message : String(error) };
    }
  };

  app.post('/api/jobs/:id/approve', async (c) => {
    const result = await approveCandidate(c.req.param('id'));
    return result.error ? fail(result.error, 409) : c.json(result.application);
  });

  /** Compatibility alias: acceptance now means approval, never Git mutation. */
  app.post('/api/jobs/:id/accept', async (c) => {
    const result = await approveCandidate(c.req.param('id'));
    return result.error ? fail(result.error, 409) : c.json(result.application);
  });

  app.post('/api/jobs/:id/apply', async (c) => {
    try {
      return c.json(await jarvis.applications.apply(c.req.param('id')));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/jobs/:id/upgrade/prepare', async (c) => {
    try {
      return c.json(await jarvis.upgrades.prepare(c.req.param('id')));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/jobs/:id/upgrade/activate', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { activationToken?: unknown };
      if (typeof body.activationToken !== 'string') return fail('activationToken is required', 400);
      return c.json(
        await jarvis.upgrades.requestActivation(c.req.param('id'), body.activationToken),
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  // ------------------------------------------------------------------ memory --
  app.get('/api/memory', (c) => {
    const q = c.req.query();
    if (q.scope && !MEMORY_SCOPES.has(q.scope as MemoryScope)) return fail('invalid scope');
    if (q.kind && !MEMORY_KINDS.has(q.kind as MemoryKind)) return fail('invalid kind');
    if (q.status && !MEMORY_STATUSES.has(q.status)) return fail('invalid status');
    const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? '100', 10) || 100));
    const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);
    return c.json(
      jarvis.memory.list({
        ...(q.scope ? { scope: q.scope as MemoryScope } : {}),
        ...(q.scopeId ? { scopeId: q.scopeId } : {}),
        ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
        ...(q.status
          ? {
              status: q.status as 'active' | 'superseded' | 'expired' | 'deleted' | 'all',
            }
          : {}),
        ...(q.search ? { search: q.search } : {}),
        limit,
        offset,
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
    if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1)) {
      return fail('limit must be a positive integer');
    }
    if (body.projectId && !jarvis.projects.get(body.projectId))
      return fail('project not found', 404);
    const results = await jarvis.memory.retrieve({
      query: body.query,
      scopes: [
        { scope: 'user', scopeId: null },
        ...(body.projectId ? [{ scope: 'project' as MemoryScope, scopeId: body.projectId }] : []),
      ],
      limit: Math.min(body.limit ?? 12, 50),
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
    const scope = body.scope ?? 'user';
    const kind = body.kind ?? 'fact';
    if (!MEMORY_SCOPES.has(scope)) return fail('invalid scope');
    if (!MEMORY_KINDS.has(kind)) return fail('invalid kind');
    if (scope !== 'user' && !body.scopeId) return fail(`${scope} scope requires scopeId`);
    if (scope === 'project' && !jarvis.projects.get(body.scopeId ?? '')) {
      return fail('project not found', 404);
    }
    if (
      body.importance !== undefined &&
      (!Number.isFinite(body.importance) || body.importance < 0 || body.importance > 1)
    ) {
      return fail('importance must be between 0 and 1');
    }
    const outcome = await jarvis.memory.remember({
      scope,
      scopeId: body.scopeId ?? null,
      kind,
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
    const body = (await c.req.json().catch(() => ({}))) as {
      pinned?: unknown;
      content?: unknown;
    };
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') return fail('pinned must be boolean');
      if (!jarvis.memory.setPinned(id, body.pinned)) return fail('memory not found', 404);
    }
    if (body.content !== undefined) {
      if (typeof body.content !== 'string' || !body.content.trim()) {
        return fail('content must be a non-empty string');
      }
      const outcome = await jarvis.memory.correct(id, body.content);
      return c.json(outcome, outcome.status === 'rejected' ? 422 : 200);
    }
    return c.json(jarvis.memory.get(id));
  });

  app.delete('/api/memory/:id', async (c) => {
    const hard = c.req.query('hard') === 'true';
    const id = c.req.param('id');
    if (hard) {
      if (!jarvis.memory.get(id)) return fail('memory not found', 404);
      return c.json(await jarvis.tools.execute('memory.purge', { id }, { actor: 'user' }));
    }
    if (!jarvis.memory.forget(id)) return fail('memory not found', 404);
    return c.json({ deleted: true, mode: 'soft' });
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
    if (!body.jobId && !body.projectId) return fail('jobId or projectId is required');
    const job = body.jobId ? jarvis.jobs.get(body.jobId) : null;
    if (body.jobId && !job) return fail('job not found', 404);
    const projectId = body.projectId ?? job?.projectId;
    if (!projectId || !jarvis.projects.get(projectId)) return fail('project not found', 404);
    if (job && job.projectId !== projectId) return fail('job/project mismatch', 409);
    try {
      const shots = await jarvis.visualQa.capture({
        projectId,
        ...(body.jobId ? { jobId: body.jobId } : {}),
        baseUrl: body.baseUrl,
        routes: body.routes?.length ? body.routes : ['/'],
      });
      return c.json(shots);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 422);
    }
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
    const type =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : 'text/plain';
    return new Response(fs.readFileSync(target) as unknown as BodyInit, {
      headers: { 'content-type': type },
    });
  });

  // ------------------------------------------------------------------- tools --
  // Everything below runs as actor `user`, hardcoded. The previous version read
  // the risk ceiling out of the request body, which meant any caller could name
  // its own privileges. A request may never influence the policy input: see
  // docs/tool-permissions.md for the trust boundary this does and does not buy.
  app.get('/api/tools', (c) => c.json(jarvis.tools.list('user')));
  app.get('/api/tools/capabilities', (c) =>
    c.json({ sensitiveAgentTools: agentIsolationPreflight() }),
  );

  app.post('/api/tools/:name', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      input?: unknown;
      sessionId?: string;
      projectId?: string;
      maxRisk?: string;
    };
    try {
      const outcome = await jarvis.tools.execute(c.req.param('name'), body.input ?? {}, {
        actor: 'user',
        sessionId: body.sessionId ?? null,
        projectId: body.projectId ?? null,
        // A caller may tighten its own ceiling; the policy ignores any attempt
        // to widen it, so this is safe to accept from the body.
        ...(RISK_LEVELS.includes(body.maxRisk as RiskLevel)
          ? { maxRisk: body.maxRisk as RiskLevel }
          : {}),
      });
      // A refusal is a successful policy evaluation, not an HTTP error: the
      // caller needs the recorded execution back to show why it was refused.
      return c.json(outcome);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 422);
    }
  });

  app.get('/api/tool-executions', (c) => {
    const status = c.req.query('status');
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json({
      pending: jarvis.tools.pending(),
      executions: jarvis.tools.executions({
        ...(status && status !== 'all' ? { status: status as ToolExecutionStatus } : {}),
        ...(c.req.query('toolName') ? { toolName: c.req.query('toolName') as string } : {}),
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    });
  });

  app.post('/api/tool-executions/:id/approve', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      remember?: boolean;
      projectId?: string | null;
      note?: string;
    };
    try {
      const outcome = await jarvis.tools.approve(c.req.param('id'), {
        ...(body.remember
          ? {
              remember: {
                projectId: body.projectId ?? null,
                note: body.note ?? 'approved from the tools view',
              },
            }
          : {}),
      });
      // A refusal is a successful policy evaluation, not an HTTP error: the
      // caller needs the recorded execution back to show why it was refused.
      return c.json(outcome);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/tool-executions/:id/deny', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    try {
      return c.json(jarvis.tools.deny(c.req.param('id'), body.reason || 'declined by the user'));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.post('/api/tool-executions/:id/retry', async (c) => {
    try {
      const outcome = await jarvis.tools.retry(c.req.param('id'));
      // A refusal is a successful policy evaluation, not an HTTP error: the
      // caller needs the recorded execution back to show why it was refused.
      return c.json(outcome);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  });

  app.get('/api/tool-grants', (c) => c.json(jarvis.tools.grants()));

  app.post('/api/tool-grants', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      toolName?: string;
      projectId?: string | null;
      note?: string;
      expiresAt?: string | null;
    };
    if (!body.toolName) return fail('toolName is required');
    if (!jarvis.tools.has(body.toolName)) return fail('unknown tool', 404);
    try {
      // Standing permissions are only ever granted to the user's own actions.
      // Delegating one to an agent is a separate, deliberate decision Jarvis
      // does not yet offer — see docs/tool-permissions.md.
      return c.json(
        jarvis.tools.grant({
          toolName: body.toolName,
          actor: 'user',
          projectId: body.projectId ?? null,
          note: body.note ?? null,
          expiresAt: body.expiresAt ?? null,
        }),
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 422);
    }
  });

  app.delete('/api/tool-grants/:id', (c) => {
    if (!jarvis.tools.revokeGrant(c.req.param('id'))) return fail('grant not found', 404);
    return c.json({ revoked: true });
  });

  app.get('/api/goal-preview', (c) => c.json({ goal: normaliseGoal(c.req.query('text') ?? '') }));

  return app;
}

function parseVisualInteraction(value: Record<string, unknown>): VisualInteraction {
  const action = value.action;
  if (action === 'goto' && isConfinedVisualRoute(value.route)) {
    return { action, route: value.route };
  }
  if (action === 'click' && typeof value.selector === 'string' && value.selector) {
    return { action, selector: value.selector };
  }
  if (
    action === 'fill' &&
    typeof value.selector === 'string' &&
    value.selector &&
    typeof value.value === 'string'
  ) {
    return { action, selector: value.selector, value: value.value };
  }
  if (action === 'wait') {
    if (value.selector !== undefined && typeof value.selector !== 'string') {
      throw new Error('visual wait selector must be a string');
    }
    if (value.timeoutMs !== undefined && typeof value.timeoutMs !== 'number') {
      throw new Error('visual wait timeoutMs must be a number');
    }
    return {
      action,
      ...(value.selector ? { selector: value.selector } : {}),
      ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}),
    };
  }
  if (action === 'screenshot') {
    if (value.name !== undefined && typeof value.name !== 'string') {
      throw new Error('visual screenshot name must be a string');
    }
    return { action, ...(typeof value.name === 'string' ? { name: value.name } : {}) };
  }
  throw new Error(`unsupported visual interaction action: ${String(action)}`);
}

function isConfinedVisualRoute(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) && !value.includes('\\');
}
