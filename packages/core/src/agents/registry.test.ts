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
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: this.available,
      authenticated: this.available,
      streaming: true,
      resumable: true,
      models: this.id === 'claude' ? ['opus', 'sonnet', 'haiku'] : [],
      structuredOutput: true,
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

function registry(
  providers: AgentProvider[],
  opts: { now?: () => Date; cooldownMs?: number } = {},
) {
  const config = loadConfig({
    home: '.jarvis/router-test',
    agents: {
      implementerProvider: undefined,
      reviewerProvider: undefined,
      claudeModel: 'sonnet',
      claudePermissionMode: 'acceptEdits',
      codexModel: undefined,
      runTimeoutMs: 1000,
      cooldownMs: opts.cooldownMs ?? 60_000,
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

  it('selects inspectable model profiles without an LLM classifier', async () => {
    const router = registry([new FakeProvider('claude')]);
    expect(
      (await router.route('implementer', { taskProfile: { mechanical: true } })).decision.model,
    ).toBe('haiku');
    expect(
      (await router.route('implementer', { taskProfile: { selfDevelopment: true } })).decision
        .model,
    ).toBe('opus');
  });

  it('puts a rate-limited provider on a temporary cooldown', async () => {
    let now = new Date('2026-08-23T00:00:00.000Z');
    const router = registry([new FakeProvider('claude'), new FakeProvider('codex')], {
      now: () => now,
      cooldownMs: 60_000,
    });
    router.recordResult('claude', {
      status: 'failed',
      error: "You've hit your monthly spend limit; your session limit resets later",
    });
    expect((await router.route('implementer')).provider?.id).toBe('codex');
    expect(
      (await router.capabilities()).find((c) => c.id === 'claude')?.cooldownUntil,
    ).toBeTruthy();
    now = new Date('2026-08-23T00:01:01.000Z');
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
