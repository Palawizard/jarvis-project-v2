import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildClaudeArgs, CHAT_DENIED_TOOLS, ClaudeProvider } from './claude.js';
import { isToolFreeViolation } from './toolfree.js';
import { buildCodexArgs, CodexProvider } from './codex.js';
import type { AgentEvent } from './types.js';

/**
 * Every tool-free role must be tool-free at BOTH levels.
 *
 * The configuration level is what should keep it that way; the runtime level is
 * what happens the day it does not. The deployed regression this file exists
 * for looked exactly like the second case: the conversational provider used
 * `AskUserQuestion` and `Explore`, and Jarvis had no way to notice.
 *
 * Four roles are covered, not one. `chat` answers the human; `router` and
 * `autostart_verifier` classify one message each, and the second one's
 * agreement is what stands between a sentence and an autonomous agent editing
 * real source. A classifier that could read the filesystem to "check" its
 * answer would be a coding agent nobody asked for. `brief_compiler` restates an
 * already-authorised request for the implementer, and one that could read the
 * repository would be an implementer running before the Job exists.
 */
const TOOL_FREE = ['chat', 'router', 'autostart_verifier', 'brief_compiler'] as const;
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-toolfree-'));

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

const READ_STDIN = `const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8')));
`;

/** A provider that ignores its tool restrictions and asks the human a question. */
const ROGUE_CLAUDE = script(
  'rogue-claude.js',
  `${READ_STDIN}
function run() {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'sess-r', model: 'sonnet' });
  emit({ type: 'assistant', session_id: 'sess-r', message: { content: [
    { type: 'text', text: 'The current working folder (chat-scratch) is empty.' },
    { type: 'tool_use', id: 'tu-1', name: 'AskUserQuestion', input: { question: 'Where is the repo?' } },
  ] } });
  emit({ type: 'user', session_id: 'sess-r', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu-1', content: 'C:/somewhere' },
  ] } });
  emit({ type: 'result', subtype: 'success', session_id: 'sess-r', result: 'Where is the Jarvis repository?' });
  process.exit(0);
}
`,
);

/** The same provider behaving: text only, and a structured Jarvis action. */
const ACTION_CLAUDE = script(
  'action-claude.js',
  `${READ_STDIN}
function run() {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const answer = 'Starting that.\\n\\n\\u0060\\u0060\\u0060jarvis-action\\n{"action":"create_job","project":"jarvis","request":"Fix the nav"}\\n\\u0060\\u0060\\u0060';
  emit({ type: 'system', subtype: 'init', session_id: 'sess-a', model: 'sonnet' });
  emit({ type: 'assistant', session_id: 'sess-a', message: { content: [{ type: 'text', text: answer }] } });
  emit({ type: 'result', subtype: 'success', session_id: 'sess-a', result: answer });
  process.exit(0);
}
`,
);

/** A Codex run that reports a shell command during what is supposed to be chat. */
const ROGUE_CODEX = script(
  'rogue-codex.js',
  `if (process.argv.includes('--version')) { console.log('codex 0.0.0-fake'); process.exit(0); }
if (process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
${READ_STDIN}
function run() {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'thread.started', thread_id: 'thread-r' });
  emit({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la', exit_code: 0 } });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'I looked around.' } });
  emit({ type: 'turn.completed', usage: {} });
  process.exit(0);
}
`,
);

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

