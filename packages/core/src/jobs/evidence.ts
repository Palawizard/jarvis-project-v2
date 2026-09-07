import { createHash } from 'node:crypto';
import type { JarvisConfig } from '../config.js';
import type { VerificationReport, VerificationResult } from '../verification/engine.js';
import type { Job } from './service.js';

/**
 * The evidence model, and the one rule underneath the whole Job pipeline:
 *
 *   EVERY EXPENSIVE RESULT BELONGS TO AN EXACT CANDIDATE COMMIT.
 *
 * A verification report, a review verdict, a Visual QA pass and a final gate
 * are all statements about a specific tree. They stay true for that tree
 * forever and say nothing about any other one. So the question a resume has to
 * answer is never "which stage was I in" — it is "which of these statements
 * still describes the commit that is checked out right now", and everything
 * here exists to answer that deterministically, with no model involved.
 *
 * Nothing in this file performs I/O, spawns anything or reads the clock. It is
 * pure so the pipeline and the UI can call it and get the same answer, which is
 * what lets a paused Job explain what Resume will do before it is pressed.
 */

// ------------------------------------------------------------- fingerprints --

/**
 * Volatile fragments of a test runner's output: they change between two runs of
 * the identical failure and would make every signature unique, which would turn
 * "the fixer made no progress" into "something changed, try again" forever.
 */
const VOLATILE = [
  /\b\d{1,4}(?:\.\d+)?\s?(?:ms|s|seconds?|minutes?)\b/gi,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/g,
  /\b0x[0-9a-f]{4,}\b/gi,
  /\b[0-9a-f]{7,40}\b/gi,
  /:\d+:\d+\b/g,
  /\b(?:pid|PID)[= ]\d+\b/g,
];

