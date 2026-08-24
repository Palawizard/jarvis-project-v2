import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { JobService } from '../jobs/service.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentEvent, ProviderId } from '../agents/types.js';
import { validateVisualEvidence, type VisualQaShot, type VisualReviewFinding } from './engine.js';
import { getConfig, type JarvisConfig } from '../config.js';
import type { AgentRunResult } from '../agents/types.js';
import { redactSecrets, redactSecretValues } from '../memory/secrets.js';
import { z } from 'zod';

export interface VisualReview {
  /**
   * `insufficient_evidence` means the QA plan/evidence was inadequate, not that
   * the product is broken. Only `needs_fix` may ever reach a source fixer.
   */
  verdict: 'pass' | 'needs_fix' | 'insufficient_evidence' | 'error';
  findings: VisualReviewFinding[];
  reviewedEvidence?: Array<{ shotId: string; sha256: string }>;
  provider: ProviderId | null;
  model: string | null;
  error?: string;
}

interface VisualReviewOptions {
  jobId: string;
  cwd: string;
  goal: string;
  acceptance: string[];
  shots: VisualQaShot[];
  /** Candidate diff paths, so the reviewer can attribute what it sees. */
  changedFiles?: string[];
  /** Deterministic `<file> -> <surface>` lines explaining the scenario plan. */
  planReasons?: string[];
  implementerProvider?: ProviderId;
  selfDevelopment?: boolean;
  signal?: AbortSignal;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reviewedEvidence', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'needs_fix', 'insufficient_evidence'] },
    reviewedEvidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shotId', 'sha256'],
        properties: {
          shotId: { type: 'string' },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'scenarioName',
          'route',
          'viewport',
          'category',
          'description',
          'recommendation',
        ],
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'info'] },
          scenarioName: { type: 'string' },
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

export class VisualReviewer {
  constructor(
    private readonly db: Db,
    private readonly agents: AgentRegistry,
    private readonly jobs: JobService,
    private readonly artifactsDir: string,
    private readonly bus?: EventBus,
    private readonly config: JarvisConfig = getConfig(),
  ) {}

  async review(opts: VisualReviewOptions): Promise<VisualReview> {
    let avoid = opts.implementerProvider;
    let last: VisualReview | undefined;
    for (let attempt = 0; attempt <= this.config.pipeline.agentStageRetries; attempt++) {
      last = await this.reviewOnce(opts, avoid);
      if (last.verdict !== 'error' || opts.signal?.aborted) return last;
      // Missing/corrupt screenshots are capture infrastructure failures, not a
      // provider failure. Retrying a model cannot repair the evidence.
      if (!last.provider) return last;
      if (last.provider) avoid = last.provider;
      this.bus?.emit({
        type: 'agent.stage.retry',
        jobId: opts.jobId,
        payload: { stage: 'visual_qa', attempt: attempt + 1, provider: last.provider },
      });
    }
    return last as VisualReview;
  }

