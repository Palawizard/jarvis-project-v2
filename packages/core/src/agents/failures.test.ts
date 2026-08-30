import { describe, expect, it } from 'vitest';
import {
  INFRASTRUCTURE_FAILURE_KINDS,
  classifyAgentFailure,
  describeAgentFailure,
  parseQuotaReset,
} from './registry.js';

/**
 * Provider failures must not collapse into "agent reported an error".
 *
 * The distinction is not cosmetic: an infrastructure failure pauses the Job and
 * must never reach a source fixer, while a genuine agent failure may. These are
 * the exact phrasings Claude Code and Codex produce.
 */
describe('agent failure classification', () => {
  const quota = [
    'Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles)',
    'You have reached your monthly spend limit for this workspace.',
    'session limit reached — try again later',
    'Error: 429 Too Many Requests',
    'rate limit exceeded for this model',
    'You are out of credits.',
    'Upgrade to increase your usage limit.',
    'stream error: quota exhausted',
  ];
  it.each(quota)('classifies provider usage limits as quota: %s', (error) => {
    expect(classifyAgentFailure({ status: 'failed', error })).toBe('quota');
  });

  const sessionInvalid = [
    'Session not found: sess-123',
    'the conversation could not be resumed',
    'No such thread',
    '--resume failed: unknown session id',
    'thread expired',
  ];
  it.each(sessionInvalid)('classifies a dead external session: %s', (error) => {
    expect(classifyAgentFailure({ status: 'failed', error })).toBe('session_invalid');
  });

  it('separates the remaining known categories', () => {
    expect(classifyAgentFailure({ status: 'cancelled' })).toBe('cancelled');
    expect(classifyAgentFailure({ status: 'timeout' })).toBe('timeout');
    expect(classifyAgentFailure({ status: 'failed', error: 'in cooldown until later' })).toBe(
      'cooldown',
    );
    expect(classifyAgentFailure({ status: 'failed', error: 'Claude Code CLI not found' })).toBe(
      'unavailable',
    );
    expect(
      classifyAgentFailure({
        status: 'failed',
        error: 'Claude Code exited without a terminal structured event',
      }),
    ).toBe('protocol');
    expect(classifyAgentFailure({ status: 'failed', error: 'malformed JSONL on stdout' })).toBe(
      'protocol',
    );
  });

  it('only calls a real agent error an agent error', () => {
    const kind = classifyAgentFailure({
      status: 'failed',
      error: 'I could not complete the requested refactor',
    });
    expect(kind).toBe('agent_failure');
    expect(INFRASTRUCTURE_FAILURE_KINDS).not.toContain(kind);
  });

  it('treats every provider-state category as infrastructure, never as a source defect', () => {
    for (const error of [...quota, ...sessionInvalid]) {
      expect(INFRASTRUCTURE_FAILURE_KINDS).toContain(
        classifyAgentFailure({ status: 'failed', error }),
      );
    }
  });

  it('says plainly that a quota pause is provider state, not a code problem', () => {
    const reason = describeAgentFailure(
      'quota',
      'usage limit reached; resets at 2026-08-25T15:00Z',
    );
    expect(reason).toContain('provider state, not a problem with the code');
    expect(reason).toContain('2026-08-25T15:00:00.000Z');
  });

  it('reports a reset time only when the provider named one', () => {
    expect(parseQuotaReset('limit resets at 2026-08-25T15:00Z')).toBe('2026-08-25T15:00:00.000Z');
    expect(parseQuotaReset('Your limit will reset at 3pm (America/Los_Angeles)')).toContain('3pm');
    // Honest rather than invented: an unparsable phrase yields nothing.
    expect(parseQuotaReset('you have run out of usage')).toBeNull();
    expect(parseQuotaReset(undefined)).toBeNull();
  });
});
