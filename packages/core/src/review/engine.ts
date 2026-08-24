import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentRunResult, ProviderId, TaskProfile } from '../agents/types.js';
import type { VerificationReport } from '../verification/engine.js';
import { getConfig, type JarvisConfig } from '../config.js';
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
  taskProfile?: TaskProfile;
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

  async review(opts: ReviewOptions): Promise<Review> {
    let avoid = opts.implementerProvider;
    let last: Review | undefined;
    for (let attempt = 0; attempt <= this.config.pipeline.agentStageRetries; attempt++) {
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
      taskProfile: opts.taskProfile,
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
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (event) => {
          if (event.kind === 'text') {
            this.bus?.emit({
              type: 'agent.output',
              jobId: opts.jobId,
              runId,
              payload: { role: 'reviewer', text: event.text.slice(0, 2000) },
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
        result.result.slice(0, 20_000),
        result.error ?? null,
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
        summary: `Reviewer failed: ${result.error ?? 'unknown error'}`,
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

    const parsed = parseReviewOutput(
      result.result,
      this.config.pipeline.codeReviewBlockingSeverities,
    );
    if (parsed.verdict === 'error') {
      const protocolError = parsed.summary || 'reviewer returned invalid structured output';
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

  private persist(input: Omit<Review, 'id' | 'createdAt'>): Review {
    const review: Review = { ...input, id: newId('rev'), createdAt: nowIso() };
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

Reply with ONE fenced json block and nothing else after it:

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
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter(Boolean);
  const block = blocks.at(-1);
  if (!block) return invalidReview();
  try {
    const checked = REVIEW_SCHEMA.safeParse(JSON.parse(block.trim()));
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
  } catch {
    return invalidReview();
  }
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
