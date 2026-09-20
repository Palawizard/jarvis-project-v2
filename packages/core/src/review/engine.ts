import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentRunResult, ProviderId } from '../agents/types.js';
import { classifyChangedPaths, type TaskSignals } from '../agents/policy.js';
import { stripNulls } from '../agents/structured.js';
import type { VerificationReport } from '../verification/engine.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { redactSecrets, redactSecretValues } from '../memory/secrets.js';
import { z } from 'zod';

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file?: string;
  line?: number;
  description: string;
  recommendation: string;
}

export interface Review {
  id: string;
  jobId: string;
  runId: string | null;
  provider: string;
  verdict: 'approve' | 'request_changes' | 'error';
  summary: string;
  findings: ReviewFinding[];
  headRef: string;
  blocking: boolean;
  createdAt: string;
}

export interface ReviewOptions {
  jobId: string;
  cwd: string;
  request: string;
  goal: string;
  acceptance: string[];
  diff: string;
  files: { path: string; added: number; removed: number }[];
  verification: VerificationReport;
  contextPack: string;
  contextPackId: string;
  implementerProvider?: ProviderId;
  implementerSummary: string;
  headRef: string;
  /** Structured signals for the central model policy. Never a model choice. */
  signals?: TaskSignals;
  signal?: AbortSignal;
}

const MAX_DIFF_CHARS = 120_000;
const FINDING_SCHEMA = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    category: z.enum(['correctness', 'security', 'design', 'tests', 'performance', 'style']),
    file: z.string().trim().min(1).optional(),
    line: z.number().int().positive().optional(),
    description: z.string().trim().min(1),
    recommendation: z.string(),
  })
  .strict();
const REVIEW_SCHEMA = z
  .object({
    verdict: z.enum(['approve', 'request_changes']),
    summary: z.string().trim().min(1),
    findings: z.array(FINDING_SCHEMA),
  })
  .strict();

/**
 * The same shape as JSON Schema, handed to the provider as `outputSchemaPath`.
 *
 * This is the actual fix for the failure that used to burn reviewers three at a
 * time: "Reviewer output failed strict structured validation: expected exactly
 * one terminal JSON block". The JSON was only ever ASKED for, in prose, and a
 * model that answered around the fence produced an unusable review — which then
 * looked like a reason to spend another comprehensive reviewer, and another.
 * `--json-schema` / `--output-schema` CONSTRAINS the final message instead, and
 * the adapters return the parsed value as `AgentRunResult.structuredOutput`.
 *
 * The prompt still describes the fields, because the schema says what shape the
 * answer has and the prompt says what it means. And the Zod schema above still
 * re-validates everything: a provider's enforcement is not Jarvis's trust
 * boundary, and this stays fail-closed — an answer that does not validate is
 * an infrastructure failure, never a silent approval.
 */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: {
      type: 'string',
      // The trusted schema is `z.string().trim().min(1)`; a constrained channel
      // that accepts "" manufactures a protocol failure out of an answer the
      // provider believed was valid.
      minLength: 1,
      maxLength: 4000,
      description: '2-4 sentences on what changed and whether it meets the request.',
    },
    findings: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        // Strict Structured Outputs (Codex `--output-schema`) requires EVERY key
        // of `properties` to appear in `required`; an omitted one is rejected
        // outright as `invalid_json_schema` and burns the whole reviewer
        // attempt. An optional field is spelled `required` + nullable instead,
        // and `stripNulls` turns the provider's `null` back into the absence
        // the trusted schema above already expects.
        required: ['severity', 'category', 'file', 'line', 'description', 'recommendation'],
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'info'],
          },
          category: {
            type: 'string',
            enum: ['correctness', 'security', 'design', 'tests', 'performance', 'style'],
          },
          // Nullable, but never empty when it IS a string -- same bound as the
          // trusted `z.string().trim().min(1).optional()`. `minLength` only
          // constrains strings, so `null` still satisfies it.
          file: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
          line: { type: ['integer', 'null'], minimum: 1 },
          description: { type: 'string', minLength: 1, maxLength: 4000 },
          // `checkReviewValue` refuses a blocking finding with an empty
          // recommendation, so the constrained channel must refuse one too.
          recommendation: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
} as const;

/**
 * Independent review pass.
 *
 * The reviewer gets a deliberately narrow input: the request, acceptance
 * criteria, the diff, deterministic verification results and the retrieved
 * memory context — never the implementer's session transcript. A fresh context
 * is the whole point; replaying the implementer's reasoning would just launder
 * its mistakes.
 */
export class ReviewEngine {
  constructor(
    private readonly db: Db,
    private readonly agents: AgentRegistry,
    private readonly bus?: EventBus,
    private readonly config: JarvisConfig = getConfig(),
  ) {}

