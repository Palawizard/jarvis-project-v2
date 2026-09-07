import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { VerificationReport, VerificationResult } from '../verification/engine.js';
import {
  evidenceFor,
  planNextTransition,
  staleEvidencePatch,
  verificationProgress,
  verificationSignature,
} from './evidence.js';
import type { Job } from './service.js';

const config = loadConfig({
  home: '.jarvis/evidence-test',
  pipeline: {
    ...loadConfig({ home: '.jarvis/evidence-test' }).pipeline,
    maxFixCycles: 2,
    maxReviewFixCycles: 1,
    maxVisualFixCycles: 1,
  },
});

const X = 'a'.repeat(40);
const Y = 'b'.repeat(40);

function result(patch: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: 'v1',
    name: 'unit',
    command: 'pnpm test',
    status: 'failed',
    exitCode: 1,
    output: 'AssertionError: expected 1 to be 2',
    outputPath: null,
    durationMs: 10,
    cycle: 0,
    kind: 'check',
    required: true,
    failureKind: 'product',
    ...patch,
  };
}

function report(results: VerificationResult[]): VerificationReport {
  const passed = results.every((entry) => entry.status === 'passed');
  return {
    results,
    passed,
    ran: results.length,
    failureSummary: passed ? '' : 'failures',
    failureKind: passed ? 'none' : 'product',
  };
}

function job(patch: Partial<Job> = {}): Job {
  return {
    id: 'job_1',
    sessionId: null,
    projectId: 'p',
    request: 'do the thing',
    goal: 'Do the thing',
    acceptance: [],
    compiledBrief: null,
    stage: 'paused',
    status: 'paused',
    error: null,
    branch: 'jarvis/job_1',
    worktreePath: '/tmp/wt',
    baseRef: 'base',
    headRef: X,
    fixCycles: 0,
    reviewFixCycles: 0,
    visualFixCycles: 0,
    resumeStage: 'reviewing',
    pauseReason: null,
    restartReason: null,
    repairKind: null,
    repairCheckpoint: null,
    lastProvider: null,
    resumeSessionId: null,
    verifiedHead: null,
    reviewedHead: null,
    reviewBlockedHead: null,
    visualHead: null,
    visualAttemptHead: null,
    finalGateHead: null,
    verificationSignature: null,
    pauseFailureKind: null,
    executionRecommendation: null,
    candidateBaseSha: null,
    candidateSourceSha: null,
    validationOnly: false,
    visualQaConfig: null,
    visualQaPlan: null,
    visualQaStatus: null,
    episodeId: null,
    archivedAt: null,
    predecessorJobId: null,
    originMessageId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...patch,
  };
}

const plan = (patch: Partial<Job>, extra: Partial<Parameters<typeof planNextTransition>[0]> = {}) =>
  planNextTransition({
    job: job(patch),
    candidateHead: X,
    visualExpected: false,
    finalGateConfigured: false,
    config,
    ...extra,
  });

describe('verification failure signatures', () => {
  it('is stable across runs of the identical failure', () => {
    expect(verificationSignature(report([result()]))).toBe(
      verificationSignature(report([result({ id: 'other' })])),
    );
  });

  it('ignores timings, timestamps, hashes and line/column noise', () => {
    const first = verificationSignature(
      report([
        result({ output: 'FAIL at src/a.ts:12:4 in 1240ms (2026-01-01T00:00:00Z) 9f3ab12' }),
      ]),
    );
    const second = verificationSignature(
      report([result({ output: 'FAIL at src/a.ts:88:1 in 32ms (2026-02-09T11:00:00Z) 44de901' })]),
    );
    expect(first).toBe(second);
  });

  it('changes when a previously failing step starts passing', () => {
    const before = verificationSignature(
      report([result({ name: 'unit' }), result({ id: 'v2', name: 'integration' })]),
    );
    const after = verificationSignature(
      report([
        result({ name: 'unit' }),
        result({ id: 'v2', name: 'integration', status: 'passed', exitCode: 0 }),
      ]),
    );
    expect(after).not.toBe(before);
    expect(after).toContain('unit');
  });

  it('has no signature for a passing report', () => {
    expect(verificationSignature(report([result({ status: 'passed', exitCode: 0 })]))).toBeNull();
  });
});

describe('verification repair progress', () => {
  it('always allows the first fixer', () => {
    expect(
      verificationProgress({ cycle: 0, previousSignature: 'unit:aaa', signature: 'unit:aaa' })
        .progressed,
    ).toBe(true);
  });

  // The production case: unit AND integration failing, then integration green
  // and two stale unit assertions left. A counter paused here; a signature does
  // not, because the failure demonstrably moved.
  it('allows a second fixer when the failure moved', () => {
    const progress = verificationProgress({
      cycle: 1,
      previousSignature: 'integration,unit:aaa',
      signature: 'unit:bbb',
      previousFailures: 2,
      failures: 1,
    });
    expect(progress.progressed).toBe(true);
    expect(progress.reason).toContain('2 -> 1');
  });

  it('refuses a second fixer when the failure is identical', () => {
    const progress = verificationProgress({
      cycle: 1,
      previousSignature: 'unit:aaa',
      signature: 'unit:aaa',
      previousFailures: 1,
      failures: 1,
    });
    expect(progress.progressed).toBe(false);
    expect(progress.reason).toContain('identical failure signature');
  });
});

