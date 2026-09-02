import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agents/types.js';
import {
  hasCompleteClaudeImageReads,
  parseDurableVisualReview,
  parseVisualReview,
  serializeVisualReview,
} from './reviewer.js';

describe('durable visual evidence', () => {
  const digest = 'a'.repeat(64);
  const shotRef = {
    id: 'shot-mobile-home',
    scenarioName: 'mobile home',
    route: '/',
    viewport: 'mobile' as const,
    status: 'captured' as const,
    screenshotPath: `visual-${digest}.png`,
  };
  const reviewedEvidence = [{ shotId: shotRef.id, sha256: digest }];

  it('normalizes structured findings and refuses a pass with a high finding', () => {
    const review = parseVisualReview(
      {
        verdict: 'pass',
        reviewedEvidence,
        findings: [
          {
            severity: 'high',
            scenarioName: 'mobile home',
            route: '/',
            viewport: 'mobile',
            category: 'layout',
            description: 'Primary action is clipped',
            recommendation: 'Allow the action row to wrap',
          },
        ],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('needs_fix');
    expect(review.findings).toHaveLength(1);
  });

  it('rejects needs_fix with only advisory findings', () => {
    const finding = {
      scenarioName: 'tools',
      route: '/',
      viewport: 'desktop' as const,
      category: 'polish',
      description: 'Minor alignment preference',
      recommendation: 'Consider aligning labels',
    };
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        reviewedEvidence: [{ shotId: 'shot-tools', sha256: digest }],
        findings: [
          { ...finding, severity: 'low' },
          { ...finding, severity: 'info' },
        ],
      },
      [
        {
          id: 'shot-tools',
          ...finding,
          status: 'captured',
          screenshotPath: `visual-${digest}.png`,
        },
      ],
    );
    expect(review.verdict).toBe('error');
  });

  it('rejects malformed findings and missing findings arrays', () => {
    expect(
      parseVisualReview({
        verdict: 'needs_fix',
        reviewedEvidence: [],
        findings: [{ severity: 'high' }],
      }).verdict,
    ).toBe('error');
    expect(parseVisualReview({ verdict: 'pass' }).verdict).toBe('error');
  });

  it('rejects a finding that does not match an exact successful shot tuple', () => {
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        reviewedEvidence,
        findings: [
          {
            severity: 'high',
            scenarioName: 'hallucinated',
            route: '/',
            viewport: 'mobile',
            category: 'layout',
            description: 'Imagined issue',
            recommendation: 'Do not fix imagined evidence',
          },
        ],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('error');
    expect(review.error).toContain('unknown or failed');
  });

  it('requires an exact, duplicate-free acknowledgement of every image digest', () => {
    const review = parseVisualReview(
      {
        verdict: 'pass',
        reviewedEvidence: [reviewedEvidence[0], reviewedEvidence[0]],
        findings: [],
      },
      [shotRef],
    );
    expect(review.verdict).toBe('error');
    expect(review.error).toContain('reviewedEvidence');
  });

  it('accepts Claude evidence only after every exact Read completes successfully', () => {
    const first = path.resolve('one.png');
    const second = path.resolve('two.png');
    const events: AgentEvent[] = [
      { kind: 'tool_started', tool: 'Read', id: 'r1', input: { file_path: first } },
      { kind: 'tool_completed', id: 'r1', isError: false },
      { kind: 'tool_started', tool: 'Read', id: 'r2', input: { file_path: second } },
      { kind: 'tool_completed', id: 'r2', isError: true },
    ];
    expect(hasCompleteClaudeImageReads(events, [first, second], process.cwd())).toBe(false);
    events[3] = { kind: 'tool_completed', id: 'r2', isError: false };
    expect(hasCompleteClaudeImageReads(events, [first, second], process.cwd())).toBe(true);
  });
});

describe('durable visual review contract', () => {
  const digest = 'b'.repeat(64);
  const shotRef = {
    id: 'shot-home-desktop',
    scenarioName: 'home',
    route: '/',
    viewport: 'desktop' as const,
    status: 'captured' as const,
    screenshotPath: `visual-${digest}.png`,
  };
  const runtime = parseVisualReview(
    { verdict: 'pass', reviewedEvidence: [{ shotId: shotRef.id, sha256: digest }], findings: [] },
    [shotRef],
  );

  it('round-trips the producer serializer through the strict approval parser', () => {
    // The runtime object carries provider/model; the durable blob must not.
    const durable = serializeVisualReview({ ...runtime, provider: 'claude', model: 'opus' });
    expect(Object.keys(JSON.parse(durable)).sort()).toEqual([
      'findings',
      'reviewedEvidence',
      'verdict',
    ]);
    expect(parseVisualReview(JSON.parse(durable), [shotRef]).verdict).toBe('pass');
  });

  it.each([
    ['null identity', { provider: null, model: null }],
    ['named identity', { provider: 'claude', model: 'opus' }],
  ])('accepts the exact legacy v6 envelope (%s)', (_label, extras) => {
    const legacy = { ...runtime, ...extras };
    // The pre-fix producer persisted the whole runtime object.
    expect(parseVisualReview(legacy, [shotRef]).verdict).toBe('error');
    expect(parseDurableVisualReview(legacy, [shotRef]).verdict).toBe('pass');
  });

  it.each([
    ['unknown extra field', { ...runtime, provider: null, model: null, randomAuthority: 'any' }],
    ['unknown field alone', { ...runtime, randomAuthority: 'any' }],
    ['non-string provider', { ...runtime, provider: { id: 'claude' }, model: null }],
    ['malformed findings', { ...runtime, findings: [{ severity: 'high' }], provider: null }],
    ['malformed evidence', { ...runtime, reviewedEvidence: [{ shotId: shotRef.id }], model: null }],
  ])('fails closed on %s', (_label, value) => {
    expect(parseDurableVisualReview(value, [shotRef]).verdict).toBe('error');
  });
});
