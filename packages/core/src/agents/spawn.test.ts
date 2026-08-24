import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jsonlProtocolError, runJsonlProcess } from './spawn.js';
import type { ResolvedCli } from './resolve.js';

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-spawn-'));

afterAll(() => {
  fs.rmSync(fixtures, { recursive: true, force: true });
});

/**
 * A fake provider CLI: it must receive the prompt on its own stdin, exactly as
 * Claude Code and Codex do. Anything the containment wrapper consumed or
 * injected shows up here as a mismatch.
 */
function fakeCli(name: string, body: string): ResolvedCli {
  const file = path.join(fixtures, `${name}.js`);
  fs.writeFileSync(file, body);
  return { command: process.execPath, prefixArgs: [file], source: 'test' };
}

const echoCli = fakeCli(
  'echo-stdin',
  `const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init', pid: process.pid });
  emit({ type: 'stdin', prompt, lines: prompt.split('\\n').length });
  emit({ type: 'result', subtype: 'success' });
  process.exit(0);
});
`,
);

const hangCli = fakeCli(
  'hang',
  `process.stdout.write(JSON.stringify({ type: 'system', pid: process.pid }) + '\\n');
setInterval(() => {}, 1000);
`,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const PROMPT = [
  'Review the following change.',
  '',
  'diff --git a/x b/x',
  '+  const quoted = "double" and \'single\';',
  '+  // unicode: café → ✓',
  '',
  'Answer in JSON.',
].join('\n');

describe('runJsonlProcess stdin protocol', () => {
  it('delivers the whole prompt to the contained CLI and sees its terminal event', async () => {
    const lines: Record<string, unknown>[] = [];
    const outcome = await runJsonlProcess({
      cli: echoCli,
      args: [],
      cwd: fixtures,
      stdin: PROMPT,
      timeoutMs: 60_000,
      scope: 'test',
      onLine: (event) => lines.push(event),
    });

    expect(outcome.startError).toBeUndefined();
    expect(outcome.code).toBe(0);
    expect(outcome.malformedLines).toBe(0);

    const received = lines.find((line) => line.type === 'stdin');
    // Byte-for-byte: the wrapper must neither consume nor prepend to stdin.
    expect(received?.prompt).toBe(PROMPT);
    expect(received?.lines).toBe(PROMPT.split('\n').length);
    expect(String(received?.prompt)).not.toContain('executable');
    expect(String(received?.prompt)).not.toContain(echoCli.prefixArgs[0]);

    const sawTerminal = lines.some((line) => line.type === 'result');
    expect(sawTerminal).toBe(true);
    expect(jsonlProtocolError('fake', outcome, sawTerminal)).toBeNull();
  }, 120_000);

  it('kills the contained process tree on cancellation', async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const outcome = await runJsonlProcess({
      cli: hangCli,
      args: [],
      cwd: fixtures,
      stdin: PROMPT,
      timeoutMs: 60_000,
      signal: controller.signal,
      scope: 'test',
      onLine: (event) => {
        pid = event.pid as number;
        controller.abort();
      },
    });

    expect(outcome.cancelled).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid as number)).toBe(false);
  }, 120_000);

  it('reports a missing terminal event as a protocol error', () => {
    expect(jsonlProtocolError('Claude Code', { malformedLines: 0 }, false)).toBe(
      'Claude Code exited without a terminal structured event',
    );
  });
});