  /**
   * One comprehensive review, with a BOUNDED provider attempt budget.
   *
   * A reviewer that fails on quota, capacity, a timeout or a protocol error has
   * not reviewed anything, so the alternate provider is tried once and then the
   * Job pauses. It never becomes a chain, and a later Resume starts a fresh
   * bounded attempt rather than being locked out by a recorded cooldown.
   */
  async review(opts: ReviewOptions): Promise<Review> {
    let avoid = opts.implementerProvider;
    let last: Review | undefined;
    const maxAttempts = Math.max(0, this.config.pipeline.providerAttempts - 1);
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      last = await this.reviewOnce(opts, avoid);
      if (last.verdict !== 'error' || opts.signal?.aborted) return last;
      if (last.provider === 'none') return last;
      if (last.provider === 'claude' || last.provider === 'codex') avoid = last.provider;
      this.bus?.emit({
        type: 'agent.stage.retry',
        jobId: opts.jobId,
        payload: { stage: 'reviewing', attempt: attempt + 1, provider: last.provider },
      });
    }
    return last as Review;
  }

  private async reviewOnce(opts: ReviewOptions, avoidProvider?: ProviderId): Promise<Review> {
    this.bus?.emit({
      type: 'review.started',
      jobId: opts.jobId,
      payload: { files: opts.files.length },
    });

    const routed = await this.agents.route('reviewer', {
      avoid: avoidProvider,
      prefer: this.config.agents.reviewerProvider,
      jobId: opts.jobId,
      signals: reviewSignals(opts),
    });
    if (!routed.provider) {
      const review = this.persist({
        jobId: opts.jobId,
        runId: null,
        provider: 'none',
        verdict: 'error',
        summary: `No reviewer available: ${routed.reason}`,
        findings: [],
        headRef: opts.headRef,
        blocking: true,
      });
      this.bus?.emit({
        type: 'review.completed',
        jobId: opts.jobId,
        payload: { verdict: 'error', findings: 0, provider: 'none' },
      });
      return review;
    }

    const prompt = buildReviewPrompt(opts);
    // The schema file lives in the artifacts directory, NEVER in the candidate
    // worktree: a file written there would show up as an uncommitted change and
    // the candidate-identity assertions would (correctly) refuse the review.
    const schemaPath = routed.capabilities.structuredOutput
      ? this.writeReviewSchema(opts.jobId)
      : null;
    const runId = newId('run');
    const startedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, job_id, provider, model, role, cwd, status, context_pack_id, started_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        opts.jobId,
        routed.provider.id,
        routed.decision?.model ?? null,
        'reviewer',
        opts.cwd,
        'running',
        opts.contextPackId,
        startedAt,
      );

    let result: AgentRunResult;
    try {
      result = await routed.provider.run(
        {
          cwd: opts.cwd,
          prompt,
          role: 'reviewer',
          ...(routed.decision?.model ? { model: routed.decision.model } : {}),
          ...(routed.decision?.effort ? { effort: routed.decision.effort } : {}),
          ...(schemaPath ? { outputSchemaPath: schemaPath } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (event) => {
          if (event.kind === 'text') {
            this.bus?.emit({
              type: 'agent.output',
              jobId: opts.jobId,
              runId,
              payload: { role: 'reviewer', text: redactSecrets(event.text).slice(0, 2000) },
            });
          }
        },
      );
    } catch (error) {
      result = {
        status: 'failed',
        result: '',
        error: error instanceof Error ? error.message : String(error),
        memoryProposals: [],
      };
    }

    this.agents.recordResult?.(routed.provider.id, result);

    this.db
      .prepare(
        `UPDATE agent_runs SET status=?, result=?, error=?, external_session_id=?, ended_at=? WHERE id=?`,
      )
      .run(
        result.status,
        redactSecrets(result.result).slice(0, 20_000),
        result.error ? redactSecrets(result.error) : null,
        result.sessionId ?? null,
        nowIso(),
        runId,
      );

    if (result.status !== 'completed') {
      // A reviewer failure is a real, visible state — not a silent approval.
      const review = this.persist({
        jobId: opts.jobId,
        runId,
        provider: routed.provider.id,
        verdict: 'error',
        summary: `Reviewer failed: ${result.error ? redactSecrets(result.error) : 'unknown error'}`,
        findings: [],
        headRef: opts.headRef,
        blocking: true,
      });
      this.bus?.emit({
        type: 'review.completed',
        jobId: opts.jobId,
        runId,
        payload: { verdict: 'error', findings: 0, provider: routed.provider.id },
      });
      return review;
    }

    // Provider-native structured output first; the terminal fenced block is the
    // fallback, for a provider that cannot be constrained AND for a CLI that
    // accepted the flag and answered in prose anyway. The fallback is kept
    // deliberately: making the constrained channel the only way in would turn
    // one CLI regression into "no review is possible", which is the failure
    // this change exists to remove rather than relocate.
    //
    // Nothing is loosened by it. Both paths end at `checkReviewValue`, the same
    // strict schema with the same rules, and an answer that does not validate
    // is an `error` verdict — infrastructure, never a silent approval.
    const parsed =
      result.structuredOutput !== undefined
        ? checkReviewValue(
            result.structuredOutput,
            this.config.pipeline.codeReviewBlockingSeverities,
          )
        : parseReviewOutput(result.result, this.config.pipeline.codeReviewBlockingSeverities);
    if (parsed.verdict === 'error') {
      const protocolError = redactSecrets(
        parsed.summary || 'reviewer returned invalid structured output',
      );
      this.agents.recordResult?.(routed.provider.id, {
        status: 'failed',
        error: `protocol failure: ${protocolError}`,
      });
      this.db
        .prepare(`UPDATE agent_runs SET status='failed', error=? WHERE id=?`)
        .run(`protocol failure: ${protocolError}`, runId);
    }
    const blocking = parsed.findings.some((finding) =>
      this.config.pipeline.codeReviewBlockingSeverities.includes(finding.severity),
    );
    const verdict = parsed.verdict === 'error' ? 'error' : blocking ? 'request_changes' : 'approve';
    const review = this.persist({
      jobId: opts.jobId,
      runId,
      provider: routed.provider.id,
      verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      headRef: opts.headRef,
      blocking: verdict !== 'approve',
    });
    this.bus?.emit({
      type: 'review.completed',
      jobId: opts.jobId,
      runId,
      payload: {
        verdict: review.verdict,
        findings: review.findings.length,
        provider: routed.provider.id,
      },
    });
    return review;
  }

  /** Fixed name, fixed content, outside the candidate worktree. */
  private writeReviewSchema(jobId: string): string | null {
    try {
      const dir = path.join(this.config.artifactsDir, jobId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'review-output-schema.json');
      fs.writeFileSync(file, JSON.stringify(REVIEW_OUTPUT_SCHEMA), { mode: 0o600 });
      return file;
    } catch {
      // A schema Jarvis cannot write costs the constrained path, not the review.
      return null;
    }
  }

  private persist(input: Omit<Review, 'id' | 'createdAt'>): Review {
    const safeInput = redactSecretValues(input) as Omit<Review, 'id' | 'createdAt'>;
    const review: Review = { ...safeInput, id: newId('rev'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO reviews
          (id, job_id, run_id, provider, verdict, summary, findings, head_ref, blocking, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        review.id,
        review.jobId,
        review.runId,
        review.provider,
        review.verdict,
        review.summary,
        JSON.stringify(review.findings),
        review.headRef,
        review.blocking ? 1 : 0,
        review.createdAt,
      );
    return review;
  }

  list(jobId: string): Review[] {
    const rows = this.db
      .prepare('SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      jobId: row.job_id as string,
      runId: (row.run_id as string) ?? null,
      provider: row.provider as string,
      verdict: row.verdict as Review['verdict'],
      summary: row.summary as string,
      findings: parseJson(row.findings as string, [] as ReviewFinding[]),
      headRef: (row.head_ref as string) ?? '',
      blocking: Number(row.blocking) === 1,
      createdAt: row.created_at as string,
    }));
  }
}

