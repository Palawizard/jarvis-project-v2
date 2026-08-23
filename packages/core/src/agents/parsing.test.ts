import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { extractMemoryProposals } from './proposals.js';
import { proposalToInput } from './types.js';
import { buildClaudeArgs, handleClaudeEvent } from './claude.js';
import { buildCodexArgs } from './codex.js';
import { jsonlProtocolError, killTree, runJsonlProcess } from './spawn.js';
import { parseReviewOutput } from '../review/engine.js';
import { detectExplicitCommand, scoreCandidate } from '../memory/policy.js';
import type { AgentEvent } from './types.js';

describe('provider process protocol', () => {
  it('waits for a spawned process to exit when its tree is cancelled', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await killTree(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('puts Codex exec options before resume', () => {
    const args = buildCodexArgs(
      {
        cwd: 'C:\\repo',
        prompt: 'fix it',
        role: 'fixer',
        resumeSessionId: 'thread-1',
      },
      'gpt-5',
    );
    expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('resume'));
    expect(args.indexOf('-C')).toBeLessThan(args.indexOf('resume'));
    expect(args.slice(-3)).toEqual(['resume', 'thread-1', '-']);
  });

  it('forces Claude reviewers into read-only plan mode', () => {
    const reviewer = buildClaudeArgs(
      { cwd: 'C:\\repo', prompt: 'review', role: 'reviewer' },
      'sonnet',
      'acceptEdits',
    );
    const implementer = buildClaudeArgs(
      { cwd: 'C:\\repo', prompt: 'implement', role: 'implementer' },
      'sonnet',
      'acceptEdits',
    );
    expect(reviewer[reviewer.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(implementer[implementer.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('records malformed JSONL and rejects a stream with no terminal event', async () => {
    const outcome = await runJsonlProcess({
      cli: {
        command: process.execPath,
        prefixArgs: ['-e', 'process.stdout.write("not-json\\n")'],
        source: 'test',
      },
      args: [],
      cwd: process.cwd(),
      stdin: '',
      timeoutMs: 5_000,
      scope: 'test',
      onLine: () => undefined,
    });
    expect(outcome.malformedLines).toBe(1);
    expect(jsonlProtocolError('test provider', outcome, false)).toContain('malformed JSONL');
    expect(jsonlProtocolError('test provider', { malformedLines: 0 }, false)).toContain(
      'without a terminal structured event',
    );
  });
});

describe('memory proposal extraction', () => {
  it('parses a well-formed block and strips it from the visible result', () => {
    const text = `I added the settings page and wired it to the router.

\`\`\`jarvis-memory
[{"type":"decision","scope":"project","subject":"routing.library",
  "content":"Routing uses a hand-rolled switch instead of react-router to avoid a dependency.",
  "importance":0.8,"confidence":0.9,"reason":"architecture decision"}]
\`\`\``;
    const { proposals, cleanedText } = extractMemoryProposals(text);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.type).toBe('decision');
    expect(proposals[0]?.subject).toBe('routing.library');
    expect(cleanedText).not.toContain('jarvis-memory');
    expect(cleanedText).toContain('settings page');
  });

  it('accepts a single object and a {memories:[...]} wrapper', () => {
    const single = extractMemoryProposals(
      '```jarvis-memory\n{"type":"fact","content":"Node 22 is required here."}\n```',
    );
    expect(single.proposals).toHaveLength(1);
    const wrapped = extractMemoryProposals(
      '```jarvis-memory\n{"memories":[{"type":"fact","content":"Node 22 is required here."}]}\n```',
    );
    expect(wrapped.proposals).toHaveLength(1);
  });

  it('returns no proposals for malformed JSON rather than throwing', () => {
    const { proposals } = extractMemoryProposals('```jarvis-memory\n{not json at all,,,}\n```');
    expect(proposals).toEqual([]);
  });

  it('caps the self-assessed importance an agent can claim', () => {
    const { proposals } = extractMemoryProposals(
      '```jarvis-memory\n[{"type":"decision","scope":"project","content":"This is extremely important forever.","importance":1.0,"confidence":1.0}]\n```',
    );
    expect(proposals[0]?.importance).toBeLessThanOrEqual(0.85);
    expect(proposals[0]?.confidence).toBeLessThanOrEqual(0.9);
  });

  it('drops entries that are too short, too long, or not objects', () => {
    const { proposals } = extractMemoryProposals(
      `\`\`\`jarvis-memory
[{"type":"fact","content":"tiny"},
 {"type":"fact","content":"${'x'.repeat(2000)}"},
 "just a string",
 {"type":"fact","content":"This one is a perfectly reasonable durable fact."}]
\`\`\``,
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.content).toContain('perfectly reasonable');
  });

  it('falls back to a safe kind and scope for unknown values', () => {
    const { proposals } = extractMemoryProposals(
      '```jarvis-memory\n[{"type":"wildly-invented-kind","scope":"global","content":"Some durable knowledge here."}]\n```',
    );
    expect(proposals[0]?.type).toBe('other');
    expect(proposals[0]?.scope).toBe('project');
  });
});

describe('proposal validation before persistence', () => {
  it('refuses a project-scoped proposal when the run has no project', () => {
    const input = proposalToInput(
      { type: 'decision', scope: 'project', content: 'Something about a project.' },
      { projectId: null },
    );
    expect(input).toBeNull();
  });

  it('refuses the agent scope outright', () => {
    const input = proposalToInput(
      {
        type: 'fact',
        scope: 'agent',
        content: 'Something the agent wants to remember about itself.',
      },
      { projectId: 'prj_1' },
    );
    expect(input).toBeNull();
  });

  it('binds a valid proposal to the run provenance', () => {
    const input = proposalToInput(
      {
        type: 'decision',
        scope: 'project',
        content: 'Use SQLite for local persistence.',
        reason: 'chosen in this job',
      },
      { projectId: 'prj_1', sessionId: 'ses_1', jobId: 'job_1', runId: 'run_1' },
    );
    expect(input?.scopeId).toBe('prj_1');
    expect(input?.sourceType).toBe('agent_proposal');
    expect(input?.sourceRef).toMatchObject({
      jobId: 'job_1',
      runId: 'run_1',
      note: 'chosen in this job',
    });
  });
});

describe('claude stream-json translation', () => {
  const collect = (events: Record<string, unknown>[]) => {
    const out: AgentEvent[] = [];
    const state = { result: '', usage: {} as Record<string, unknown>, failure: '' };
    const text: string[] = [];
    for (const event of events) {
      handleClaudeEvent(event, {
        onEvent: (e) => out.push(e),
        pushText: (t) => text.push(t),
        setResult: (r) => (state.result = r),
        setUsage: (u) => (state.usage = u),
        setFailure: (f) => (state.failure = f),
        model: 'sonnet',
      });
    }
    return { out, state, text: text.join('') };
  };

  it('maps init, assistant text, tool use and result', () => {
    const { out, state, text } = collect([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'a.ts' } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done.',
        usage: { output_tokens: 5 },
        is_error: false,
      },
    ]);

    expect(out.map((e) => e.kind)).toEqual(['started', 'text', 'tool_started', 'tool_completed']);
    expect(text).toBe('Working on it.');
    expect(state.result).toBe('Done.');
    expect(state.usage).toMatchObject({ output_tokens: 5 });
    expect(state.failure).toBe('');
  });

  it('ignores Claude Code hook lifecycle noise', () => {
    const { out } = collect([
      { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' },
      { type: 'system', subtype: 'hook_response', output: 'a very long unrelated hook payload' },
    ]);
    expect(out).toEqual([]);
  });

  it('surfaces an error result as a failure, not a success', () => {
    const { state } = collect([
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'hit max turns' },
    ]);
    expect(state.failure).toBe('hit max turns');
  });

  it('reports rate limiting as a waiting event', () => {
    const { out } = collect([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    ]);
    expect(out[0]).toMatchObject({ kind: 'waiting' });
  });

  it('tolerates unknown event types', () => {
    expect(() => collect([{ type: 'some_future_event_type', data: 1 }])).not.toThrow();
  });
});

describe('review output parsing', () => {
  it('parses a structured verdict with findings', () => {
    const parsed = parseReviewOutput(`Here is my review.

\`\`\`json
{"verdict":"request_changes","summary":"The change works but leaks a handle.",
 "findings":[{"severity":"high","category":"correctness","file":"src/a.ts","line":10,
   "description":"The stream is never closed.","recommendation":"Close it in a finally block."}]}
\`\`\``);
    expect(parsed.verdict).toBe('request_changes');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.severity).toBe('high');
  });

  it('prefers the last json block, so an example above the answer does not win', () => {
    const parsed = parseReviewOutput(`For reference the format is:
\`\`\`json
{"verdict":"approve","summary":"example","findings":[]}
\`\`\`
And my actual review:
\`\`\`json
{"verdict":"request_changes","summary":"real answer","findings":[]}
\`\`\``);
    expect(parsed.summary).toBe('real answer');
  });

  it('refuses to approve while reporting blocking findings', () => {
    const parsed = parseReviewOutput(
      '```json\n{"verdict":"approve","summary":"looks fine","findings":[{"severity":"critical","category":"security","description":"SQL injection in the search handler.","recommendation":"Parameterise."}]}\n```',
    );
    expect(parsed.verdict).toBe('request_changes');
  });

  it('reports unparseable reviewer output as an error, never as an approval', () => {
    const parsed = parseReviewOutput('The code looks good to me overall, ship it!');
    expect(parsed.verdict).toBe('error');
  });

  it('accepts a clean approval with no findings', () => {
    const parsed = parseReviewOutput(
      '```json\n{"verdict":"approve","summary":"Clean and focused.","findings":[]}\n```',
    );
    expect(parsed.verdict).toBe('approve');
    expect(parsed.findings).toEqual([]);
  });
});

describe('explicit memory command detection (Stage A, no LLM)', () => {
  const cases: Array<[string, string, string]> = [
    ['remember that I prefer pnpm', 'remember', 'I prefer pnpm'],
    ['Jarvis, remember I deploy on Fridays', 'remember', 'I deploy on Fridays'],
    ['keep in mind that the API is rate limited', 'remember', 'the API is rate limited'],
    ['retiens que je préfère le français', 'remember', 'je préfère le français'],
    ["n'oublie pas que le build casse sur Windows", 'remember', 'le build casse sur Windows'],
    ['forget about the old deploy script', 'forget', 'the old deploy script'],
    ['oublie que j utilise npm', 'forget', 'j utilise npm'],
    ['update what you remember about my editor', 'update', 'my editor'],
    ['actually I use bun now', 'update', 'I use bun now'],
  ];

  for (const [input, action, payload] of cases) {
    it(`detects "${input}"`, () => {
      const detected = detectExplicitCommand(input);
      expect(detected?.action).toBe(action);
      expect(detected?.payload).toBe(payload);
    });
  }

  it('does not fire on an ordinary development request', () => {
    expect(detectExplicitCommand('Add a dark mode toggle to the settings page')).toBeNull();
    expect(detectExplicitCommand('Can you fix the failing build?')).toBeNull();
  });
});

describe('candidate scoring (Stage B, no LLM)', () => {
  const opts = { minImportance: 0.35 };
  const base = { scope: 'user', kind: 'fact', sourceType: 'system' } as const;

  it('accepts an explicit request regardless of score', () => {
    const scored = scoreCandidate({ ...base, content: 'hi', explicit: true, importance: 0 }, opts);
    expect(scored.accept).toBe(true);
  });

  it('rejects filler and very short content', () => {
    expect(scoreCandidate({ ...base, content: 'ok thanks' }, opts).accept).toBe(false);
    expect(scoreCandidate({ ...base, content: 'merci' }, opts).accept).toBe(false);
    expect(scoreCandidate({ ...base, content: 'yes' }, opts).accept).toBe(false);
  });

  it('penalises hedged and transient statements', () => {
    const hedged = scoreCandidate(
      { ...base, content: 'I think maybe we should probably use Redis for this at some point.' },
      opts,
    );
    const firm = scoreCandidate(
      {
        ...base,
        kind: 'decision',
        content: 'The queue uses Redis streams with a five minute visibility timeout.',
      },
      opts,
    );
    expect(firm.importance).toBeGreaterThan(hedged.importance);
  });

  it('rewards concrete identifiers', () => {
    const concrete = scoreCandidate(
      {
        ...base,
        kind: 'project_knowledge',
        content: 'The retry policy lives in src/queue/retry.ts and backs off exponentially.',
      },
      opts,
    );
    const vague = scoreCandidate(
      {
        ...base,
        kind: 'project_knowledge',
        content: 'The retry policy is somewhere in the queue code and backs off.',
      },
      opts,
    );
    expect(concrete.importance).toBeGreaterThan(vague.importance);
  });
});
