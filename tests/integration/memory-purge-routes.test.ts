import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { Jarvis, loadConfig, type ToolExecutionOutcome } from '../../packages/core/src/index.js';
import { createRoutes } from '../../apps/orchestrator/src/routes.js';

const open: Jarvis[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const jarvis of open.splice(0)) jarvis.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-purge-api-'));
  roots.push(home);
  const base = loadConfig({ home });
  const jarvis = new Jarvis({
    ...base,
    memory: { ...base.memory, embeddingsEnabled: false },
  });
  open.push(jarvis);
  return { jarvis, app: createRoutes(jarvis), home };
}

async function store(jarvis: Jarvis, scopeId: string | null, content: string) {
  const outcome = await jarvis.memory.remember({
    scope: scopeId ? 'project' : 'user',
    scopeId,
    kind: 'fact',
    content,
    sourceType: 'user_explicit',
    explicit: true,
  });
  if (outcome.status !== 'stored') throw new Error(`memory was not stored: ${outcome.status}`);
  return outcome.memory;
}

async function approve(app: ReturnType<typeof createRoutes>, id: string) {
  const response = await app.request(`/api/tool-executions/${id}/approve`, { method: 'POST' });
  expect(response.status).toBe(200);
  return (await response.json()) as ToolExecutionOutcome;
}

describe('destructive memory HTTP routes', () => {
  it('hard-purges one memory only after ToolRegistry approval', async () => {
    const { jarvis, app } = setup();
    const memory = await store(jarvis, null, 'permanent test memory');

    const response = await app.request(`/api/memory/${memory.id}?hard=true`, {
      method: 'DELETE',
    });
    const requested = (await response.json()) as ToolExecutionOutcome;
    expect(response.status).toBe(200);
    expect(requested.status).toBe('pending_approval');
    if (requested.status !== 'pending_approval') return;
    expect(jarvis.memory.get(memory.id)).not.toBeNull();
    expect(requested.execution).toMatchObject({
      toolName: 'memory.purge',
      risk: 'destructive',
      actor: 'user',
      status: 'pending_approval',
      input: { id: memory.id },
    });

    const approved = await approve(app, requested.execution.id);
    expect(approved.status).toBe('succeeded');
    expect(jarvis.memory.get(memory.id)).toBeNull();
    expect(jarvis.tools.getExecution(requested.execution.id)).toMatchObject({
      status: 'succeeded',
      approvedBy: 'user',
    });
  });

  it('purges only the requested project after ToolRegistry approval', async () => {
    const { jarvis, app, home } = setup();
    const firstRoot = path.join(home, 'first');
    const secondRoot = path.join(home, 'second');
    fs.mkdirSync(firstRoot);
    fs.mkdirSync(secondRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: firstRoot });
    execFileSync('git', ['init', '--quiet'], { cwd: secondRoot });
    const first = await jarvis.projects.register({ rootPath: firstRoot, name: 'first' });
    const second = await jarvis.projects.register({ rootPath: secondRoot, name: 'second' });
    const target = await Promise.all([
      store(jarvis, first.id, 'first project memory one'),
      store(jarvis, first.id, 'first project memory two'),
    ]);
    const unrelated = await store(jarvis, second.id, 'second project memory');

    const response = await app.request(`/api/projects/${first.id}/memory`, { method: 'DELETE' });
    const requested = (await response.json()) as ToolExecutionOutcome;
    expect(response.status).toBe(200);
    expect(requested.status).toBe('pending_approval');
    if (requested.status !== 'pending_approval') return;
    for (const memory of [...target, unrelated])
      expect(jarvis.memory.get(memory.id)).not.toBeNull();
    expect(requested.execution).toMatchObject({
      toolName: 'memory.purge_project',
      risk: 'destructive',
      actor: 'user',
      projectId: first.id,
      status: 'pending_approval',
      input: { projectId: first.id },
    });

    const approved = await approve(app, requested.execution.id);
    expect(approved.status).toBe('succeeded');
    for (const memory of target) expect(jarvis.memory.get(memory.id)).toBeNull();
    expect(jarvis.memory.get(unrelated.id)).not.toBeNull();
    expect(jarvis.tools.getExecution(requested.execution.id)).toMatchObject({
      status: 'succeeded',
      approvedBy: 'user',
    });
  });

  it('refuses standing grants for both destructive purge tools', async () => {
    const { app } = setup();
    for (const toolName of ['memory.purge', 'memory.purge_project']) {
      const response = await app.request('/api/tool-grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/cannot be remembered/),
      });
    }
  });
});