  private async reviewOnce(
    opts: VisualReviewOptions,
    avoidProvider?: ProviderId,
  ): Promise<VisualReview> {
    const images = opts.shots.flatMap((shot) =>
      shot.status === 'captured' && validateVisualEvidence(shot.screenshotPath, this.artifactsDir)
        ? [shot.screenshotPath]
        : [],
    ) as string[];
    if (images.length !== opts.shots.length || images.length === 0) {
      return this.failEvidence(opts, 'visual evidence is missing, modified, or incomplete');
    }

    this.bus?.emit({
      type: 'visual_review.started',
      jobId: opts.jobId,
      payload: { images: images.length },
    });
    const routed = await this.agents.route('visual_reviewer', {
      avoid: avoidProvider,
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
    let result: AgentRunResult;
    const providerEvents: AgentEvent[] = [];
    try {
      result = await routed.provider.run(
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
        (event) => providerEvents.push(event),
      );
    } catch (error) {
      result = {
        status: 'failed',
        result: '',
        error: error instanceof Error ? error.message : String(error),
        memoryProposals: [],
      };
    }
    this.agents.recordResult(routed.provider.id, result);
    const safeResult = redactSecrets(result.result);
    const safeError = result.error ? redactSecrets(result.error) : undefined;
    if (result.status !== 'completed') {
      this.jobs.finishRun(run.id, {
        status: result.status,
        result: safeResult,
        error: safeError ?? null,
        externalSessionId: result.sessionId ?? null,
        usage: result.usage,
      });
      return this.fail(
        opts.jobId,
        safeError ?? 'visual reviewer failed',
        routed.provider.id,
        routed.decision.model,
      );
    }
    if (
      opts.shots.some((shot) => !validateVisualEvidence(shot.screenshotPath, this.artifactsDir))
    ) {
      const error = 'visual evidence changed while it was being reviewed';
      this.agents.recordResult(routed.provider.id, { status: 'failed', error });
      this.jobs.finishRun(run.id, {
        status: 'failed',
        result: safeResult,
        error,
        externalSessionId: result.sessionId ?? null,
        usage: result.usage,
      });
      return this.failEvidence(opts, error);
    }

    if (
      routed.provider.id === 'claude' &&
      !hasCompleteClaudeImageReads(providerEvents, images, opts.cwd)
    ) {
      const error = 'protocol failure: Claude did not successfully Read every exact screenshot';
      this.agents.recordResult(routed.provider.id, { status: 'failed', error });
      this.jobs.finishRun(run.id, {
        status: 'failed',
        result: safeResult,
        error,
        externalSessionId: result.sessionId ?? null,
        usage: result.usage,
      });
      return this.fail(opts.jobId, error, routed.provider.id, routed.decision.model);
    }

    const parsed = parseVisualReview(
      redactSecretValues(result.structuredOutput),
      opts.shots,
      this.config.pipeline.visualBlockingSeverities,
    );
    if (parsed.verdict === 'error') {
      const protocolError = `protocol failure: ${parsed.error ?? 'invalid visual review output'}`;
      this.agents.recordResult(routed.provider.id, { status: 'failed', error: protocolError });
      this.jobs.finishRun(run.id, {
        status: 'failed',
        result: safeResult,
        error: protocolError,
      });
      return this.fail(opts.jobId, protocolError, routed.provider.id, routed.decision.model);
    }
    this.jobs.finishRun(run.id, {
      status: result.status,
      result: safeResult,
      error: null,
      externalSessionId: result.sessionId ?? null,
      usage: result.usage,
    });
    if (parsed.verdict !== 'insufficient_evidence') {
      const blocking = parsed.findings.some((finding) =>
        this.config.pipeline.visualBlockingSeverities.includes(finding.severity),
      );
      parsed.verdict = blocking ? 'needs_fix' : 'pass';
    }
    const reviewedBy = `${routed.provider.id}${routed.decision.model ? `:${routed.decision.model}` : ''}`;
    for (const shot of opts.shots) {
      this.db
        .prepare(`UPDATE visual_qa SET reviewed_by=?, review_findings=? WHERE id=?`)
        .run(reviewedBy, JSON.stringify(parsed), shot.id);
    }
    this.bus?.emit({
      type: 'visual_review.completed',
      jobId: opts.jobId,
      runId: run.id,
      payload: { verdict: parsed.verdict, findings: parsed.findings.length, provider: reviewedBy },
    });
    return { ...parsed, provider: routed.provider.id, model: routed.decision.model };
  }

  private fail(
    jobId: string,
    error: string,
    provider: ProviderId | null = null,
    model: string | null = null,
  ): VisualReview {
    error = redactSecrets(error);
    this.bus?.emit({ type: 'visual_review.failed', jobId, payload: { error } });
    return { verdict: 'error', findings: [], provider, model, error };
  }

  private failEvidence(opts: VisualReviewOptions, error: string): VisualReview {
    for (const shot of opts.shots) {
      try {
        if (shot.screenshotPath) fs.rmSync(shot.screenshotPath, { force: true });
      } catch {
        // Evidence invalidation must still reach the database if Windows has
        // the file temporarily locked. A locked file is never accepted again.
      }
      this.db
        .prepare(
          `UPDATE visual_qa SET status='failed', screenshot_path=NULL, error=?, reviewed_by=NULL,
            review_findings=NULL WHERE id=?`,
        )
        .run(error, shot.id);
      shot.status = 'failed';
      shot.screenshotPath = null;
      shot.error = error;
      shot.reviewedBy = null;
      shot.reviewVerdict = null;
      shot.reviewFindings = [];
    }
    return this.fail(opts.jobId, error);
  }
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

function buildPrompt(
  opts: Pick<VisualReviewOptions, 'goal' | 'acceptance' | 'shots' | 'changedFiles' | 'planReasons'>,
): string {
  return `Independently inspect every attached screenshot. Judge visible layout, clipping,
readability, responsive behavior, and obvious UI error states. Do not infer hidden behavior.

Verdicts:
- "pass": the captured surfaces look correct.
- "needs_fix": a screenshot shows a real, visible product defect on a captured
  surface that this candidate diff could plausibly have caused. Requires at
  least one blocking finding.
- "insufficient_evidence": the surface the candidate diff actually changed is
  not visible in any screenshot, or the screenshots do not let you judge it.
  Use this instead of "needs_fix" whenever the problem is missing evidence
  rather than a broken product. A missing screenshot is never a source defect.

Findings about surfaces this candidate did not change are advisory (severity
"low" or "info") unless the evidence shows the candidate caused the regression.

Goal: ${opts.goal}
Files changed by this candidate:
${opts.changedFiles?.map((file) => `- ${file}`).join('\n') || '- unknown'}
Why these scenarios were captured:
${opts.planReasons?.map((item) => `- ${item}`).join('\n') || '- project default scenarios'}
Acceptance criteria:\n${opts.acceptance.map((item) => `- ${item}`).join('\n') || '- none supplied'}
Evidence (copy every exact shotId and sha256 into reviewedEvidence only after inspecting it):\n${opts.shots
    .map(
      (shot) =>
        `- shotId ${shot.id}; sha256 ${screenshotDigest(shot.screenshotPath) ?? 'missing'}; scenario ${shot.scenarioName}; route ${shot.route}; ${shot.viewport}; console errors: ${shot.consoleErrors.length}; failed requests: ${shot.networkFailures.length}`,
    )
    .join('\n')}`;
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