function normalizeFailureText(text: string): string {
  let value = text.replace(/\r\n/g, '\n');
  for (const pattern of VOLATILE) value = value.replace(pattern, '·');
  return value
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

/**
 * A stable fingerprint of what deterministic verification found.
 *
 * Built from the failing step set, their statuses and exit codes, plus a
 * normalized tail of each failure's output. Two runs that failed in the same
 * way produce the same string; a run where a check started passing, or where a
 * genuinely different failure surfaced, produces a different one.
 *
 * A PASSING report has no signature: there is nothing to compare.
 */
export function verificationSignature(
  report: Pick<VerificationReport, 'passed' | 'results'>,
): string | null {
  if (report.passed) return null;
  const failures = report.results
    .filter((result) => result.status !== 'passed')
    .map(
      (result: VerificationResult) =>
        `${result.name}|${result.status}|${result.exitCode ?? 'null'}|${
          // The tail is where a runner puts its summary; the head is setup noise.
          normalizeFailureText(result.output).split('\n').slice(-20).join('\n')
        }`,
    )
    .sort();
  if (failures.length === 0) return null;
  const digest = createHash('sha256').update(failures.join('\n---\n')).digest('hex').slice(0, 32);
  // The readable prefix is deliberate: this string lands in an event payload and
  // on the Job row, and "which steps failed" is the part a human wants there.
  const steps = [
    ...new Set(
      report.results.filter((result) => result.status !== 'passed').map((result) => result.name),
    ),
  ]
    .sort()
    .join(',');
  return `${steps}:${digest}`;
}

/** Did the last fixer achieve anything a second one could build on? */
export interface VerificationProgress {
  progressed: boolean;
  reason: string;
}

/**
 * Whether a SECOND verification fixer is justified.
 *
 * The rule replaced a blind cycle counter, which paused a Job that had gone
 * from "unit and integration both fail" to "two stale unit assertions" — real,
 * obvious progress that one more fixer would have finished. It also allowed the
 * opposite: three fixers against a failure that had not moved at all.
 *
 * The first fixer is always allowed; it is what turns a failure into evidence.
 * After that the failure has to have actually changed — a different step set, a
 * different signature, fewer failures, or a candidate that moved and produced
 * a different outcome. An identical signature is the definition of no progress.
 */
export function verificationProgress(input: {
  cycle: number;
  previousSignature: string | null;
  signature: string | null;
  previousFailures?: number;
  failures?: number;
}): VerificationProgress {
  if (input.cycle === 0) return { progressed: true, reason: 'first repair attempt' };
  if (!input.previousSignature) {
    return { progressed: true, reason: 'no previous failure signature to compare' };
  }
  if (input.signature !== input.previousSignature) {
    return {
      progressed: true,
      reason:
        (input.failures ?? 0) < (input.previousFailures ?? 0)
          ? `failures fell ${input.previousFailures} -> ${input.failures}`
          : 'the failure signature changed',
    };
  }
  return {
    progressed: false,
    reason: 'identical failure signature: the previous repair changed nothing that matters',
  };
}

// ------------------------------------------------------- evidence for a head --

export interface CandidateEvidence {
  head: string;
  verified: boolean;
  reviewApproved: boolean;
  reviewBlocked: boolean;
  visualPassed: boolean;
  visualAttempted: boolean;
  finalGatePassed: boolean;
}

/** Which persisted statements still describe `head`. Nothing else. */
export function evidenceFor(job: Job, head: string): CandidateEvidence {
  const at = (value: string | null): boolean => Boolean(value) && value === head;
  return {
    head,
    verified: at(job.verifiedHead),
    reviewApproved: at(job.reviewedHead),
    reviewBlocked: at(job.reviewBlockedHead),
    visualPassed: at(job.visualHead),
    visualAttempted: at(job.visualAttemptHead),
    finalGatePassed: at(job.finalGateHead),
  };
}

/**
 * The evidence patch that a candidate moving from one commit to another makes
 * stale. Applied whenever the candidate HEAD changes, for ANY reason — a fixer
 * committed, an authorised agent committed, a human adopted an external head.
 *
 * Only source-identity-bound evidence is cleared. Counters, the compiled brief,
 * the execution recommendation and every historical row (reviews, verifications,
 * screenshots) are untouched: they remain true statements about the commit they
 * were produced from, and the `head_ref` on each row is what keeps them
 * attributable. Nothing is destroyed; it simply stops matching.
 */
export function staleEvidencePatch(): Partial<Job> {
  return {
    verifiedHead: null,
    reviewedHead: null,
    reviewBlockedHead: null,
    visualHead: null,
    visualAttemptHead: null,
    finalGateHead: null,
  };
}

// ------------------------------------------------------- the next transition --

export type TransitionKind =
  /** No worktree yet: create one and run the implementer. */
  | 'plan'
  /** An interrupted implementer/fixer run with a persisted checkpoint. */
  | 'resume_agent'
  | 'verify'
  | 'verification_repair'
  | 'review'
  | 'review_repair'
  | 'visual_qa'
  | 'visual_repair'
  | 'final_gate'
  /** Every required piece of evidence matches: hand the candidate to the user. */
  | 'finish'
  /** Nothing automatic can improve this candidate. */
  | 'none';

export interface NextTransition {
  kind: TransitionKind;
  /** One line a human can read. Always set. */
  reason: string;
  /** Stages that will NOT re-run because their evidence already matches. */
  reusing: string[];
  /** Only for `none`: what a human can actually do instead. */
  recovery: string[];
}

export interface TransitionInput {
  job: Job;
  /** The commit actually checked out in the candidate worktree. */
  candidateHead: string;
  /**
   * Whether interactive Visual QA is expected to run for this candidate at all.
   * Deterministic and supplied by the caller (project config + changed files);
   * this module never guesses it.
   */
  visualExpected: boolean;
  /** Whether the project declares a closing `kind: 'final'` verification step. */
  finalGateConfigured: boolean;
  /**
   * The visual repair budget the GATE will actually enforce, which is the
   * configured cycles clamped by the interactive agent's own hard budget. Passed
   * in rather than read from config so the planner cannot promise a repair the
   * gate refuses — the two disagreeing is a useless Resume loop.
   */
  maxVisualRepairs: number;
  config: Pick<JarvisConfig, 'pipeline'>;
}

/**
 * THE TRANSITION PLANNER.
 *
 * Resume used to mean "run the stage I was paused in again", which is why a Job
 * that paused waiting for a reviewer re-ran an entire verification suite on a
 * commit it had already verified, and why a Job whose review repair budget was
 * spent re-ran verification AND a second reviewer to arrive back at the same
 * place. This computes the next transition that can actually change something,
 * from persisted evidence and the current commit — and says so when there
 * isn't one, instead of offering a button that spends quota to stand still.
 *
 * Deterministic and total. No model is consulted; a model deciding state
 * transitions is a model that can be talked into skipping a gate.
 */
export function planNextTransition(input: TransitionInput): NextTransition {
  const { job, candidateHead, config } = input;
  const reusing: string[] = [];

  if (!job.worktreePath || !job.baseRef) {
    return {
      kind: 'plan',
      reason: 'no candidate worktree exists yet',
      reusing,
      recovery: [],
    };
  }

  // An interrupted agent run is the one case where the checkpoint, not the
  // evidence, decides: the work it was doing is not represented by any commit.
  if (job.stage === 'paused' && job.resumeStage === 'fixing' && job.repairCheckpoint) {
    return {
      kind: 'resume_agent',
      reason: `an interrupted ${job.repairKind ?? 'repair'} fixer has a recoverable checkpoint`,
      reusing,
      recovery: [],
    };
  }
  // `resumeStage === 'implementing'` is only ever written when implementation
  // did NOT finish: the implementer's own failure pause, or crash recovery
  // checkpointing a Job that was running that stage. So it always means "this
  // implementation is incomplete", and the candidate commit is irrelevant to
  // that question.
  //
  // It used to also require `candidateHead === job.baseRef`, which silently
  // excluded the most common shape of the problem: the agent commits real
  // partial work, THEN hits quota or is interrupted. `recordAgentHead` records
  // that commit — on the exhausted path too — so the candidate had already
  // moved off the base and the planner fell through to `verify`, promoting a
  // half-written implementation into verification, review and Visual QA while
  // the live resumable session went unused.
  //
  // The commit is kept, not reset: the interrupted agent resumes on top of its
  // own work. Trust is unaffected — `assessCandidate` runs before this planner
  // and is what decides whether the commit sitting in the worktree is one
  // Jarvis produced or one a human must explicitly adopt.
  if (job.stage === 'paused' && job.resumeStage === 'implementing' && !job.validationOnly) {
    return {
      kind: 'resume_agent',
      reason:
        candidateHead === job.baseRef
          ? 'the implementer was interrupted before it produced a commit'
          : `the implementer was interrupted after committing ${short(candidateHead)}`,
      reusing,
      recovery: [],
    };
  }

  const evidence = evidenceFor(job, candidateHead);

  if (!evidence.verified) {
    return {
      kind: 'verify',
      reason: job.verifiedHead
        ? `verification evidence describes ${short(job.verifiedHead)}, not ${short(candidateHead)}`
        : 'this candidate has no deterministic verification evidence',
      reusing,
      recovery: [],
    };
  }
  reusing.push(`verification (passed on ${short(candidateHead)})`);

  // --------------------------------------------------------------- review --
  if (!evidence.reviewApproved) {
    if (evidence.reviewBlocked) {
      if (job.validationOnly) {
        return blocked(
          reusing,
          'independent review asked for changes and this is a validation-only Job, ' +
            'so no source fixer may run',
          ['inspect the candidate diff', 'create a repair Job from these findings'],
        );
      }
      if (job.reviewFixCycles >= config.pipeline.maxReviewFixCycles) {
        return blocked(
          reusing,
          `independent review asked for changes on ${short(candidateHead)} and the review ` +
            `repair budget (${config.pipeline.maxReviewFixCycles}) is spent. Reviewing an ` +
            'unchanged candidate again cannot change what is in it',
          [
            'create a continuation Job from this candidate to address the findings',
            'inspect the candidate diff and repair it yourself',
            'abandon the candidate',
          ],
        );
      }
      return {
        kind: 'review_repair',
        reason: 'a batch fixer can still address the review findings for this candidate',
        reusing,
        recovery: [],
      };
    }
    return {
      kind: 'review',
      reason: job.reviewedHead
        ? `the last approved review describes ${short(job.reviewedHead)}`
        : 'this candidate has not been independently reviewed',
      reusing,
      recovery: [],
    };
  }
  reusing.push(`code review (approved ${short(candidateHead)})`);

  // ------------------------------------------------------------ visual QA --
  if (input.visualExpected && !evidence.visualAttempted) {
    return {
      kind: 'visual_qa',
      reason: 'this candidate changed a rendered surface and has no Visual QA result',
      reusing,
      recovery: [],
    };
  }
  if (input.visualExpected && evidence.visualAttempted && job.visualQaStatus === 'product_defect') {
    if (job.validationOnly) {
      return blocked(reusing, 'Visual QA found a product defect and source fixers are disabled', [
        'inspect the captured screenshots',
      ]);
    }
    if (job.visualFixCycles >= input.maxVisualRepairs) {
      return blocked(
        reusing,
        `Visual QA found a product defect on ${short(candidateHead)} and the single visual ` +
          'repair cycle is spent',
        ['inspect the captured screenshots', 'create a continuation Job', 'abandon the candidate'],
      );
    }
    return {
      kind: 'visual_repair',
      reason: 'one visual fixer may still address the evidenced defect',
      reusing,
      recovery: [],
    };
  }
  if (input.visualExpected) reusing.push(`visual QA (${job.visualQaStatus ?? 'recorded'})`);

  // ----------------------------------------------------------- final gate --
  if (input.finalGateConfigured && !evidence.finalGatePassed) {
    return {
      kind: 'final_gate',
      reason: 'the closing verification gate has not passed on this exact candidate',
      reusing,
      recovery: [],
    };
  }
  if (input.finalGateConfigured) reusing.push(`final gate (passed on ${short(candidateHead)})`);

  return {
    kind: 'finish',
    reason: 'every required piece of evidence describes this exact candidate',
    reusing,
    recovery: [],
  };
}

function blocked(reusing: string[], reason: string, recovery: string[]): NextTransition {
  return { kind: 'none', reason, reusing, recovery };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