/**
 * Deterministic model-policy signals for a review: what the caller declared,
 * plus facts read off the candidate diff itself (paths and numstat, never the
 * implementer's description of what it did).
 */
function reviewSignals(opts: ReviewOptions): TaskSignals {
  const facts = classifyChangedPaths(opts.files.map((file) => file.path));
  return {
    ...opts.signals,
    ...facts,
    linesChanged: opts.files.reduce((total, file) => total + file.added + file.removed, 0),
    failedChecks: opts.verification.results.filter((result) => result.status === 'failed').length,
  };
}

function buildReviewPrompt(opts: ReviewOptions): string {
  const diff =
    opts.diff.length > MAX_DIFF_CHARS
      ? `${opts.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`
      : opts.diff;
  const verification = opts.verification.results
    .map((r) => `- ${r.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`)
    .join('\n');

  return `You are an independent senior code reviewer. You did NOT write this change.

Review the diff below against the request. Be specific and evidence-based. Do not
restate the diff. Do not approve work that fails its acceptance criteria.
This stage reviews code, security, correctness, and tests. Visual QA runs later:
do not reject because screenshots are not present, and do not claim visual validation.

## Original request
${opts.request}

## Normalized goal
${opts.goal}

${opts.acceptance.length ? `## Acceptance criteria\n${opts.acceptance.map((a) => `- ${a}`).join('\n')}\n` : ''}
${opts.contextPack ? `## Project context Jarvis retrieved\n${opts.contextPack}\n` : ''}
## Implementer's summary (claim, not evidence)
${opts.implementerSummary.slice(0, 3000)}

## Deterministic verification Jarvis ran itself
${verification || '(no verification commands configured)'}
${opts.verification.failureSummary ? `\nFailures:\n${opts.verification.failureSummary.slice(0, 6000)}` : ''}

## Changed files
${opts.files.map((f) => `- ${f.path} (+${f.added}/-${f.removed})`).join('\n') || '(none)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

## Required output

Answer with the structured object below. If your runtime constrains the final
message to a schema, that constrained answer IS the review; otherwise reply with
ONE fenced json block and nothing else after it:

\`\`\`json
{
  "verdict": "approve" | "request_changes",
  "summary": "2-4 sentences on what changed and whether it meets the request",
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "correctness | security | design | tests | performance | style",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "what is wrong and why it matters",
      "recommendation": "the specific change to make"
    }
  ]
}
\`\`\`

Use "approve" only if there are no critical or high findings. An empty findings
array is a valid and common answer for a clean change.`;
}

/**
 * Parse the reviewer's JSON block.
 *
 * A reviewer that returns unparseable output is reported as `error`, never
 * silently treated as an approval.
 */
export function parseReviewOutput(
  text: string,
  blockingSeverities: readonly string[] = ['critical', 'high'],
): {
  verdict: Review['verdict'];
  summary: string;
  findings: ReviewFinding[];
} {
  const match = text.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
  const block = match?.[1];
  if (!block) return invalidReview('expected exactly one terminal JSON block');
  try {
    const raw = block.trim();
    if (hasDuplicateJsonKeys(raw)) return invalidReview('duplicate JSON object key');
    return checkReviewValue(JSON.parse(raw), blockingSeverities);
  } catch {
    return invalidReview();
  }
}

/**
 * The trusted validation both paths end at.
 *
 * Whether the object arrived through the provider's constrained-output channel
 * or was scraped out of a fenced block, the same rules decide whether it is a
 * review: the strict schema, a recommendation on every blocking finding, and a
 * `request_changes` that actually names one. The schema was never the loose
 * part — the transport was.
 */
export function checkReviewValue(
  value: unknown,
  blockingSeverities: readonly string[] = ['critical', 'high'],
): { verdict: Review['verdict']; summary: string; findings: ReviewFinding[] } {
  const checked = REVIEW_SCHEMA.safeParse(stripNulls(value));
  if (!checked.success) return invalidReview(checked.error.issues[0]?.message);
  const findings = checked.data.findings as ReviewFinding[];
  const blocking = findings.filter((finding) => blockingSeverities.includes(finding.severity));
  if (blocking.some((finding) => !finding.recommendation.trim())) {
    return invalidReview('blocking findings require a recommendation');
  }
  if (checked.data.verdict === 'request_changes' && blocking.length === 0) {
    return invalidReview('request_changes requires at least one configured blocking finding');
  }
  return {
    verdict: blocking.length ? 'request_changes' : 'approve',
    summary: checked.data.summary,
    findings,
  };
}

function hasDuplicateJsonKeys(text: string): boolean {
  let index = 0;
  let duplicate = false;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? '')) index++;
  };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error('unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    if (text[index] === '{') return object();
    if (text[index] === '[') return array();
    if (text[index] === '"') {
      string();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index] ?? '')) index++;
    JSON.parse(text.slice(start, index));
  };
  const object = (): void => {
    const keys = new Set<string>();
    index++;
    whitespace();
    if (text[index] === '}') return void index++;
    for (;;) {
      whitespace();
      if (text[index] !== '"') throw new Error('invalid JSON object key');
      const key = string();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      whitespace();
      if (text[index++] !== ':') throw new Error('invalid JSON object');
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === '}') return;
      if (delimiter !== ',') throw new Error('invalid JSON object');
    }
  };
  const array = (): void => {
    index++;
    whitespace();
    if (text[index] === ']') return void index++;
    for (;;) {
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === ']') return;
      if (delimiter !== ',') throw new Error('invalid JSON array');
    }
  };
  value();
  whitespace();
  if (index !== text.length) throw new Error('trailing JSON input');
  return duplicate;
}

function invalidReview(detail?: string): {
  verdict: 'error';
  summary: string;
  findings: [];
} {
  return {
    verdict: 'error',
    summary: `Reviewer output failed strict structured validation${detail ? `: ${detail}` : '.'}`,
    findings: [],
  };
}
