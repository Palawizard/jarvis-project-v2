import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { JobService } from '../jobs/service.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ProviderId } from '../agents/types.js';
import type { VisualQaShot, VisualReviewFinding } from './engine.js';

export interface VisualReview {
  verdict: 'pass' | 'needs_fix' | 'error';
  findings: VisualReviewFinding[];
  provider: ProviderId | null;
  model: string | null;
  error?: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'needs_fix'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'route', 'viewport', 'category', 'description', 'recommendation'],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
          route: { type: 'string' },
          viewport: { type: 'string', enum: ['desktop', 'mobile'] },
          category: { type: 'string' },
          description: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    },
  },
} as const;

export class VisualReviewer {
  constructor(
    private readonly db: Db,
    private readonly agents: AgentRegistry,
    private readonly jobs: JobService,
    private readonly artifactsDir: string,
    private readonly bus?: EventBus,
  ) {}

  async review(opts: {
    jobId: string;
    cwd: string;
    goal: string;
    acceptance: string[];
    shots: VisualQaShot[];
    implementerProvider: ProviderId;
    selfDevelopment?: boolean;
    signal?: AbortSignal;
  }): Promise<VisualReview> {
    const images = opts.shots.flatMap((shot) =>
      shot.status === 'captured' && shot.screenshotPath && fs.existsSync(shot.screenshotPath)
        ? [shot.screenshotPath]
        : [],
    );
    if (images.length !== opts.shots.length || images.length === 0) {
      return this.fail(opts.jobId, 'visual evidence is missing or incomplete');
    }

    this.bus?.emit({
      type: 'visual_review.started',
      jobId: opts.jobId,
      payload: { images: images.length },
    });
    const routed = await this.agents.route('visual_reviewer', {
      avoid: opts.implementerProvider,
      jobId: opts.jobId,
      taskProfile: { selfDevelopment: opts.selfDevelopment },
    });
    if (!routed.provider) return this.fail(opts.jobId, routed.reason);

    const schemaPath = path.join(this.artifactsDir, opts.jobId, 'visual-qa', 'review-schema.json');
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.writeFileSync(schemaPath, JSON.stringify(SCHEMA), { mode: 0o600 });
    const run = this.jobs.startRun({
      jobId: opts.jobId,
      provider: routed.provider.id,
      model: routed.decision.model,
      role: 'visual_reviewer',
      cwd: opts.cwd,
    });
    const result = await routed.provider.run(
      {
        cwd: opts.cwd,
        role: 'visual_reviewer',
        model: routed.decision.model ?? undefined,
        prompt: buildPrompt(opts),
        imagePaths: images,
        outputSchemaPath: schemaPath,
        safeMode: true,
        ephemeral: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      () => undefined,
    );
    this.agents.recordResult(routed.provider.id, result);
    this.jobs.finishRun(run.id, {
      status: result.status,
      result: result.result,
      error: result.error ?? null,
      externalSessionId: result.sessionId ?? null,
      usage: result.usage,
    });
    if (result.status !== 'completed') {
      return this.fail(opts.jobId, result.error ?? 'visual reviewer failed');
    }

    const parsed = parseVisualReview(result.structuredOutput);
    if (parsed.verdict === 'error') return this.fail(opts.jobId, parsed.error ?? 'invalid output');
    const reviewedBy = `${routed.provider.id}${routed.decision.model ? `:${routed.decision.model}` : ''}`;
    this.db
      .prepare(
        `UPDATE visual_qa SET reviewed_by=?, review_findings=? WHERE job_id=? AND status='captured'`,
      )
      .run(reviewedBy, JSON.stringify(parsed), opts.jobId);
    this.bus?.emit({
      type: 'visual_review.completed',
      jobId: opts.jobId,
      runId: run.id,
      payload: { verdict: parsed.verdict, findings: parsed.findings.length, provider: reviewedBy },
    });
    return { ...parsed, provider: routed.provider.id, model: routed.decision.model };
  }

  private fail(jobId: string, error: string): VisualReview {
    this.bus?.emit({ type: 'visual_review.failed', jobId, payload: { error } });
    return { verdict: 'error', findings: [], provider: null, model: null, error };
  }
}

export function parseVisualReview(value: unknown): VisualReview {
  if (!value || typeof value !== 'object') {
    return { verdict: 'error', findings: [], provider: null, model: null, error: 'invalid output' };
  }
  const raw = value as { verdict?: unknown; findings?: unknown };
  const findings = Array.isArray(raw.findings)
    ? raw.findings.flatMap((finding) => {
        if (!finding || typeof finding !== 'object') return [];
        const item = finding as Record<string, unknown>;
        if (
          !['high', 'medium', 'low', 'info'].includes(String(item.severity)) ||
          !['desktop', 'mobile'].includes(String(item.viewport)) ||
          typeof item.route !== 'string' ||
          typeof item.category !== 'string' ||
          typeof item.description !== 'string' ||
          typeof item.recommendation !== 'string'
        )
          return [];
        return [item as unknown as VisualReviewFinding];
      })
    : [];
  const claimed =
    raw.verdict === 'pass' ? 'pass' : raw.verdict === 'needs_fix' ? 'needs_fix' : null;
  if (!claimed) {
    return { verdict: 'error', findings: [], provider: null, model: null, error: 'invalid output' };
  }
  return {
    verdict: findings.some((finding) => finding.severity === 'high') ? 'needs_fix' : claimed,
    findings,
    provider: null,
    model: null,
  };
}

function buildPrompt(opts: { goal: string; acceptance: string[]; shots: VisualQaShot[] }): string {
  return `Independently inspect every attached screenshot. Judge visible layout, clipping,
readability, responsive behavior, and obvious UI error states. Do not infer hidden behavior.

Goal: ${opts.goal}
Acceptance criteria:\n${opts.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}
Evidence:\n${opts.shots
    .map(
      (shot) =>
        `- ${shot.route} ${shot.viewport}; console errors: ${shot.consoleErrors.length}; failed requests: ${shot.networkFailures.length}`,
    )
    .join('\n')}`;
}
