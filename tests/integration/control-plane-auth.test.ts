import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspace, Jarvis, loadConfig, nowIso } from '../../packages/core/src/index.js';
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
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# control plane fixture\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    const origin = 'http://127.0.0.1:5199';
    const jarvis = new Jarvis(loadConfig({ home, controlOrigins: [origin] }));
    open.push(jarvis);
    jarvis.db
      .prepare(
        `INSERT INTO projects
        (id,name,root_path,default_branch,stack,commands,is_self,config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('prj_known', 'known', repo, 'main', '{}', '{}', 0, '{}', 'now', 'now');
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
    jarvis.jobs.transition(job.id, 'planning');
    const workspace = new GitWorkspace(jarvis.config.worktreesDir);
    const worktree = await workspace.createWorktree({ repoRoot: repo, jobId: job.id });
    fs.writeFileSync(path.join(worktree.path, 'candidate.txt'), 'reviewed\n');
    const head = await workspace.commitPending(worktree.path, 'candidate');
    if (!head) throw new Error('candidate fixture commit missing');
    jarvis.jobs.patch(job.id, {
      branch: worktree.branch,
      worktreePath: worktree.path,
      baseRef: worktree.baseRef,
      headRef: head,
      reviewedHead: head,
    });
    jarvis.jobs.transition(job.id, 'implementing');
    jarvis.jobs.transition(job.id, 'verifying');
    jarvis.db
      .prepare(
        `INSERT INTO verifications
          (id,job_id,cycle,name,command,cwd,exit_code,status,output,duration_ms,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('ver_known', job.id, 0, 'test', 'fixture', worktree.path, 0, 'passed', '', 1, nowIso());
    jarvis.jobs.transition(job.id, 'reviewing');
    jarvis.db
      .prepare(
        `INSERT INTO reviews
          (id,job_id,provider,verdict,summary,findings,head_ref,blocking,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run('rev_known', job.id, 'fixture', 'approve', 'approved', '[]', head, 0, nowIso());
    jarvis.jobs.transition(job.id, 'awaiting_user');
    const approved = await raw(`/api/jobs/${job.id}/approve`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()) as { status: string }).toMatchObject({ status: 'approved' });
    const applied = await raw(`/api/jobs/${job.id}/apply`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(applied.status).toBe(200);
    expect((await applied.json()) as { status: string }).toMatchObject({ status: 'applied' });

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

describe('candidate-runtime Visual QA authority', () => {
  /** Serve a Jarvis instance and return a fetch bound to it. */
  async function servedRoutes(jarvis: Jarvis) {
    const server = serve({ fetch: createRoutes(jarvis).fetch, port: 0, hostname: '127.0.0.1' });
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return (route: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}${route}`, init);
  }

  function newHome(prefix: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    homes.push(home);
    return home;
  }

  it('authenticates only its own isolated runtime and never the real control plane', async () => {
    // The real Jarvis: paired with a browser credential the candidate never sees.
    const realOrigin = 'http://127.0.0.1:5199';
    const real = new Jarvis(
      loadConfig({ home: newHome('jarvis-real-'), controlOrigins: [realOrigin] }),
    );
    open.push(real);
    const realCredential = real.control.pair(real.control.createBootstrap());
    if (!realCredential) throw new Error('real pairing fixture failed');
    const realFetch = await servedRoutes(real);

    // The candidate runtime: isolated home, seeded from ephemeral QA material only.
    const qaCredential = randomBytes(32).toString('base64url');
    const candidateOrigin = 'http://127.0.0.1:41999';
    const candidate = new Jarvis(
      loadConfig({ home: newHome('jarvis-candidate-'), controlOrigins: [candidateOrigin] }),
    );
    open.push(candidate);
    expect(
      candidate.control.initCandidateVisualQa({
        JARVIS_CANDIDATE_RUNTIME: '1',
        JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: createHash('sha256')
          .update(qaCredential, 'utf8')
          .digest('hex'),
      }),
    ).toBe(true);
    const candidateFetch = await servedRoutes(candidate);

    // The candidate UI is authenticated against its own runtime.
    expect(
      await (
        await candidateFetch('/api/auth/status', { headers: { 'x-jarvis-control': qaCredential } })
      ).json(),
    ).toMatchObject({ authenticated: true });
    expect(
      (
        await candidateFetch('/api/projects', {
          headers: { 'x-jarvis-control': qaCredential },
        })
      ).status,
    ).toBe(200);
    // And its mutations still require its own exact configured origin.
    expect(
      (
        await candidateFetch('/api/tool-grants', {
          method: 'POST',
          headers: { 'x-jarvis-control': qaCredential, 'content-type': 'application/json' },
          body: JSON.stringify({ toolName: 'memory.store' }),
        })
      ).status,
    ).toBe(403);

    // The candidate credential is worthless against the real control plane.
    expect(
      (await realFetch('/api/projects', { headers: { 'x-jarvis-control': qaCredential } })).status,
    ).toBe(401);
    expect(
      (
        await realFetch('/api/tool-grants', {
          method: 'POST',
          headers: {
            'x-jarvis-control': qaCredential,
            origin: realOrigin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ toolName: 'memory.store' }),
        })
      ).status,
    ).toBe(401);
    // And the real credential is not copied into candidate state either.
    expect(
      (await candidateFetch('/api/projects', { headers: { 'x-jarvis-control': realCredential } }))
        .status,
    ).toBe(401);
    const candidateRow = candidate.db
      .prepare("SELECT credential_hash AS hash FROM human_control WHERE id='primary'")
      .get() as { hash: string };
    const realRow = real.db
      .prepare("SELECT credential_hash AS hash FROM human_control WHERE id='primary'")
      .get() as { hash: string };
    expect(candidateRow.hash).not.toBe(realRow.hash);
    expect(candidateRow.hash).not.toContain(realCredential);
  });

  it('leaves a real unpaired Jarvis locked to the pairing UI', async () => {
    const jarvis = new Jarvis(loadConfig({ home: newHome('jarvis-unpaired-') }));
    open.push(jarvis);
    // Candidate material present but the runtime flag is not: nothing is seeded.
    expect(
      jarvis.control.initCandidateVisualQa({
        JARVIS_CANDIDATE_QA_CREDENTIAL_HASH: 'a'.repeat(64),
      }),
    ).toBe(false);
    const request = await servedRoutes(jarvis);
    expect(await (await request('/api/auth/status')).json()).toEqual({
      authenticated: false,
      paired: false,
    });
    expect((await request('/api/projects')).status).toBe(401);
  });
});