describe('candidate evidence', () => {
  it('counts only evidence bound to the exact commit', () => {
    const evidence = evidenceFor(job({ verifiedHead: X, reviewedHead: Y }), X);
    expect(evidence.verified).toBe(true);
    expect(evidence.reviewApproved).toBe(false);
  });

  it('clears every source-bound head and nothing else', () => {
    expect(staleEvidencePatch()).toEqual({
      verifiedHead: null,
      reviewedHead: null,
      reviewBlockedHead: null,
      visualHead: null,
      visualAttemptHead: null,
      finalGateHead: null,
    });
  });
});

describe('the transition planner', () => {
  it('plans an implementation when there is no worktree yet', () => {
    expect(plan({ worktreePath: null, baseRef: null }).kind).toBe('plan');
  });

  it('continues an interrupted fixer from its checkpoint', () => {
    const next = plan({
      resumeStage: 'fixing',
      repairKind: 'verification',
      repairCheckpoint: {
        kind: 'verification',
        verification: { resultIds: ['v1'], cycle: 0, failureSummary: 'boom' },
      },
    });
    expect(next.kind).toBe('resume_agent');
  });

  // CASE 1 from the redesign: verified on X, the reviewer's provider was
  // unavailable. Verification must not run again.
  it('goes straight to review when verification already passed on this commit', () => {
    const next = plan({ verifiedHead: X });
    expect(next.kind).toBe('review');
    expect(next.reusing.join(' ')).toContain('verification');
  });

  it('re-verifies when the verification evidence describes another commit', () => {
    const next = plan({ verifiedHead: Y });
    expect(next.kind).toBe('verify');
    expect(next.reason).toContain(Y.slice(0, 8));
  });

  // CASE 2: nothing automatic can help, and saying so is the whole point.
  it('refuses to spend anything when the review repair budget is exhausted', () => {
    const next = plan({ verifiedHead: X, reviewBlockedHead: X, reviewFixCycles: 1 });
    expect(next.kind).toBe('none');
    expect(next.reason).toContain('review repair budget');
    expect(next.recovery.join(' ')).toContain('continuation');
    expect(next.reusing.join(' ')).toContain('verification');
  });

  it('offers the batch fixer while the review repair budget remains', () => {
    const next = plan({ verifiedHead: X, reviewBlockedHead: X, reviewFixCycles: 0 });
    expect(next.kind).toBe('review_repair');
  });

  it('does not re-review a commit an approval already describes', () => {
    expect(plan({ verifiedHead: X, reviewedHead: X }).kind).toBe('finish');
  });

  it('runs Visual QA only while it has no result for this commit', () => {
    const pending = plan({ verifiedHead: X, reviewedHead: X }, { visualExpected: true });
    expect(pending.kind).toBe('visual_qa');
    const done = plan(
      { verifiedHead: X, reviewedHead: X, visualAttemptHead: X, visualQaStatus: 'passed' },
      { visualExpected: true },
    );
    expect(done.kind).toBe('finish');
  });

  it('stops on an evidenced visual defect whose single repair is spent', () => {
    const next = plan(
      {
        verifiedHead: X,
        reviewedHead: X,
        visualAttemptHead: X,
        visualQaStatus: 'product_defect',
        visualFixCycles: 1,
      },
      { visualExpected: true },
    );
    expect(next.kind).toBe('none');
  });

  it('runs the final gate once and then finishes', () => {
    expect(plan({ verifiedHead: X, reviewedHead: X }, { finalGateConfigured: true }).kind).toBe(
      'final_gate',
    );
    expect(
      plan({ verifiedHead: X, reviewedHead: X, finalGateHead: X }, { finalGateConfigured: true })
        .kind,
    ).toBe('finish');
  });

  // CASE 3: the candidate moved, so only the evidence bound to the old commit
  // is stale — and the planner asks for exactly the stage that lost its answer.
  it('re-runs only what a changed candidate invalidated', () => {
    const moved = planNextTransition({
      job: job({ verifiedHead: X, reviewedHead: X, headRef: Y }),
      candidateHead: Y,
      visualExpected: false,
      finalGateConfigured: false,
      config,
    });
    expect(moved.kind).toBe('verify');
  });

  // A Job written before schema 17 has no evidence heads at all. It must open,
  // and it must fall back to running the stages rather than claiming evidence.
  it('falls back conservatively for a Job with no recorded evidence', () => {
    const next = plan({});
    expect(next.kind).toBe('verify');
    expect(next.reason).toContain('no deterministic verification evidence');
  });
});
