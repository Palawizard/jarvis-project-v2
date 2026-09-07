import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { AgentRegistry, classifyAgentFailure } from './registry.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
  ProviderId,
} from './types.js';

class FakeProvider implements AgentProvider {
  constructor(
    readonly id: ProviderId,
    private readonly available = true,
    private readonly toolFreeChat = true,
    private readonly enforcesToolAllowlist = true,
    private readonly effortControl = true,
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: this.available,
      authenticated: this.available,
      streaming: true,
      resumable: true,
      models: this.id === 'claude' ? ['sonnet', 'opus'] : ['gpt-5.6-terra', 'gpt-5.6-sol'],
      effortControl: this.effortControl,
      structuredOutput: true,
      toolFreeChat: this.toolFreeChat,
      enforcesToolAllowlist: this.enforcesToolAllowlist,
      ...(!this.available ? { reason: 'offline' } : {}),
    };
  }

  async run(
    _options: AgentStartOptions,
    _onEvent: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    return { status: 'completed', result: '', memoryProposals: [] };
  }
}

function registry(providers: AgentProvider[], opts: { now?: () => Date } = {}) {
  const config = loadConfig({
    home: '.jarvis/router-test',
    agents: {
      implementerProvider: undefined,
      reviewerProvider: undefined,
      claudePermissionMode: 'acceptEdits',
      runTimeoutMs: 1000,
    },
  });
  return new AgentRegistry(config, { providers, ...(opts.now ? { now: opts.now } : {}) });
}

