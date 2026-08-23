import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Jarvis, loadConfig } from '../../packages/core/src/index.js';

const homes: string[] = [];
const open: Jarvis[] = [];

afterEach(() => {
  for (const jarvis of open.splice(0)) {
    try {
      jarvis.close();
    } catch {
      // Already closed by a test asserting restart behaviour.
    }
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function boot(home: string): Jarvis {
  const jarvis = new Jarvis(
    loadConfig({
      home,
      memory: { ...loadConfig({ home }).memory, embeddingsEnabled: false },
    }),
  );
  open.push(jarvis);
  return jarvis;
}

/**
 * A stand-in for the modules this layer exists to prepare (screen, desktop,
 * Gmail, Calendar): a tool that touches the outside world, with an observable
 * side effect so "did it actually run?" is a fact and not an assumption.
 */
function registerOutsideWorldTool(jarvis: Jarvis, outbox: string) {
  jarvis.tools.register({
    name: 'test.send',
    description: 'Pretends to send something to the outside world.',
    risk: 'sensitive',
    input: z.object({ to: z.string().min(1), body: z.string().min(1) }),
    async execute(input) {
      fs.appendFileSync(outbox, `${input.to}: ${input.body}\n`);
      return { sent: true };
    },
  });
}

describe('tool permission layer end to end', () => {
  it('gates a sensitive action, survives a restart, and keeps memory and jobs intact', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-e2e-'));
    homes.push(home);
    const outbox = path.join(home, 'outbox.txt');

    const first = boot(home);
    await first.boot();
    registerOutsideWorldTool(first, outbox);

    // Durable state that a schema migration must not disturb.
    const stored = await first.memory.remember({
      scope: 'user',
      kind: 'preference',
      subject: 'preference.tools',
      content: 'Ask before anything leaves the machine.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(stored.status).toBe('stored');
    if (stored.status !== 'stored') return;
    const memoryId = stored.memory.id;

    // An observe-level tool needs nobody's permission.
    const search = await first.tools.execute(
      'memory.search',
      { query: 'leaves the machine' },
      { actor: 'user' },
    );
    expect(search.status).toBe('succeeded');

    // An agent cannot reach the outside world at all, and the attempt is recorded.
    const byAgent = await first.tools.execute(
      'test.send',
      { to: 'someone', body: 'hello' },
      { actor: 'agent', agentRunId: 'run_fixture' },
    );
    expect(byAgent.status).toBe('denied');
    expect(fs.existsSync(outbox)).toBe(false);

    // The user gets a confirmation request instead of an immediate send.
    const requested = await first.tools.execute(
      'test.send',
      { to: 'someone', body: 'hello' },
      { actor: 'user' },
    );
    expect(requested.status).toBe('pending_approval');
    if (requested.status !== 'pending_approval') return;
    expect(fs.existsSync(outbox)).toBe(false);

    // Jarvis dies with the request unanswered.
    first.close();

    const second = boot(home);
    const rebooted = await second.boot();
    expect(rebooted.tools).toEqual({ interrupted: 0, expired: 0 });
    registerOutsideWorldTool(second, outbox);

    // The request is still there and still answerable against the same payload.
    expect(second.tools.pending().map((execution) => execution.id)).toEqual([
      requested.execution.id,
    ]);
    const approved = await second.tools.approve(requested.execution.id, { remember: {} });
    expect(approved.status).toBe('succeeded');
    expect(fs.readFileSync(outbox, 'utf8')).toBe('someone: hello\n');

    // The remembered permission makes the next identical action immediate.
    const again = await second.tools.execute(
      'test.send',
      { to: 'someone', body: 'second' },
      { actor: 'user' },
    );
    expect(again.status).toBe('succeeded');
    expect(fs.readFileSync(outbox, 'utf8')).toBe('someone: hello\nsomeone: second\n');

    // ...but never for an agent, grant or no grant.
    const agentAgain = await second.tools.execute(
      'test.send',
      { to: 'someone', body: 'third' },
      { actor: 'agent' },
    );
    expect(agentAgain.status).toBe('denied');
    expect(fs.readFileSync(outbox, 'utf8')).not.toContain('third');

    // The audit trail survived the restart and holds every decision.
    const audit = second.tools.executions({ toolName: 'test.send', limit: 50 });
    expect(audit.map((execution) => execution.status).sort()).toEqual([
      'denied',
      'denied',
      'succeeded',
      'succeeded',
    ]);

    // The new tool tables left existing memory alone.
    expect(second.memory.get(memoryId)?.content).toBe('Ask before anything leaves the machine.');
  });

  it('marks an action interrupted by a crash instead of silently repeating it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-crash-'));
    homes.push(home);
    const outbox = path.join(home, 'outbox.txt');

    const first = boot(home);
    await first.boot();
    let started = 0;
    first.tools.register({
      name: 'test.slow',
      description: 'A long action the process does not outlive.',
      risk: 'reversible_modification',
      input: z.object({ note: z.string() }),
      async execute(input) {
        started += 1;
        fs.appendFileSync(outbox, `${input.note}\n`);
        // Never settles: stands in for a process killed mid-action.
        return new Promise<never>(() => undefined);
      },
      timeoutMs: 50,
    });

    const outcome = await first.tools.execute(
      'test.slow',
      { note: 'half done' },
      { actor: 'user' },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toMatch(/timed out/);
    expect(started).toBe(1);

    // A row the process really did die on.
    first.db
      .prepare("UPDATE tool_executions SET status='running', finished_at=NULL WHERE id=?")
      .run(outcome.execution.id);
    first.close();

    const second = boot(home);
    const rebooted = await second.boot();
    expect(rebooted.tools.interrupted).toBe(1);
    const recovered = second.tools.getExecution(outcome.execution.id);
    expect(recovered?.status).toBe('interrupted');
    expect(recovered?.error).toMatch(/effect is unknown/);
    // Recovery reports; it never re-runs.
    expect(fs.readFileSync(outbox, 'utf8')).toBe('half done\n');
  });
});
