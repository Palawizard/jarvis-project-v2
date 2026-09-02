import path from 'node:path';
import type { AgentEvent, ProviderId } from '../agents/types.js';
import type { VisualQaShot, VisualReviewFinding } from './engine.js';
import { z } from 'zod';

/**
 * The durable visual-evidence contract.
 *
 * Interactive Visual QA (see `agent.ts`) produces the judgement; this module
 * owns the envelope it is persisted in and the strict parser the approval path
 * re-validates it with. `insufficient_evidence` describes our own evidence, not
 * the product, so it can never reach a source fixer.
 */
export interface VisualReview {
  verdict: 'pass' | 'needs_fix' | 'insufficient_evidence' | 'error';
  findings: VisualReviewFinding[];
  reviewedEvidence?: Array<{ shotId: string; sha256: string }>;
  provider: ProviderId | null;
  model: string | null;
  error?: string;
}

const VISUAL_FINDING_SCHEMA = z
  .object({
    severity: z.enum(['high', 'medium', 'low', 'info']),
    scenarioName: z.string().trim().min(1),
    route: z.string().min(1),
    viewport: z.enum(['desktop', 'mobile']),
    category: z.string().trim().min(1),
    description: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
  })
  .strict();

const VISUAL_REVIEW_SCHEMA = z
  .object({
    verdict: z.enum(['pass', 'needs_fix', 'insufficient_evidence']),
    reviewedEvidence: z.array(
      z.object({ shotId: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
    findings: z.array(VISUAL_FINDING_SCHEMA),
  })
  .strict();

const DURABLE_KEYS = ['verdict', 'reviewedEvidence', 'findings'] as const;

/**
 * The canonical durable visual-review evidence payload. Provider/model identity
 * lives in `visual_qa.reviewed_by` and agent run metadata, never inside the
 * strict evidence blob that approval re-validates.
 */
export function serializeVisualReview(review: VisualReview): string {
  return JSON.stringify({
    verdict: review.verdict,
    reviewedEvidence: review.reviewedEvidence ?? [],
    findings: review.findings,
  });
}

/**
 * v6 rows were written from the runtime object, so they carry exactly two known
 * extras. Drop only those, only when the rest of the envelope is the exact
 * runtime shape; anything else is returned untouched so strict parsing rejects
 * it. Removable once pre-fix rows have aged out.
 */
function canonicalizeDurableVisualReview(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes('provider') && !keys.includes('model')) return value;
  if (
    keys.some(
      (key) =>
        !DURABLE_KEYS.includes(key as (typeof DURABLE_KEYS)[number]) &&
        key !== 'provider' &&
        key !== 'model',
    )
  ) {
    return value;
  }
  if (record.provider !== null && typeof record.provider !== 'string') return value;
  if (record.model !== null && typeof record.model !== 'string') return value;
  const { provider: _provider, model: _model, ...durable } = record;
  return durable;
}

/** Approval-side reader for persisted evidence: legacy-tolerant, then strict. */
export function parseDurableVisualReview(
  ...args: Parameters<typeof parseVisualReview>
): VisualReview {
  const [value, ...rest] = args;
  return parseVisualReview(canonicalizeDurableVisualReview(value), ...rest);
}

export function parseVisualReview(
  value: unknown,
  shots: Pick<
    VisualQaShot,
    'id' | 'scenarioName' | 'route' | 'viewport' | 'status' | 'screenshotPath'
  >[] = [],
  blockingSeverities: readonly string[] = ['high', 'medium'],
): VisualReview {
  const checked = VISUAL_REVIEW_SCHEMA.safeParse(value);
  if (!checked.success) return invalidVisual(checked.error.issues[0]?.message);
  const findings = checked.data.findings as VisualReviewFinding[];
  const reviewedEvidence = checked.data.reviewedEvidence;
  const expectedEvidence = shots.flatMap((shot) => {
    const sha256 = screenshotDigest(shot.screenshotPath);
    return shot.status === 'captured' && sha256 ? [{ shotId: shot.id, sha256 }] : [];
  });
  if (
    reviewedEvidence.length !== expectedEvidence.length ||
    new Set(reviewedEvidence.map((item) => JSON.stringify([item.shotId, item.sha256]))).size !==
      reviewedEvidence.length ||
    expectedEvidence.some(
      (expected) =>
        !reviewedEvidence.some(
          (actual) => actual.shotId === expected.shotId && actual.sha256 === expected.sha256,
        ),
    )
  ) {
    return invalidVisual('reviewedEvidence does not match every exact captured image');
  }
  const evidence = new Set(
    shots
      .filter((shot) => shot.status === 'captured')
      .map((shot) => JSON.stringify([shot.scenarioName, shot.route, shot.viewport])),
  );
  if (
    findings.some(
      (finding) =>
        !evidence.has(JSON.stringify([finding.scenarioName, finding.route, finding.viewport])),
    )
  ) {
    return invalidVisual('finding references an unknown or failed visual shot');
  }
  const blocking = findings.filter((finding) => blockingSeverities.includes(finding.severity));
  // A reviewer that could not see the target surface reports an evidence
  // problem. That is a QA-plan defect, so it never becomes a source-fix verdict.
  if (checked.data.verdict === 'insufficient_evidence') {
    return {
      verdict: 'insufficient_evidence',
      reviewedEvidence,
      findings,
      provider: null,
      model: null,
    };
  }
  if (checked.data.verdict === 'needs_fix' && blocking.length === 0) {
    return invalidVisual('needs_fix requires at least one configured blocking finding');
  }
  return {
    verdict: blocking.length ? 'needs_fix' : 'pass',
    reviewedEvidence,
    findings,
    provider: null,
    model: null,
  };
}

function invalidVisual(error = 'invalid output'): VisualReview {
  return { verdict: 'error', findings: [], provider: null, model: null, error };
}

function screenshotDigest(screenshotPath: string | null): string | null {
  return (
    /-([0-9a-f]{64})\.png$/i.exec(path.basename(screenshotPath ?? ''))?.[1]?.toLowerCase() ?? null
  );
}

export function hasCompleteClaudeImageReads(
  events: AgentEvent[],
  images: string[],
  cwd: string,
): boolean {
  const key = (value: string) => {
    const resolved = path.resolve(cwd, value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const reads = new Map<string, string>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool_started' && event.id && event.tool.toLowerCase() === 'read') {
      const input = event.input as { file_path?: unknown; path?: unknown } | undefined;
      const file = input?.file_path ?? input?.path;
      if (typeof file === 'string') reads.set(event.id, key(file));
    } else if (event.kind === 'tool_completed' && event.id && event.isError !== true) {
      const file = reads.get(event.id);
      if (file) completed.add(file);
    }
  }
  return images.length > 0 && images.every((image) => completed.has(key(image)));
}