describe('AgentRegistry v2', () => {
  it('honours an available explicit preference and records why', async () => {
    const result = await registry([new FakeProvider('claude'), new FakeProvider('codex')]).route(
      'implementer',
      { prefer: 'codex' },
    );
    expect(result.provider?.id).toBe('codex');
    expect(result.decision.reason).toContain('explicit');
  });

  it('falls back when the preferred provider is unavailable', async () => {
    const result = await registry([
      new FakeProvider('claude'),
      new FakeProvider('codex', false),
    ]).route('implementer', { prefer: 'codex' });
    expect(result.provider?.id).toBe('claude');
    expect(result.decision.reason).toContain('unavailable');
  });

  it('routes every tool-free role only to a provider that can run without tools', async () => {
    // Conversation is not the only role that promises this. The two routing
    // classifiers and the brief compiler make the same promise, so a provider
    // that cannot prove it is tool-free serves none of them -- and the reason
    // says which promise it failed, rather than naming the analyst's allowlist.
    for (const role of ['chat', 'router', 'autostart_verifier', 'brief_compiler'] as const) {
      const result = await registry([
        new FakeProvider('codex', true, false),
        new FakeProvider('claude'),
      ]).route(role, { prefer: 'codex' });
      expect(`${role}: ${result.provider?.id}`).toBe(`${role}: claude`);

      const unavailable = await registry([new FakeProvider('codex', true, false)]).route(role);
      expect(unavailable.provider).toBeNull();
      expect(unavailable.decision.reason).toContain('cannot run tool-free');
      expect(unavailable.decision.reason).not.toContain('read-only tool allowlist');
    }
  });

  it('routes the project analyst only to a provider that can be held to an allowlist', async () => {
    // A read-only sandbox is not a tool allowlist: it prevents writes, but the
    // agent can still run shell commands, which is not what "reads the
    // repository and reports" means. Rather than route and quietly make a
    // weaker guarantee, the role goes unserved.
    const gated = await registry([
      new FakeProvider('codex', true, false, false),
      new FakeProvider('claude'),
    ]).route('project_analyst', { prefer: 'codex' });
    expect(gated.provider?.id).toBe('claude');

    const unavailable = await registry([new FakeProvider('codex', true, false, false)]).route(
      'project_analyst',
    );
    expect(unavailable.provider).toBeNull();
    expect(unavailable.reason).toContain('read-only tool allowlist');
  });

  it('uses cross-provider review and same-provider fallback', async () => {
    const cross = await registry([new FakeProvider('claude'), new FakeProvider('codex')]).route(
      'reviewer',
      { avoid: 'claude' },
    );
    expect(cross.provider?.id).toBe('codex');
    expect(cross.decision.reason).toContain('cross-provider');

    const same = await registry([new FakeProvider('claude')]).route('reviewer', {
      avoid: 'claude',
    });
    expect(same.provider?.id).toBe('claude');
    expect(same.decision.reason).toContain('fresh');
  });

  it('prefers a healthy independent reviewer over a same-provider preference', async () => {
    const result = await registry([new FakeProvider('claude'), new FakeProvider('codex')]).route(
      'reviewer',
      { prefer: 'claude', avoid: 'claude' },
    );

    expect(result.provider?.id).toBe('codex');
  });

  it('selects model and effort from the central policy, without an LLM classifier', async () => {
    const router = registry([new FakeProvider('claude')]);
    const cheap = await router.route('implementer', { signals: { mechanical: true } });
    expect(cheap.decision.model).toBe('sonnet');
    expect(cheap.decision.effort).toBe('medium');
    expect(cheap.decision.factors.join(' ')).toContain('mechanical');

    const heavy = await router.route('implementer', {
      signals: {
        selfDevelopment: true,
        highRisk: true,
        requirements: 11,
        hasCompiledBrief: true,
        packagesTouched: 3,
      },
    });
    expect(heavy.decision.model).toBe('opus');
    expect(heavy.decision.effort).toBe('high');
    expect(heavy.decision.capabilityTier).toBe('strong');
  });

  it('records that effort was not applied when the CLI cannot take one', async () => {
    const noEffort = new FakeProvider('claude', true, true, true, false);
    const routed = await registry([noEffort]).route('implementer');
    expect(routed.decision.effort).toBe('medium');
    expect(routed.decision.factors.join(' ')).toContain('effort not applied');
  });

  // A recorded rate limit is DIAGNOSTIC, not a routing lock. Its predecessor
  // subtracted a cooldown from `available`, which is what made Resume
  // impossible after the user had already switched Claude account or the
  // provider had already recovered: one reported reset timestamp, believed for
  // ten minutes, on a machine where nothing was actually wrong any more.
  it('records a rate limit without making the provider unroutable', async () => {
    const now = new Date('2026-08-23T00:00:00.000Z');
    const router = registry([new FakeProvider('claude'), new FakeProvider('codex')], {
      now: () => now,
    });
    router.recordResult('claude', {
      status: 'failed',
      error: "You've hit your monthly spend limit; your session limit resets at 2026-08-23T05:00Z",
    });

    const claude = (await router.capabilities()).find((c) => c.id === 'claude');
    expect(claude?.available).toBe(true);
    expect(claude?.lastFailureKind).toBe('quota');
    expect(claude?.lastFailureReset).toBe('2026-08-23T05:00:00.000Z');
    expect(router.lastFailure('claude')?.kind).toBe('quota');
    // The very next routing decision may reach it again: only the CLI's own
    // answer decides availability, and by now the account may simply work.
    expect((await router.route('implementer')).provider?.id).toBe('claude');
  });

  it('keeps quota, broken-session, and protocol failures distinct', () => {
    expect(classifyAgentFailure({ status: 'failed', error: 'monthly usage limit exceeded' })).toBe(
      'quota',
    );
    expect(
      classifyAgentFailure({ status: 'failed', error: 'thread could not be resumed: not found' }),
    ).toBe('session_invalid');
    expect(
      classifyAgentFailure({
        status: 'failed',
        error: 'Codex exited without a terminal structured event',
      }),
    ).toBe('protocol');
    // An auth outage is provider health, not a stale thread id, even when the
    // provider phrases it with the word "session".
    expect(
      classifyAgentFailure({ status: 'failed', error: 'your session has expired, log in again' }),
    ).toBe('unavailable');
    expect(classifyAgentFailure({ status: 'failed', error: 'not logged in' })).toBe('unavailable');
    // A resume failure keeps the cheap same-provider retry even when the
    // provider decorates it with an authorization word: only the unambiguous
    // login signals above are allowed to settle as provider health.
    expect(
      classifyAgentFailure({ status: 'failed', error: 'session not found: unauthorized' }),
    ).toBe('session_invalid');
  });
});
