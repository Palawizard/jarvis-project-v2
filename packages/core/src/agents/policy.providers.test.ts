import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from './claude.js';
import { buildCodexArgs } from './codex.js';
import { modelFor, type CapabilityTier, type EffortLevel } from './policy.js';
import type { AgentStartOptions } from './types.js';

const options = (effort?: EffortLevel): AgentStartOptions => ({
  cwd: '/tmp/jarvis-policy-args',
  prompt: 'do the thing',
  role: 'implementer',
  ...(effort ? { effort } : {}),
});

/** Every decision the policy can produce, actually reaching a CLI. */
const DECISIONS: Array<[CapabilityTier, EffortLevel]> = [
  ['normal', 'low'],
  ['normal', 'high'],
  ['strong', 'medium'],
  ['strong', 'high'],
];

const ILLEGAL_EFFORTS = ['xhigh', 'max', 'minimal', 'HIGH', ''];

describe('the decision reaches the Claude CLI', () => {
  it.each(DECISIONS)('claude %s/%s', (tier, effort) => {
    const model = modelFor('claude', tier);
    const args = buildClaudeArgs(options(effort), model, 'acceptEdits');
    expect(args[args.indexOf('--model') + 1]).toBe(model);
    expect(args[args.indexOf('--effort') + 1]).toBe(effort);
  });

  it('omits the flag entirely when no effort was decided', () => {
    const args = buildClaudeArgs(options(), 'sonnet', 'acceptEdits');
    expect(args).not.toContain('--effort');
  });

  it('omits the flag rather than pretending when the CLI has no effort control', () => {
    const cli = { effortControl: false };
    const args = buildClaudeArgs(options('high'), 'sonnet', 'acceptEdits', cli);
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('high');
  });

  it('refuses a model outside the allowlist', () => {
    for (const model of ['haiku', 'claude-3-opus', 'gpt-5', '']) {
      const build = () => buildClaudeArgs(options('low'), model, 'acceptEdits');
      expect(build).toThrow(/not allowed/);
    }
  });

  it('refuses an effort outside low|medium|high', () => {
    for (const effort of ILLEGAL_EFFORTS) {
      const bad = { ...options(), effort: effort as EffortLevel };
      const build = () => buildClaudeArgs(bad, 'sonnet', 'acceptEdits');
      expect(build).toThrow(/low\|medium\|high/);
    }
  });
});

describe('the decision reaches the Codex CLI', () => {
  it.each(DECISIONS)('codex %s/%s', (tier, effort) => {
    const model = modelFor('codex', tier);
    const args = buildCodexArgs(options(effort), model);
    expect(args[args.indexOf('--model') + 1]).toBe(model);
    // Codex has no `--effort` flag: reasoning effort is a config override, and
    // `-C` (working directory) is a different, case-distinct argument.
    expect(args[args.indexOf('-c') + 1]).toBe(`model_reasoning_effort="${effort}"`);
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('-'));
  });

  it('omits the override entirely when no effort was decided', () => {
    expect(buildCodexArgs(options(), 'terra')).not.toContain('-c');
  });

  it('omits the override rather than pretending when the CLI cannot take one', () => {
    const args = buildCodexArgs(options('high'), 'terra', { effortControl: false });
    expect(args).not.toContain('-c');
  });

  it('refuses a model outside the allowlist', () => {
    for (const model of ['gpt-5', 'o3', 'opus', 'haiku']) {
      const build = () => buildCodexArgs(options('low'), model);
      expect(build).toThrow(/not allowed/);
    }
  });

  it('refuses an effort outside low|medium|high', () => {
    for (const effort of ILLEGAL_EFFORTS) {
      const bad = { ...options(), effort: effort as EffortLevel };
      const build = () => buildCodexArgs(bad, 'terra');
      expect(build).toThrow(/low\|medium\|high/);
    }
  });
});
