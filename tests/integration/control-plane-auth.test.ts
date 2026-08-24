import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { Jarvis, loadConfig } from '../../packages/core/src/index.js';
import { createRoutes } from '../../apps/orchestrator/src/routes.js';

const homes: string[] = [];
const servers: Server[] = [];
const open: Jarvis[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const jarvis of open.splice(0)) jarvis.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('hostile loopback control-plane client', () => {
  it('rejects every private read and human-authority mutation, then permits a paired client', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-control-plane-'));
    homes.push(home);
    const origin = 'http://127.0.0.1:5199';
    const jarvis = new Jarvis(loadConfig({ home, controlOrigins: [origin] }));
    open.push(jarvis);
    jarvis.db
      .prepare(
        `INSERT INTO projects
        (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('prj_known', 'known', home, 'main', '{}', '{}', 0, '{}', 'now', 'now');
    const job = jarvis.jobs.create({ projectId: 'prj_known', request: 'known hostile target' });
    const pending = await jarvis.tools.execute(
      'memory.purge',
      { id: 'mem_known' },
      { actor: 'user', projectId: 'prj_known' },
    );
    if (pending.status !== 'pending_approval') throw new Error('pending fixture missing');
    const existingGrant = jarvis.tools.grant({
      toolName: 'memory.store',
      actor: 'user',
      projectId: 'prj_known',
    });
    const bootstrap = jarvis.control.createBootstrap();
    const app = createRoutes(jarvis);
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('control-plane test did not bind');
    const raw = (route: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}${route}`, init);

    const privateReads = [
      '/api/projects',
      '/api/jobs',
      `/api/jobs/${job.id}`,
      '/api/memory',
      '/api/events',
      '/api/tool-executions',
      '/api/tool-grants',
    ];
    for (const route of privateReads) {
      expect((await raw(route)).status, route).toBe(401);
    }

    const attacks: Array<[string, string, unknown?]> = [
      ['POST', `/api/jobs/${job.id}/approve`],
      ['POST', `/api/jobs/${job.id}/apply`],
      ['POST', `/api/jobs/${job.id}/upgrade/prepare`],
      ['POST', `/api/jobs/${job.id}/upgrade/activate`],
      ['POST', `/api/tool-executions/${pending.execution.id}/approve`, {}],
      ['POST', `/api/tool-executions/${pending.execution.id}/deny`, {}],
      ['POST', `/api/tool-executions/${pending.execution.id}/retry`, {}],
      ['POST', '/api/tool-grants', { toolName: 'memory.store', projectId: 'prj_known' }],
      ['DELETE', `/api/tool-grants/${existingGrant.id}`],
      ['POST', '/api/tools/memory.store', { input: { scope: 'user', content: 'hostile' } }],
    ];
    for (const [method, route, body] of attacks) {
      const response = await raw(route, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${route}`).toBe(401);
    }
    expect(
      (
        await raw('/api/auth/pair', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ bootstrap: 'not-the-bootstrap' }),
        })
      ).status,
    ).toBe(401);

    const pairing = await raw('/api/auth/pair', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap }),
    });
    expect(pairing.status).toBe(200);
    const credential = ((await pairing.json()) as { credential: string }).credential;
    const readHeaders = { 'x-jarvis-control': credential };
    const mutationHeaders = {
      ...readHeaders,
      origin,
      'content-type': 'application/json',
    };
    expect(
      (
        await raw('/api/tool-grants', {
          method: 'POST',
          headers: { ...readHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ toolName: 'memory.store' }),
        })
      ).status,
    ).toBe(403);
    expect((await raw('/api/projects', { headers: readHeaders })).status).toBe(200);
    for (const traversal of [
      '..\\..\\escape',
      '../../escape',
      '..%2f..%2fescape',
      '..\\../escape',
    ]) {
      expect(
        (
          await raw('/api/visual-qa', {
            method: 'POST',
            headers: mutationHeaders,
            body: JSON.stringify({ jobId: traversal, baseUrl: 'http://127.0.0.1:1' }),
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await raw('/api/tools/memory.search', {
          method: 'POST',
          headers: mutationHeaders,
          body: JSON.stringify({ input: { query: 'nothing' } }),
        })
      ).status,
    ).toBe(200);
    const createdGrant = await raw('/api/tool-grants', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ toolName: 'memory.store', projectId: 'prj_known' }),
    });
    expect(createdGrant.status).toBe(200);
    const grant = (await createdGrant.json()) as { id: string };
    expect(
      (
        await raw(`/api/tool-grants/${grant.id}`, {
          method: 'DELETE',
          headers: mutationHeaders,
        })
      ).status,
    ).toBe(200);
    // Authentication succeeds before domain preconditions are evaluated.
    expect(
      (
        await raw(`/api/jobs/${job.id}/approve`, {
          method: 'POST',
          headers: mutationHeaders,
        })
      ).status,
    ).toBe(409);

    expect(jarvis.tools.getExecution(pending.execution.id)?.status).toBe('pending_approval');
    expect(jarvis.tools.getGrant(existingGrant.id)?.revokedAt).toBeNull();
    expect(
      (
        await raw(`/api/tool-executions/${pending.execution.id}/approve`, {
          method: 'POST',
          headers: mutationHeaders,
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(jarvis.tools.getExecution(pending.execution.id)?.status).toBe('succeeded');
  });
});
