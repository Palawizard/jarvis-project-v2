import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { isToolFreeViolation } from './toolfree.js';
import type { AgentEvent } from './types.js';

/**
 * Both adapters are exercised against fake CLIs through the real
 * runJsonlProcess/spawnContained path — the containment wrapper included — so a
 * regression that eats the provider's stdin fails here instead of in production.
 * No real provider is invoked, so no subscription quota is consumed.
 */
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-providers-'));

afterAll(() => {
  fs.rmSync(fixtures, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.JARVIS_CLAUDE_BIN;
  delete process.env.JARVIS_CODEX_BIN;
});

function script(name: string, body: string): string {
  const file = path.join(fixtures, name);
  fs.writeFileSync(file, body);
  return file;
}

/** Reads the whole prompt from stdin, then replays it as a terminal event. */
const READ_STDIN = `const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8')));
`;

const FAKE_CLAUDE = script(
  'fake-claude.js',
  `${READ_STDIN}
function run(prompt) {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'sonnet' });
  emit({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: prompt }] } });
  emit({ type: 'result', subtype: 'success', session_id: 'sess-1', result: prompt, usage: { input_tokens: 1 } });
  process.exit(0);
}
`,
);

const SILENT_CLAUDE = script(
  'silent-claude.js',
  `${READ_STDIN}
function run() {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }) + '\\n');
  process.exit(0);
}
`,
);

const FAKE_CODEX = script(
  'fake-codex.js',
  `if (process.argv.includes('--version')) { console.log('codex 0.0.0-fake'); process.exit(0); }
if (process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
${READ_STDIN}
function run(prompt) {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'thread.started', thread_id: 'thread-1' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: prompt } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1 } });
  process.exit(0);
}
`,
);

/**
 * Replays the shape a real `claude --json-schema` run emits: an assistant
 * `tool_use` for the provider-internal `StructuredOutput` pseudo-tool, its
 * synthetic `tool_result`, then the terminal result carrying the validated
 * object. The prompt on stdin says which tool to name and which id to answer,
 * so one fake covers the legitimate case and the ways it can be faked.
 */
const SCHEMA_CLAUDE = script(
  'schema-claude.js',
  `${READ_STDIN}
function run(prompt) {
  const plan = JSON.parse(prompt);
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'sess-schema', model: 'sonnet' });
  emit({
    type: 'assistant',
    session_id: 'sess-schema',
    message: { content: [{ type: 'tool_use', id: plan.id, name: plan.tool, input: {} }] },
  });
  emit({
    type: 'user',
    session_id: 'sess-schema',
    message: { content: [{ type: 'tool_result', tool_use_id: plan.resultId, content: 'ok' }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-schema',
    structured_output: { title: 'compiled' },
  });
  process.exit(0);
}
`,
);

const PROMPT = 'line one\nline two with "quotes"\n\nfinal line: café ✓';

function config() {
  return loadConfig({
    home: path.join(fixtures, 'home'),
    agents: {
      implementerProvider: undefined,
      reviewerProvider: undefined,
      claudeModel: 'sonnet',
      claudePermissionMode: 'acceptEdits',
      codexModel: undefined,
      runTimeoutMs: 90_000,
      cooldownMs: 1000,
    },
  });
}

describe('provider terminal events over the real spawn path', () => {
  it('completes a Claude run whose prompt arrived intact on stdin', async () => {
    process.env.JARVIS_CLAUDE_BIN = FAKE_CLAUDE;
    const events: AgentEvent[] = [];
    const result = await new ClaudeProvider(config()).run(
      { cwd: fixtures, prompt: PROMPT, role: 'chat' },
      (event) => events.push(event),
    );

    expect(result.status).toBe('completed');
    expect(result.result).toBe(PROMPT);
    expect(result.sessionId).toBe('sess-1');
    expect(events.map((e) => e.kind)).toContain('completed');
  }, 120_000);

  it('fails a Claude run that ends without a result event', async () => {
    process.env.JARVIS_CLAUDE_BIN = SILENT_CLAUDE;
    const result = await new ClaudeProvider(config()).run(
      { cwd: fixtures, prompt: PROMPT, role: 'chat' },
      () => {},
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Claude Code exited without a terminal structured event');
  }, 120_000);

  it('completes a Codex run whose prompt arrived intact on stdin', async () => {
    process.env.JARVIS_CODEX_BIN = FAKE_CODEX;
    const result = await new CodexProvider(config()).run(
      { cwd: fixtures, prompt: PROMPT, role: 'chat' },
      () => {},
    );

    expect(result.status).toBe('completed');
    expect(result.result).toBe(PROMPT);
    expect(result.sessionId).toBe('thread-1');
  }, 120_000);

  it('reports Codex unavailable when its override path does not exist', async () => {
    process.env.JARVIS_CODEX_BIN = path.join(fixtures, '__disabled__', 'codex.exe');
    const caps = await new CodexProvider(config()).capabilities();
    expect(caps.available).toBe(false);
    expect(caps.reason).toContain('Codex CLI not found');
  });
});

/**
 * Regression for the deployed Job Brief Compiler failure: Claude's
 * `--json-schema` framing was normalized into `agent.tool_started`, the
 * tool-free guard read it as forbidden tool use, and the run was aborted before
 * the terminal `structured_output` arrived.
 */
describe('Claude structured-output framing against the tool-free guard', () => {
  const schemaPath = 'schema.json';
  fs.writeFileSync(
    path.join(fixtures, schemaPath),
    JSON.stringify({ type: 'object', properties: { title: { type: 'string' } } }),
  );

  function runSchemaClaude(
    plan: { tool: string; id: string; resultId: string },
    withSchema = true,
  ) {
    process.env.JARVIS_CLAUDE_BIN = SCHEMA_CLAUDE;
    const events: AgentEvent[] = [];
    return new ClaudeProvider(config())
      .run(
        {
          cwd: fixtures,
          prompt: JSON.stringify(plan),
          role: 'brief_compiler',
          ...(withSchema ? { outputSchemaPath: schemaPath } : {}),
        },
        (event) => events.push(event),
      )
      .then((result) => ({ result, events }));
  }

  it('completes a schema-constrained tool-free run and returns the structured output', async () => {
    const { result, events } = await runSchemaClaude({
      tool: 'StructuredOutput',
      id: 'toolu_1',
      resultId: 'toolu_1',
    });

    expect(result.status).toBe('completed');
    expect(result.structuredOutput).toEqual({ title: 'compiled' });
    // The framing never surfaced as agent tool use either.
    expect(events.map((e) => e.kind)).not.toContain('tool_started');
    expect(events.map((e) => e.kind)).not.toContain('tool_completed');
  }, 120_000);

  it('still fails closed when a schema-constrained tool-free run reaches a real tool', async () => {
    const { result } = await runSchemaClaude({ tool: 'Bash', id: 'toolu_2', resultId: 'toolu_2' });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Bash');
    expect(isToolFreeViolation(result.error)).toBe(true);
    expect(result.structuredOutput).toBeUndefined();
  }, 120_000);

  it('still fails closed on StructuredOutput when no schema was requested', async () => {
    const { result } = await runSchemaClaude(
      { tool: 'StructuredOutput', id: 'toolu_3', resultId: 'toolu_3' },
      false,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('StructuredOutput');
    expect(isToolFreeViolation(result.error)).toBe(true);
  }, 120_000);

  it('does not silently accept a tool_result for an id it never suppressed', async () => {
    const { result } = await runSchemaClaude({
      tool: 'StructuredOutput',
      id: 'toolu_4',
      resultId: 'toolu_smuggled',
    });

    expect(result.status).toBe('failed');
    expect(isToolFreeViolation(result.error)).toBe(true);
    expect(result.structuredOutput).toBeUndefined();
  }, 120_000);
});
