import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../../apps/orchestrator/src/routes.js';
import {
  CANDIDATE_FIXTURE_ENV,
  Jarvis,
  loadConfig,
  seedCandidateFixtures,
} from '../../packages/core/src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation project context routes', () => {
  it('records a failed cancellation when no pipeline is running', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-job-cancel-outcome-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({ ...base, memory: { ...base.memory, embeddingsEnabled: false } });
    try {
      const project = await jarvis.registerSelf();
      if (!project) throw new Error('self project missing');
      const job = jarvis.jobs.create({ projectId: project.id, request: 'stay queued' });
      const pending = await jarvis.tools.execute(
        'job.cancel',
        { id: job.id },
        { actor: 'user', jobId: job.id, projectId: project.id },
      );
      expect(pending.status).toBe('pending_approval');

      const resolved = await jarvis.tools.approve(pending.execution.id);
      expect(resolved).toMatchObject({ status: 'failed', error: 'job is not running' });
      expect(jarvis.jobs.get(job.id)?.status).toBe('pending');
    } finally {
      jarvis.close();
    }
  });

  it('returns authoritative current tool status with confirmation messages', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-execution-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({
      ...base,
      memory: { ...base.memory, embeddingsEnabled: false },
    });
    try {
      const project = await jarvis.registerSelf();
      if (!project) throw new Error('self project missing');
      seedCandidateFixtures(jarvis.db, {
        projectId: project.id,
        env: {
          JARVIS_CANDIDATE_RUNTIME: '1',
          [CANDIDATE_FIXTURE_ENV]: 'chat-workspace',
        } as NodeJS.ProcessEnv,
      });
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const app = createRoutes(jarvis);
      const detail = async () =>
        (await app
          .request('/api/conversations/session_qafixture_chat', {
            headers: { 'x-jarvis-control': credential },
          })
          .then((response) => response.json())) as {
          toolExecutions: Array<{ id: string; status: string }>;
        };

      for (const status of ['pending_approval', 'succeeded', 'denied', 'expired']) {
        jarvis.db
          .prepare('UPDATE tool_executions SET status=? WHERE id=?')
          .run(status, 'tex_qafixture_agent_confirmation');
        expect((await detail()).toolExecutions).toContainEqual(
          expect.objectContaining({ id: 'tex_qafixture_agent_confirmation', status }),
        );
      }
    } finally {
      jarvis.close();
    }
  });

  it('does not report success when a conversation mutation did not succeed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-outcome-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({ ...base, memory: { ...base.memory, embeddingsEnabled: false } });
    try {
      const project = await jarvis.registerSelf();
      if (!project) throw new Error('self project missing');
      seedCandidateFixtures(jarvis.db, {
        projectId: project.id,
        env: {
          JARVIS_CANDIDATE_RUNTIME: '1',
          [CANDIDATE_FIXTURE_ENV]: 'chat-workspace',
        } as NodeJS.ProcessEnv,
      });
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const app = createRoutes(jarvis);
      const before = jarvis.sessions.get('session_qafixture_chat')?.title;

      // Accepted by the route, rejected by the tool's own bounded schema: the
      // API must not answer 200 with a title the database never took.
      const response = await app.request('/api/conversations/session_qafixture_chat', {
        method: 'PATCH',
        headers: {
          'x-jarvis-control': credential,
          origin: base.controlOrigins[0] as string,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: 'x'.repeat(200) }),
      });

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain('rename');
      expect(jarvis.sessions.get('session_qafixture_chat')?.title).toBe(before);
    } finally {
      jarvis.close();
    }
  });

  it('rejects multi-field conversation patches before mutating anything', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-atomic-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({ ...base, memory: { ...base.memory, embeddingsEnabled: false } });
    try {
      const conversation = jarvis.sessions.current();
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const response = await createRoutes(jarvis).request(`/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          origin: base.controlOrigins[0] as string,
          'x-jarvis-control': credential,
        },
        body: JSON.stringify({ title: 'partially applied', pinned: true }),
      });

      expect(response.status).toBe(400);
      expect(jarvis.sessions.get(conversation.id)).toMatchObject({ title: null, pinned: false });
      expect(jarvis.tools.executions({ sessionId: conversation.id })).toHaveLength(0);
    } finally {
      jarvis.close();
    }
  });

  it('reports a refused project mutation instead of answering 200', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-outcome-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({ ...base, memory: { ...base.memory, embeddingsEnabled: false } });
    try {
      const project = await jarvis.registerSelf();
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      // An alias past the schema bound fails validation, so the tool outcome is
      // `failed`; answering 200 with it let the UI close and report success for
      // a write that never landed.
      const response = await createRoutes(jarvis).request(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          origin: base.controlOrigins[0] as string,
          'x-jarvis-control': credential,
        },
        body: JSON.stringify({ aliases: ['x'.repeat(200)] }),
      });

      expect(response.status).toBe(409);
      expect(jarvis.projects.get(project.id)?.aliases).not.toContain('x'.repeat(200));
    } finally {
      jarvis.close();
    }
  });

  it('never answers 200 for a single field that dispatched no mutation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-nodispatch-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({ ...base, memory: { ...base.memory, embeddingsEnabled: false } });
    try {
      const conversation = jarvis.sessions.current();
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const routes = createRoutes(jarvis);
      // One supported field, but nothing the route can act on: a blank title and
      // a wrongly-typed boolean both used to fall through every branch and still
      // answer 200 with the unchanged conversation, which reads as success.
      for (const body of [{ title: '   ' }, { pinned: 'true' }, { archived: 1 }]) {
        const response = await routes.request(`/api/conversations/${conversation.id}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            origin: base.controlOrigins[0] as string,
            'x-jarvis-control': credential,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(jarvis.sessions.get(conversation.id)).toMatchObject({ title: null, pinned: false });
      expect(jarvis.tools.executions({ sessionId: conversation.id })).toHaveLength(0);
    } finally {
      jarvis.close();
    }
  });

  it('uses conversation.set_project for current and compatibility APIs and rejects unknown projects', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conversation-project-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({
      ...base,
      memory: { ...base.memory, embeddingsEnabled: false },
    });
    try {
      const conversation = jarvis.sessions.current();
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const app = createRoutes(jarvis);
      const request = (url: string, body: unknown) =>
        app.request(url, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            origin: 'http://127.0.0.1:5199',
            'x-jarvis-control': credential,
          },
          body: JSON.stringify(body),
        });

      const updated = await request(`/api/conversations/${conversation.id}`, { projectId: null });
      expect(updated.status).toBe(200);
      expect(jarvis.tools.executions({ toolName: 'conversation.set_project' })[0]).toMatchObject({
        actor: 'user',
        originatingActor: 'user',
        status: 'succeeded',
        sessionId: conversation.id,
        input: { id: conversation.id, projectId: null },
      });

      const command = await app.request('/api/command', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:5199',
          'x-jarvis-control': credential,
        },
        body: JSON.stringify({
          text: 'remember that compatibility context is audited',
          sessionId: conversation.id,
          projectId: null,
        }),
      });
      expect(command.status).toBe(200);
      expect(jarvis.tools.executions({ toolName: 'conversation.set_project' })).toHaveLength(2);

      const invalid = await request(`/api/conversations/${conversation.id}`, {
        projectId: 'prj_missing',
      });
      expect(invalid.status).toBe(404);
      expect(jarvis.sessions.get(conversation.id)?.projectId).toBeNull();

      const invalidCommand = await app.request('/api/command', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:5199',
          'x-jarvis-control': credential,
        },
        body: JSON.stringify({
          text: 'remember that invalid context stays rejected',
          sessionId: conversation.id,
          projectId: 'prj_missing',
        }),
      });
      expect(invalidCommand.status).toBe(404);
      expect(jarvis.sessions.get(conversation.id)?.projectId).toBeNull();

      const invalidTool = await jarvis.tools.execute(
        'conversation.set_project',
        { id: conversation.id, projectId: 'prj_missing' },
        { actor: 'user', sessionId: conversation.id, projectId: 'prj_missing' },
      );
      expect(invalidTool.status).toBe('failed');
      expect(jarvis.sessions.get(conversation.id)?.projectId).toBeNull();
    } finally {
      jarvis.close();
    }
  });
});
