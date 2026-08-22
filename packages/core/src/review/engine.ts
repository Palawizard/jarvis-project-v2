import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { newId, nowIso } from '../ids.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ProviderId } from '../agents/types.js';
import type { VerificationReport } from '../verification/engine.js';

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
  createdAt: string;
}

const MAX_DIFF_CHARS = 120_000;

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
  ) {}

  async review(opts: {
    jobId: string;
    cwd: string;
    request: string;
    goal: string;
    acceptance: string[];
    diff: string;
    files: { path: string; added: number; removed: number }[];
    verification: VerificationReport;
    contextPack: string;
    implementerProvider: ProviderId;
    implementerSummary: string;
    signal?: AbortSignal;
  }): Promise<Review> {
    this.bus?.emit({ type: 'review.started', jobId: opts.jobId, payload: { files: opts.files.length } });

    const routed = await this.agents.route('reviewer', { avoid: opts.implementerProvider });
    if (!routed.provider) {
      return this.persist({
        jobId: opts.jobId,
        runId: null,
        provider: 'none',
        verdict: 'error',
        summary: `No reviewer available: ${routed.reason}`,
        findings: [],
      });
    }

    const prompt = buildReviewPrompt(opts);
    const runId = newId('run');
    const startedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, job_id, provider, model, role, cwd, status, started_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(runId, opts.jobId, routed.provider.id, null, 'reviewer', opts.cwd, 'running', startedAt);

    const result = await routed.provider.run(
      {
        cwd: opts.cwd,
        prompt,
        role: 'reviewer',
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

    this.db
      .prepare(`UPDATE agent_runs SET status=?, result=?, error=?, external_session_id=?, ended_at=? WHERE id=?`)
      .run(
        result.status === 'completed' ? 'completed' : 'failed',
        result.result.slice(0, 20_000),
        result.error ?? null,
        result.sessionId ?? null,
        nowIso(),
        runId,
      );

    if (result.status !== 'completed') {
      // A reviewer failure is a real, visible state — not a silent approval.
      return this.persist({
        jobId: opts.jobId,
        runId,
        provider: routed.provider.id,
        verdict: 'error',
        summary: `Reviewer failed: ${result.error ?? 'unknown error'}`,
        findings: [],
      });
    }

    const parsed = parseReviewOutput(result.result);
    const review = this.persist({
      jobId: opts.jobId,
      runId,
      provider: routed.provider.id,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
    });
    this.bus?.emit({
      type: 'review.completed',
      jobId: opts.jobId,
      runId,
      payload: { verdict: review.verdict, findings: review.findings.length, provider: routed.provider.id },
    });
    return review;
  }

  private persist(input: Omit<Review, 'id' | 'createdAt'>): Review {
    const review: Review = { ...input, id: newId('rev'), createdAt: nowIso() };
    this.db
      .prepare(
        'INSERT INTO reviews (id, job_id, run_id, provider, verdict, summary, findings, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        review.id,
        review.jobId,
        review.runId,
        review.provider,
        review.verdict,
        review.summary,
        JSON.stringify(review.findings),
        review.createdAt,
      );
    return review;
  }

  list(jobId: string): Review[] {
    const rows = this.db
      .prepare('SELECT * FROM reviews WHERE job_id = ? ORDER BY created_at ASC')
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      jobId: row.job_id as string,
      runId: (row.run_id as string) ?? null,
      provider: row.provider as string,
      verdict: row.verdict as Review['verdict'],
      summary: row.summary as string,
      findings: parseJson(row.findings as string, [] as ReviewFinding[]),
      createdAt: row.created_at as string,
    }));
  }
}

function buildReviewPrompt(opts: {
  request: string;
  goal: string;
  acceptance: string[];
  diff: string;
  files: { path: string; added: number; removed: number }[];
  verification: VerificationReport;
  contextPack: string;
  implementerSummary: string;
}): string {
  const diff = opts.diff.length > MAX_DIFF_CHARS ? `${opts.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : opts.diff;
  const verification = opts.verification.results
    .map((r) => `- ${r.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`)
    .join('\n');

  return `You are an independent senior code reviewer. You did NOT write this change.

Review the diff below against the request. Be specific and evidence-based. Do not
restate the diff. Do not approve work that fails its acceptance criteria.

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
export function parseReviewOutput(text: string): {
  verdict: Review['verdict'];
  summary: string;
  findings: ReviewFinding[];
} {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).filter(Boolean);
  // Prefer the last block: models often show an example before their answer.
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse((block as string).trim()) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || !('verdict' in parsed)) continue;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.flatMap((f) => {
            const finding = normaliseFinding(f);
            return finding ? [finding] : [];
          })
        : [];
      const hasBlocking = findings.some((f) => f.severity === 'critical' || f.severity === 'high');
      const claimed = parsed.verdict === 'approve' ? 'approve' : 'request_changes';
      return {
        // Consistency guard: a reviewer cannot approve while reporting blockers.
        verdict: hasBlocking ? 'request_changes' : claimed,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        findings,
      };
    } catch {
      continue;
    }
  }
  return {
    verdict: 'error',
    summary: 'Reviewer output could not be parsed as structured findings.',
    findings: [],
  };
}

function normaliseFinding(raw: unknown): ReviewFinding | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (!description) return null;
  const severities: ReviewFinding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];
  return {
    severity: severities.includes(obj.severity as ReviewFinding['severity'])
      ? (obj.severity as ReviewFinding['severity'])
      : 'medium',
    category: typeof obj.category === 'string' ? obj.category : 'general',
    ...(typeof obj.file === 'string' ? { file: obj.file } : {}),
    ...(typeof obj.line === 'number' ? { line: obj.line } : {}),
    description,
    recommendation: typeof obj.recommendation === 'string' ? obj.recommendation : '',
  };
}
