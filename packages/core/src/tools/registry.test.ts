import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { ToolPermissionError, ToolRegistry } from './registry.js';
import type { RiskLevel } from './policy.js';

const homes: string[] = [];
let db: Db;
let bus: EventBus;

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-'));
  homes.push(home);
  db = openDb(loadConfig({ home }));
  bus = new EventBus(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // Closed by a test that asserted restart behaviour.
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function registry(overrides: { approvalTtlMs?: number; maxRecordChars?: number } = {}) {
  return new ToolRegistry({ db, bus, defaultTimeoutMs: 500, ...overrides });
}

/** A tool whose calls are observable, so "did it actually run?" is testable. */
function counter(name: string, risk: RiskLevel = 'observe') {
  const calls: unknown[] = [];
  return {
    calls,
    tool: {
      name,
      description: name,
      risk,
      input: z.object({ text: z.string().min(1) }),
      execute: async (input: { text: string }) => {
        calls.push(input);
        return `ran:${input.text}`;
      },
    },
  };
}

describe('tool catalog', () => {
  it('exposes a JSON schema and the decision the policy would take', () => {
    const reg = registry();
    reg.register({
      name: 'demo.schema',
      description: 'demo',
      risk: 'sensitive',
      input: z.object({ id: z.string() }),
      execute: async () => null,
    });
    const [listed] = reg.list('user');
    expect(listed?.name).toBe('demo.schema');
    expect(JSON.stringify(listed?.schema)).toContain('id');
    expect(listed?.decision).toBe('confirm');
    expect(reg.list('agent')[0]?.decision).toBe('deny');
  });

  it('refuses to register the same name twice', () => {
    const reg = registry();
    const { tool } = counter('demo.dup');
    reg.register(tool);
    expect(() => reg.register(tool)).toThrow(/already registered/);
  });

  it('throws on an unknown tool', async () => {
    await expect(registry().execute('nope', {}, { actor: 'user' })).rejects.toThrow(/unknown tool/);
  });

  it('hands out no way to reach a tool implementation behind the policy', () => {
    const reg = registry() as unknown as Record<string, unknown>;
    // The catalog is a private field. If a future refactor adds an accessor that
    // returns a ToolDefinition, the whole permission layer becomes optional.
    expect(Object.keys(reg)).toEqual([]);
    expect(
      Object.getOwnPropertyNames(ToolRegistry.prototype).filter((key) =>
        ['get', 'resolve', 'definition', 'tools'].includes(key),
      ),
    ).toEqual([]);
  });
});

describe('tool execution and gating', () => {
  it('runs an allowed tool and records the audit row', async () => {
    const reg = registry();
    const { tool, calls } = counter('demo.echo');
    reg.register(tool);

    const outcome = await reg.execute('demo.echo', { text: 'hi' }, { actor: 'user' });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.result).toBe('ran:hi');
    expect(calls).toHaveLength(1);

    const stored = reg.getExecution(outcome.execution.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.decision).toBe('allow');
    expect(stored?.input).toEqual({ text: 'hi' });
    expect(stored?.result).toBe('ran:hi');
    expect(stored?.durationMs).not.toBeNull();
  });

  it('denies without running, and records the attempt', async () => {
    const reg = registry();
    const { tool, calls } = counter('danger.delete', 'destructive');
    reg.register(tool);

    const outcome = await reg.execute('danger.delete', { text: 'x' }, { actor: 'agent' });
    expect(outcome.status).toBe('denied');
    expect(calls).toEqual([]);
    expect(reg.executions({ status: 'denied' })).toHaveLength(1);
    expect(reg.executions({ status: 'denied' })[0]?.actor).toBe('agent');
  });

  it('refuses a tool above the caller ceiling', async () => {
    const reg = registry();
    reg.register({
      name: 'danger.ceiling',
      description: 'deletes things',
      risk: 'destructive',
      input: z.object({}),
      execute: async () => 'deleted',
    });
    const outcome = await reg.execute('danger.ceiling', {}, { actor: 'user', maxRisk: 'observe' });
    expect(outcome.status).toBe('denied');
    if (outcome.status !== 'denied') return;
    expect(outcome.error).toMatch(/ceiling/);
  });

  it('validates input against the schema before executing', async () => {
    const reg = registry();
    const { tool, calls } = counter('demo.validate');
    reg.register(tool);

    const bad = await reg.execute('demo.validate', { text: 123 }, { actor: 'user' });
    expect(bad.status).toBe('failed');
    if (bad.status !== 'failed') return;
    expect(bad.error).toMatch(/invalid input/);
    expect(calls).toEqual([]);
    // An unvalidated payload is audit text, never replayable.
    expect(bad.execution.inputValidated).toBe(false);
    await expect(reg.retry(bad.execution.id)).rejects.toThrow(ToolPermissionError);
  });

  it('refuses arguments that contain a credential', async () => {
    const reg = registry();
    const { tool, calls } = counter('demo.secret');
    reg.register(tool);

    const outcome = await reg.execute(
      'demo.secret',
      { text: 'token ghp_abcdefghijklmnopqrstuvwxyz01' },
      { actor: 'user' },
    );
    expect(outcome.status).toBe('denied');
    expect(calls).toEqual([]);
    const [row] = reg.executions({ status: 'denied' });
    expect(row?.reason).toBe('secret_in_input');
    // Nothing resembling the credential reached the database.
    expect(JSON.stringify(row)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz01');
  });

  it('refuses arguments too large to store faithfully instead of truncating them', async () => {
    const reg = registry({ maxRecordChars: 64 });
    const { tool, calls } = counter('demo.big');
    reg.register(tool);
    const outcome = await reg.execute('demo.big', { text: 'x'.repeat(200) }, { actor: 'user' });
    expect(outcome.status).toBe('denied');
    expect(calls).toEqual([]);
    expect(reg.executions({ status: 'denied' })[0]?.reason).toBe('input_too_large');
  });

  it('redacts a credential a tool returns before storing it', async () => {
    const reg = registry();
    reg.register({
      name: 'demo.leaky',
      description: 'returns something it should not',
      risk: 'observe',
      input: z.object({}),
      execute: async () => ({ note: 'key sk-ant-abcdefghijklmnopqrstuvwxyz' }),
    });
    const outcome = await reg.execute('demo.leaky', {}, { actor: 'user' });
    expect(outcome.status).toBe('succeeded');
    const stored = reg.executions({ toolName: 'demo.leaky' })[0];
    expect(JSON.stringify(stored?.result)).toContain('[redacted:anthropic_api_key]');
  });

  it('records a thrown tool error instead of propagating it', async () => {
    const reg = registry();
    reg.register({
      name: 'demo.throws',
      description: 'always fails',
      risk: 'observe',
      input: z.object({}),
      execute: async () => {
        throw new Error('upstream exploded');
      },
    });
    const outcome = await reg.execute('demo.throws', {}, { actor: 'user' });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toBe('upstream exploded');
    expect(reg.getExecution(outcome.execution.id)?.status).toBe('failed');
  });

  it('gives up on a tool that never settles', async () => {
    const reg = new ToolRegistry({ db, bus, defaultTimeoutMs: 20 });
    reg.register({
      name: 'demo.hangs',
      description: 'never returns',
      risk: 'observe',
      input: z.object({}),
      execute: () => new Promise(() => undefined),
    });
    const outcome = await reg.execute('demo.hangs', {}, { actor: 'user' });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toMatch(/timed out after 20ms/);
  });
});

describe('confirmation and approval', () => {
  it('parks a sensitive action until the user answers, then runs the stored input', async () => {
    const reg = registry();
    const { tool, calls } = counter('mail.send', 'sensitive');
    reg.register(tool);

    const requested = await reg.execute('mail.send', { text: 'hello' }, { actor: 'user' });
    expect(requested.status).toBe('pending_approval');
    if (requested.status !== 'pending_approval') return;
    expect(calls).toEqual([]);
    expect(reg.pending()).toHaveLength(1);

    const approved = await reg.approve(requested.execution.id);
    expect(approved.status).toBe('succeeded');
    expect(calls).toEqual([{ text: 'hello' }]);
    expect(reg.getExecution(requested.execution.id)?.approvedBy).toBe('user');
    expect(reg.pending()).toEqual([]);
  });

  it('cannot approve the same request twice', async () => {
    const reg = registry();
    const { tool, calls } = counter('mail.twice', 'sensitive');
    reg.register(tool);
    const requested = await reg.execute('mail.twice', { text: 'once' }, { actor: 'user' });
    if (requested.status !== 'pending_approval') throw new Error('expected a pending request');

    await reg.approve(requested.execution.id);
    await expect(reg.approve(requested.execution.id)).rejects.toThrow(ToolPermissionError);
    expect(calls).toHaveLength(1);
  });

  it('records a denial without running the tool', async () => {
    const reg = registry();
    const { tool, calls } = counter('mail.denied', 'sensitive');
    reg.register(tool);
    const requested = await reg.execute('mail.denied', { text: 'nope' }, { actor: 'user' });
    if (requested.status !== 'pending_approval') throw new Error('expected a pending request');

    const denied = reg.deny(requested.execution.id, 'not now');
    expect(denied.status).toBe('denied');
    expect(denied.error).toBe('not now');
    expect(calls).toEqual([]);
    await expect(reg.approve(requested.execution.id)).rejects.toThrow(/not awaiting approval/);
  });

  it('re-decides against the tool as it is now, not as it was when requested', async () => {
    const reg = registry();
    const { tool } = counter('agent.reclassified', 'reversible_modification');
    reg.register(tool);
    // An agent asking for a reversible change is a confirm, not an allow.
    const requested = await reg.execute('agent.reclassified', { text: 'x' }, { actor: 'agent' });
    expect(requested.status).toBe('pending_approval');
    if (requested.status !== 'pending_approval') return;

    // The tool is re-classified as destructive before anyone answers — as it
    // would be by a code change plus a restart. The stale request must not be
    // approvable at the old risk level, and the risk column on the row (which a
    // tamperer controls) must not be what the decision reads.
    db.prepare("UPDATE tool_executions SET risk='observe' WHERE id=?").run(requested.execution.id);
    const reopened = new ToolRegistry({ db, bus });
    const { tool: harder, calls } = counter('agent.reclassified', 'destructive');
    reopened.register(harder);

    const outcome = await reopened.approve(requested.execution.id);
    expect(outcome.status).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('refuses to approve a request whose stored arguments no longer validate', async () => {
    const reg = registry();
    const { tool, calls } = counter('mail.tampered', 'sensitive');
    reg.register(tool);
    const requested = await reg.execute('mail.tampered', { text: 'ok' }, { actor: 'user' });
    if (requested.status !== 'pending_approval') throw new Error('expected a pending request');

    db.prepare('UPDATE tool_executions SET input=? WHERE id=?').run(
      JSON.stringify({ text: '' }),
      requested.execution.id,
    );
    const outcome = await reg.approve(requested.execution.id);
    expect(outcome.status).toBe('failed');
    expect(calls).toEqual([]);
  });
});

describe('standing permissions', () => {
  it('turns a confirm into an allow for the granted context only', async () => {
    const reg = registry();
    const { tool, calls } = counter('calendar.write', 'sensitive');
    reg.register(tool);
    reg.grant({ toolName: 'calendar.write', actor: 'user', projectId: 'prj_a' });

    const granted = await reg.execute(
      'calendar.write',
      { text: 'a' },
      { actor: 'user', projectId: 'prj_a' },
    );
    expect(granted.status).toBe('succeeded');

    const other = await reg.execute(
      'calendar.write',
      { text: 'b' },
      { actor: 'user', projectId: 'prj_b' },
    );
    expect(other.status).toBe('pending_approval');

    const noProject = await reg.execute('calendar.write', { text: 'c' }, { actor: 'user' });
    expect(noProject.status).toBe('pending_approval');
    expect(calls).toEqual([{ text: 'a' }]);
  });

  it('never lets a grant give an agent a sensitive tool', async () => {
    const reg = registry();
    const { tool, calls } = counter('calendar.agent', 'sensitive');
    reg.register(tool);
    reg.grant({ toolName: 'calendar.agent', actor: 'agent' });

    const outcome = await reg.execute('calendar.agent', { text: 'a' }, { actor: 'agent' });
    expect(outcome.status).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('never lets a destructive tool be remembered as always-allow', async () => {
    const reg = registry();
    const { tool } = counter('memory.nuke', 'destructive');
    reg.register(tool);
    expect(() => reg.grant({ toolName: 'memory.nuke', actor: 'user' })).toThrow(
      /cannot be remembered/,
    );

    const outcome = await reg.execute('memory.nuke', { text: 'a' }, { actor: 'user' });
    expect(outcome.status).toBe('pending_approval');
    if (outcome.status !== 'pending_approval') return;

    // ...and it cannot be smuggled in on the way through an approval either.
    await expect(
      reg.approve(outcome.execution.id, { remember: { projectId: null } }),
    ).rejects.toThrow(/cannot be remembered/);
    // The refused approval must not have left the row stranded as running.
    expect(reg.getExecution(outcome.execution.id)?.status).toBe('pending_approval');
  });

  it('honours a grant row that predates a tool being re-classified as destructive', async () => {
    const reg = registry();
    const { tool } = counter('mail.escalates', 'sensitive');
    reg.register(tool);
    reg.grant({ toolName: 'mail.escalates', actor: 'user' });

    // The same tool, now destructive — as a code change plus a restart leaves it.
    const after = new ToolRegistry({ db, bus });
    const { tool: harder, calls } = counter('mail.escalates', 'destructive');
    after.register(harder);
    const outcome = await after.execute('mail.escalates', { text: 'a' }, { actor: 'user' });
    expect(outcome.status).toBe('pending_approval');
    expect(calls).toEqual([]);
  });

  it('stops honouring a revoked or expired grant', async () => {
    const reg = registry();
    const { tool } = counter('calendar.revoke', 'sensitive');
    reg.register(tool);

    const grant = reg.grant({ toolName: 'calendar.revoke', actor: 'user' });
    expect((await reg.execute('calendar.revoke', { text: 'a' }, { actor: 'user' })).status).toBe(
      'succeeded',
    );
    expect(reg.revokeGrant(grant.id)).toBe(true);
    expect(reg.revokeGrant(grant.id)).toBe(false);
    expect((await reg.execute('calendar.revoke', { text: 'b' }, { actor: 'user' })).status).toBe(
      'pending_approval',
    );
    expect(reg.grants()).toEqual([]);

    reg.grant({
      toolName: 'calendar.revoke',
      actor: 'user',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await reg.execute('calendar.revoke', { text: 'c' }, { actor: 'user' })).status).toBe(
      'pending_approval',
    );
  });

  it('refuses a grant for a tool that does not exist', () => {
    expect(() => registry().grant({ toolName: 'ghost.tool', actor: 'user' })).toThrow(
      /unknown tool/,
    );
  });
});

describe('recovery after restart', () => {
  it('marks running executions interrupted and expires stale approval requests', async () => {
    const reg = registry({ approvalTtlMs: 1000 });
    const { tool } = counter('mail.stale', 'sensitive');
    reg.register(tool);
    const pending = await reg.execute('mail.stale', { text: 'old' }, { actor: 'user' });
    if (pending.status !== 'pending_approval') throw new Error('expected a pending request');

    // A row left behind by a process that died mid-action.
    db.prepare(
      `INSERT INTO tool_executions
         (id, tool_name, risk, actor, decision, status, reason, input, requested_at, started_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'tex_crashed',
      'mail.stale',
      'sensitive',
      'user',
      'allow',
      'running',
      'standing permission for this context',
      JSON.stringify({ text: 'in flight' }),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const recovered = reg.recoverInterrupted(Date.now() + 5000);
    expect(recovered).toEqual({ interrupted: 1, expired: 1 });
    expect(reg.getExecution('tex_crashed')?.status).toBe('interrupted');
    expect(reg.getExecution('tex_crashed')?.error).toMatch(/effect is unknown/);
    expect(reg.getExecution(pending.execution.id)?.status).toBe('expired');
    expect(reg.recoverInterrupted(Date.now() + 5000)).toEqual({ interrupted: 0, expired: 0 });
  });

  it('never replays an interrupted action by itself, but lets the user re-issue it', async () => {
    const reg = registry();
    const { tool, calls } = counter('mail.retry', 'sensitive');
    reg.register(tool);
    const first = await reg.execute('mail.retry', { text: 'again' }, { actor: 'user' });
    if (first.status !== 'pending_approval') throw new Error('expected a pending request');

    db.prepare("UPDATE tool_executions SET status='running', started_at=? WHERE id=?").run(
      new Date().toISOString(),
      first.execution.id,
    );
    reg.recoverInterrupted();
    expect(calls).toEqual([]);

    const reissued = await reg.retry(first.execution.id);
    // Re-issuing goes back through the policy: still sensitive, still a confirm.
    expect(reissued.status).toBe('pending_approval');
    if (reissued.status !== 'pending_approval') return;
    expect(reissued.execution.id).not.toBe(first.execution.id);
    expect(reissued.execution.input).toEqual({ text: 'again' });
  });

  it('survives a real restart with the pending request still answerable', async () => {
    const config = loadConfig({ home: homes[homes.length - 1] as string });
    const first = registry();
    const { tool } = counter('mail.persist', 'sensitive');
    first.register(tool);
    const requested = await first.execute('mail.persist', { text: 'durable' }, { actor: 'user' });
    if (requested.status !== 'pending_approval') throw new Error('expected a pending request');
    db.close();

    const reopened = openDb(config);
    const second = new ToolRegistry({ db: reopened, bus: new EventBus(reopened) });
    const { tool: sameTool, calls } = counter('mail.persist', 'sensitive');
    second.register(sameTool);
    expect(second.pending()).toHaveLength(1);

    const approved = await second.approve(requested.execution.id);
    expect(approved.status).toBe('succeeded');
    expect(calls).toEqual([{ text: 'durable' }]);
    reopened.close();
    db = reopened;
  });

  it('prunes finished audit rows but keeps anything still open', async () => {
    const reg = registry();
    const { tool } = counter('mail.prune', 'sensitive');
    reg.register(tool);
    const pending = await reg.execute('mail.prune', { text: 'keep' }, { actor: 'user' });
    await reg.execute('mail.prune', { text: 'x' }, { actor: 'agent' });
    db.prepare("UPDATE tool_executions SET requested_at='2020-01-01T00:00:00.000Z'").run();

    expect(reg.pruneAudit(0)).toBe(0);
    expect(reg.pruneAudit(30)).toBe(1);
    expect(reg.getExecution(pending.execution.id)?.status).toBe('pending_approval');
  });
});

describe('the event log', () => {
  it('records every decision so the UI and audit see the same story', async () => {
    const reg = registry();
    const { tool } = counter('mail.events', 'sensitive');
    reg.register(tool);
    const requested = await reg.execute('mail.events', { text: 'a' }, { actor: 'user' });
    if (requested.status !== 'pending_approval') throw new Error('expected a pending request');
    await reg.approve(requested.execution.id);
    await reg.execute('mail.events', { text: 'b' }, { actor: 'agent' });

    const types = bus.list({ limit: 100 }).map((event) => event.type);
    expect(types).toContain('tool.execution.requested');
    expect(types).toContain('tool.execution.approved');
    expect(types).toContain('tool.execution.completed');
    expect(types).toContain('tool.execution.denied');
  });
});
