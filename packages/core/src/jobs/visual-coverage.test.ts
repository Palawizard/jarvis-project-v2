import { describe, expect, it } from 'vitest';
import { checkVisualCoverage } from './pipeline.js';
import { EVIDENCE_COVERAGE_PREFIX, type VisualQaShot } from '../visualqa/engine.js';
import { parseVisualReview } from '../visualqa/reviewer.js';
import { resolveVisualPlan, selfSurfaceScenario, type VisualQaPlan } from '../visualqa/surfaces.js';

const HEAD = 'a'.repeat(40);

const plan: VisualQaPlan = {
  source: 'changed_surface',
  scenarios: [selfSurfaceScenario('job-detail-paused')],
  reasons: ['apps/web/src/views/JobDetail.tsx -> job-detail-paused'],
  fixtures: ['paused-job'],
};

function shot(overrides: Partial<VisualQaShot> = {}): VisualQaShot {
  return {
    id: `vqa_${Math.random().toString(36).slice(2)}`,
    scenarioName: 'job-detail-paused',
    route: '/',
    viewport: 'desktop',
    screenshotPath: 'C:/artifacts/shot.png',
    consoleErrors: [],
    networkFailures: [],
    status: 'captured',
    error: null,
    reviewedBy: null,
    reviewVerdict: null,
    reviewFindings: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    headRef: HEAD,
    cycle: 0,
    ...overrides,
  };
}

const complete = [shot({ viewport: 'desktop' }), shot({ viewport: 'mobile' })];

describe('deterministic evidence coverage', () => {
  it('passes when every planned scenario and viewport was captured at the exact HEAD', () => {
    expect(checkVisualCoverage(plan, complete, HEAD)).toBeNull();
  });

  it('reports insufficient_evidence when a declared selector was never reached', () => {
    const unreached = [
      complete[0] as VisualQaShot,
      shot({
        viewport: 'mobile',
        status: 'failed',
        screenshotPath: null,
        error: `${EVIDENCE_COVERAGE_PREFIX}scenario job-detail-paused did not reach [data-testid='pause-explanation']`,
      }),
    ];
    const outcome = checkVisualCoverage(plan, unreached, HEAD);
    expect(outcome?.kind).toBe('insufficient_evidence');
    expect(outcome?.error).toContain('QA plan/fixture problem, not a product defect');
  });

  it('reports insufficient_evidence when a planned viewport is entirely absent', () => {
    const outcome = checkVisualCoverage(plan, [complete[0] as VisualQaShot], HEAD);
    expect(outcome?.kind).toBe('insufficient_evidence');
    expect(outcome?.error).toContain('job-detail-paused - mobile');
    expect(outcome?.error).toContain('No source fix can create a missing screenshot');
  });

  it('reports infrastructure for a browser/capture failure', () => {
    const outcome = checkVisualCoverage(
      plan,
      [
        complete[0] as VisualQaShot,
        shot({
          viewport: 'mobile',
          status: 'failed',
          screenshotPath: null,
          error: 'Playwright unavailable: browser not installed',
        }),
      ],
      HEAD,
    );
    expect(outcome?.kind).toBe('infrastructure');
  });

  it('rejects evidence that does not match the exact candidate HEAD', () => {
    const stale = complete.map((item) => ({ ...item, headRef: 'b'.repeat(40) }));
    const outcome = checkVisualCoverage(plan, stale, HEAD);
    expect(outcome?.kind).toBe('infrastructure');
    expect(outcome?.error).toContain('exact candidate HEAD');
  });

  it('never classifies missing evidence as a product defect', () => {
    const outcomes = [
      checkVisualCoverage(plan, [complete[0] as VisualQaShot], HEAD),
      checkVisualCoverage(plan, [], HEAD),
    ];
    for (const outcome of outcomes) {
      expect(outcome?.kind).not.toBe('product_needs_fix');
      expect(outcome?.kind).toBe('insufficient_evidence');
    }
  });
});

describe('reviewer evidence-coverage output', () => {
  const shots = complete;
  const evidence = shots.map((item) => ({
    shotId: item.id,
    sha256: 'c'.repeat(64),
  }));
  const sealed = shots.map((item, index) => ({
    ...item,
    screenshotPath: `C:/artifacts/shot-${index}-${'c'.repeat(64)}.png`,
  }));
  const sealedEvidence = sealed.map((item) => ({ shotId: item.id, sha256: 'c'.repeat(64) }));

  it('maps an insufficient_evidence verdict to a non-fixable state', () => {
    const review = parseVisualReview(
      {
        verdict: 'insufficient_evidence',
        reviewedEvidence: sealedEvidence,
        findings: [
          {
            severity: 'high',
            scenarioName: 'job-detail-paused',
            route: '/',
            viewport: 'desktop',
            category: 'evidence-coverage',
            description: 'the changed Resume explanation is not visible in any screenshot',
            recommendation: 'capture the paused JobDetail surface',
          },
        ],
      },
      sealed,
    );
    // A high-severity finding would normally block; the explicit evidence
    // verdict must survive it, so no source fixer can ever be invoked.
    expect(review.verdict).toBe('insufficient_evidence');
    expect(review.verdict).not.toBe('needs_fix');
    expect(evidence).toHaveLength(2);
  });

  it('still requires a blocking finding for a real needs_fix verdict', () => {
    const review = parseVisualReview(
      { verdict: 'needs_fix', reviewedEvidence: sealedEvidence, findings: [] },
      sealed,
    );
    expect(review.verdict).toBe('error');
  });

  it('accepts a genuine visible product regression on the planned surface', () => {
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        reviewedEvidence: sealedEvidence,
        findings: [
          {
            severity: 'high',
            scenarioName: 'job-detail-paused',
            route: '/',
            viewport: 'desktop',
            category: 'layout',
            description: 'the pause explanation overflows and clips the Resume button',
            recommendation: 'wrap the explanation text',
          },
        ],
      },
      sealed,
    );
    expect(review.verdict).toBe('needs_fix');
  });

  it('rejects a finding about a surface that was never captured', () => {
    const review = parseVisualReview(
      {
        verdict: 'needs_fix',
        reviewedEvidence: sealedEvidence,
        findings: [
          {
            severity: 'high',
            scenarioName: 'tools',
            route: '/',
            viewport: 'desktop',
            category: 'layout',
            description: 'mobile nav overlaps the Tools table',
            recommendation: 'adjust Tools styling',
          },
        ],
      },
      sealed,
    );
    // A JobDetail-only task captures no Tools evidence, so a Tools finding
    // cannot reach the visual fixer at all.
    expect(review.verdict).toBe('error');
    expect(review.error).toContain('unknown or failed visual shot');
  });
});

describe('plan drives which findings may block', () => {
  it('a JobDetail-only diff never plans the Tools surface', () => {
    const resolved = resolveVisualPlan(
      { visualQaConfig: null } as never,
      {
        isSelf: true,
        config: {
          visualQa: { required: true, scenarios: [selfSurfaceScenario('chat-workspace')] },
        },
        stack: {},
      } as never,
      ['apps/web/src/views/JobDetail.tsx'],
    );
    const planned = new Set((resolved?.scenarios ?? []).map((scenario) => scenario.name));
    expect(planned.has('job-detail-paused')).toBe(true);
    expect(planned.has('tools')).toBe(false);
  });
});