describe('chat CLI configuration', () => {
  const chatArgs = (role: (typeof TOOL_FREE)[number] = 'chat') =>
    buildClaudeArgs(
      { cwd: fixtures, prompt: 'hello', role, safeMode: true, ephemeral: true },
      'sonnet',
      'acceptEdits',
    );

  it('disables the whole built-in tool set for every tool-free role', () => {
    for (const role of TOOL_FREE) {
      const args = chatArgs(role);
      // `--tools ""` is the documented way to disable all built-in tools. It is
      // asserted positionally so a later flag cannot be mistaken for its value.
      expect(`${role}: ${args[args.indexOf('--tools') + 1]}`).toBe(`${role}: `);
      // Read-only permission mode as well: two independent flags, not one.
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    }
  });

  it('names the tools whose use in a conversation would be a security event', () => {
    const denied = chatArgs()[chatArgs().indexOf('--disallowed-tools') + 1] ?? '';
    for (const tool of ['AskUserQuestion', 'Task', 'Explore', 'Bash', 'Edit', 'Read']) {
      expect(denied.split(',')).toContain(tool);
    }
    expect([...CHAT_DENIED_TOOLS]).toContain('AskUserQuestion');
  });

  it('gives the project analyst reading tools and nothing that runs or writes', () => {
    const args = buildClaudeArgs(
      { cwd: fixtures, prompt: 'analyse', role: 'project_analyst' },
      'sonnet',
      'acceptEdits',
    );
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    const tools = (args[args.indexOf('--tools') + 1] ?? '').split(',');
    expect(tools.sort()).toEqual(['Glob', 'Grep', 'Read']);
    for (const forbidden of ['Bash', 'Edit', 'Write', 'Task']) {
      expect(tools).not.toContain(forbidden);
    }
  });

  it('keeps Codex out of write mode for every non-implementing role', () => {
    for (const role of [...TOOL_FREE, 'project_analyst', 'reviewer'] as const) {
      const args = buildCodexArgs({ cwd: fixtures, prompt: 'x', role }, 'gpt-test');
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    }
    const implementer = buildCodexArgs(
      { cwd: fixtures, prompt: 'x', role: 'implementer' },
      'gpt-test',
    );
    expect(implementer[implementer.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('never advertises Codex as able to run tool-free chat', async () => {
    // The registry refuses `role=chat` to any provider without this capability,
    // which is what keeps Codex's read-only sandbox out of conversation. Codex
    // read-only can still read files and run commands; that is not tool-free.
    process.env.JARVIS_CODEX_BIN = script('codex-caps.js', 'console.log("codex 0.0.0-fake");');
    const caps = await new CodexProvider(config()).capabilities();
    expect(caps.toolFreeChat).not.toBe(true);
  });
});

describe('chat runtime enforcement', () => {
  it('confines the file tools to the working directory for both restricted roles', () => {
    // `--tools` chooses which built-ins exist; `--restricted` is what bounds
    // where they may reach. The analyst reads a repository the user registered
    // but may not control, and is told to read its README.
    for (const role of [...TOOL_FREE, 'project_analyst'] as const) {
      expect(
        buildClaudeArgs({ cwd: fixtures, prompt: 'x', role }, 'sonnet', 'acceptEdits'),
      ).toContain('--restricted');
    }
  });

  it('aborts a chat run that uses a provider-native tool and discards its output', async () => {
    process.env.JARVIS_CLAUDE_BIN = ROGUE_CLAUDE;
    const events: AgentEvent[] = [];
    const result = await new ClaudeProvider(config()).run(
      { cwd: fixtures, prompt: 'code sur le projet Jarvis', role: 'chat' },
      (event) => events.push(event),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('provider protocol violation');
    expect(result.error).toContain('AskUserQuestion');
    // The provider's own words are thrown away: an answer produced by asking the
    // human a question through the provider's UI is not a Jarvis answer.
    expect(result.result).toBe('');
    // And nothing downstream ever sees the tool, so it cannot be rendered as
    // Jarvis UI or mistaken for an action.
    expect(events.map((event) => event.kind)).not.toContain('tool_started');
    expect(events.map((event) => event.kind)).not.toContain('tool_completed');
    // The failure is recognisable without parsing prose, which is what lets the
    // chat path blank the streamed text instead of showing it.
    expect(isToolFreeViolation(result.error)).toBe(true);
  }, 120_000);

  it('aborts a Codex chat run that reports a shell command', async () => {
    process.env.JARVIS_CODEX_BIN = ROGUE_CODEX;
    const events: AgentEvent[] = [];
    const result = await new CodexProvider(config()).run(
      { cwd: fixtures, prompt: 'hello', role: 'chat' },
      (event) => events.push(event),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('provider protocol violation');
    expect(result.result).toBe('');
    expect(events.map((event) => event.kind)).not.toContain('tool_completed');
  }, 120_000);

  it('still accepts a structured jarvis-action, which is text and not a tool call', async () => {
    process.env.JARVIS_CLAUDE_BIN = ACTION_CLAUDE;
    const result = await new ClaudeProvider(config()).run(
      { cwd: fixtures, prompt: 'fix the nav in jarvis', role: 'chat' },
      () => {},
    );

    expect(result.status).toBe('completed');
    expect(result.result).toContain('```jarvis-action');
    expect(result.result).toContain('"action":"create_job"');
  }, 120_000);

  it('discards a routing answer from a run that reached a tool', async () => {
    // The worst case for a classifier: it reads something, decides on the
    // strength of it, and returns a confident JSON object. Nothing from such a
    // run may be parsed — a routing decision is only as trustworthy as the
    // confinement it was produced under.
    process.env.JARVIS_CLAUDE_BIN = ROGUE_CLAUDE;
    for (const role of ['router', 'autostart_verifier'] as const) {
      const events: AgentEvent[] = [];
      const result = await new ClaudeProvider(config()).run(
        { cwd: fixtures, prompt: 'classify this', role },
        (event) => events.push(event),
      );

      expect(`${role}: ${result.status}`).toBe(`${role}: failed`);
      expect(isToolFreeViolation(result.error)).toBe(true);
      expect(result.result).toBe('');
      expect(events.map((event) => event.kind)).not.toContain('tool_started');
    }
  }, 120_000);

  it('leaves tool use alone for roles that are supposed to have tools', async () => {
    process.env.JARVIS_CLAUDE_BIN = ROGUE_CLAUDE;
    const events: AgentEvent[] = [];
    const result = await new ClaudeProvider(config()).run(
      { cwd: fixtures, prompt: 'do the work', role: 'implementer' },
      (event) => events.push(event),
    );

    expect(result.status).toBe('completed');
    expect(events.map((event) => event.kind)).toContain('tool_started');
  }, 120_000);
});
