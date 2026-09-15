import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Jarvis configuration. Every value has a working default so a fresh clone runs
 * with zero setup. Nothing here may require a paid API key.
 */
export interface JarvisConfig {
  /** Root of all Jarvis runtime state: db, worktrees, artifacts, model cache. */
  home: string;
  dbPath: string;
  worktreesDir: string;
  artifactsDir: string;
  modelCacheDir: string;
  logDir: string;
  port: number;
  /** Exact browser origins allowed to make human-authority mutations. */
  controlOrigins: string[];

  agents: {
    implementerProvider: 'claude' | 'codex' | undefined;
    reviewerProvider: 'claude' | 'codex' | undefined;
    /**
     * There is no model override here, on purpose.
     *
     * The two per-provider model environment variables were removed with the
     * central model policy: a per-machine override was a way to put an arbitrary
     * model (including `haiku`) behind every role and bypass the role floors and
     * ceilings. Model and effort come from `agents/policy.ts` alone.
     * PROVIDER overrides are unaffected — see `implementerProvider` above.
     */
    /** Permission mode handed to `claude -p`. acceptEdits keeps the worker inside file edits. */
    claudePermissionMode: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
    /** Hard ceiling on a single agent run. */
    runTimeoutMs: number;
  };

  memory: {
    /** Automatic (non-explicit) memories below this importance are discarded. */
    minImportance: number;
    /** Cosine similarity above which a new memory is considered a duplicate. */
    dedupeSimilarity: number;
    /** Lexical Jaccard above which a new memory is considered a duplicate (no-embeddings path). */
    dedupeLexical: number;
    /**
     * Hard minimum cosine for the semantic leg to count as a relevance signal.
     * The effective cutoff is usually higher and is derived per query from the
     * candidate distribution (see calibrateSemantic) — embedding models differ
     * far too much in absolute cosine range for a fixed threshold to work.
     */
    semanticFloor: number;
    /**
     * How far above the null baseline a memory must score to count as relevant.
     * Measured against multilingual-e5-small, where unrelated text sits ~0.06
     * below genuinely related text. Retune if you change the embedding model.
     */
    semanticMargin: number;
    embeddingsEnabled: boolean;
    embeddingModel: string;
    /** Max characters stored for a single memory's content. */
    maxContentChars: number;
    /** Hard cap on Layer-2 core user memories kept active. */
    coreUserMemoryMax: number;
  };

  context: {
    /** Total budget for a Memory Context Pack, in estimated tokens. */
    budgetTokens: number;
    /** Per-section share of the budget. Must sum to <= 1. */
    sectionShare: {
      coreUser: number;
      projectSnapshot: number;
      memories: number;
      episodes: number;
      session: number;
    };
  };

  pipeline: {
    /**
     * PRODUCT repair budgets. Each one counts fixer runs that actually changed
     * the candidate in response to real evidence — a failing check, a real
     * review finding, a real visual defect. A provider outage never spends one:
     * see `AgentFailureKind` and `INFRASTRUCTURE_FAILURE_KINDS`.
     */
    maxFixCycles: number;
    maxReviewFixCycles: number;
    maxVisualFixCycles: number;
    /**
     * ATTEMPT budget, and a different currency entirely: how many providers one
     * logical AI action may be tried on before the Job pauses. Two means
     * "preferred, then one healthy alternate, then stop" — never a chain.
     */
    providerAttempts: number;
    verificationInfraRetries: number;
    codeReviewBlockingSeverities: string[];
    visualBlockingSeverities: string[];
    /** Retention for raw history rows, in days. 0 = keep forever. */
    rawHistoryRetentionDays: number;
  };

  calendar: {
    /** How often connected calendars are pulled in the background. */
    syncIntervalMs: number;
    /** Mirror window. Past days keep "what did I do", future days keep the plan. */
    windowPastDays: number;
    windowFutureDays: number;
  };

  tools: {
    /** Hard ceiling on one tool invocation, unless the tool declares its own. */
    defaultTimeoutMs: number;
    /** How long an unanswered permission request stays answerable. */
    approvalTtlMs: number;
    /** Retention for finished tool audit rows, in days. 0 = keep forever. */
    auditRetentionDays: number;
    /**
     * Ceiling on the audit/UI PREVIEW kept for a tool result or error. Display
     * only: it never decides whether a tool may run, and truncating here never
     * touches the stored execution payload.
     */
    maxRecordChars: number;
    /**
     * Storage safety bound on the canonical arguments of one tool call.
     *
     * Deliberately large, and deliberately NOT reachable from the environment.
     * Its predecessor was `maxRecordChars` — a 4,000-character display budget
     * that also decided whether a call could execute, so a legitimate 4,644
     * character structured request was refused outright. The two questions are
     * now separate, and only this one is a correctness gate: arguments above it
     * are refused rather than truncated, because a truncated payload must never
     * be executed, approved or replayed.
     */
    maxInputChars: number;
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

function envProvider(name: string): 'claude' | 'codex' | undefined {
  const value = process.env[name];
  return value === 'claude' || value === 'codex' ? value : undefined;
}

function envSeverities(name: string, fallback: string[], allowed: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()))].filter(
    Boolean,
  );
  if (!values.length || values.some((value) => !allowed.includes(value))) {
    throw new Error(`${name} contains an unsupported or empty severity`);
  }
  return values;
}

let cached: JarvisConfig | undefined;

export function loadConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  const home = overrides.home ?? process.env.JARVIS_HOME ?? path.join(os.homedir(), '.jarvis');

  const config: JarvisConfig = {
    home,
    dbPath: path.join(home, 'jarvis.db'),
    worktreesDir: path.join(home, 'worktrees'),
    artifactsDir: path.join(home, 'artifacts'),
    modelCacheDir: path.join(home, 'models'),
    logDir: path.join(home, 'logs'),
    port: envInt('JARVIS_PORT', 4319),
    controlOrigins: (process.env.JARVIS_CONTROL_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    agents: {
      implementerProvider: envProvider('JARVIS_IMPLEMENTER_PROVIDER'),
      reviewerProvider: envProvider('JARVIS_REVIEWER_PROVIDER'),
      claudePermissionMode:
        (process.env
          .JARVIS_CLAUDE_PERMISSION_MODE as JarvisConfig['agents']['claudePermissionMode']) ||
        'acceptEdits',
      runTimeoutMs: envInt('JARVIS_AGENT_TIMEOUT_MS', 30 * 60_000),
    },
    memory: {
      minImportance: envFloat('JARVIS_MEMORY_MIN_IMPORTANCE', 0.35),
      dedupeSimilarity: envFloat('JARVIS_MEMORY_DEDUPE_SIMILARITY', 0.92),
      dedupeLexical: envFloat('JARVIS_MEMORY_DEDUPE_LEXICAL', 0.8),
      semanticFloor: envFloat('JARVIS_MEMORY_SEMANTIC_FLOOR', 0.2),
      semanticMargin: envFloat('JARVIS_MEMORY_SEMANTIC_MARGIN', 0.06),
      embeddingsEnabled: envBool('JARVIS_EMBEDDINGS', true),
      embeddingModel: process.env.JARVIS_EMBEDDING_MODEL || 'Xenova/multilingual-e5-small',
      maxContentChars: envInt('JARVIS_MEMORY_MAX_CONTENT_CHARS', 1200),
      coreUserMemoryMax: envInt('JARVIS_CORE_USER_MEMORY_MAX', 40),
    },
    context: {
      budgetTokens: envInt('JARVIS_CONTEXT_BUDGET_TOKENS', 2400),
      sectionShare: {
        coreUser: 0.15,
        projectSnapshot: 0.2,
        memories: 0.35,
        episodes: 0.2,
        session: 0.1,
      },
    },
    pipeline: {
      // Two verification fixers, and the second one has to earn it: it runs
      // only when the failure signature actually moved. See `jobs/evidence.ts`.
      maxFixCycles: Math.max(0, envInt('JARVIS_MAX_FIX_CYCLES', 2)),
      // One batch fixer for all findings of one comprehensive review, then one
      // fresh final review. Not a loop.
      maxReviewFixCycles: Math.max(0, envInt('JARVIS_MAX_REVIEW_FIX_CYCLES', 1)),
      maxVisualFixCycles: Math.max(0, envInt('JARVIS_MAX_VISUAL_FIX_CYCLES', 1)),
      // Clamped to [1, 2]: preferred, then one alternate, then pause. A larger
      // value would only walk back to a provider that already failed this action.
      providerAttempts: Math.min(2, Math.max(1, envInt('JARVIS_PROVIDER_ATTEMPTS', 2))),
      verificationInfraRetries: Math.max(0, envInt('JARVIS_VERIFICATION_INFRA_RETRIES', 2)),
      codeReviewBlockingSeverities: envSeverities(
        'JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES',
        ['critical', 'high'],
        ['critical', 'high', 'medium', 'low', 'info'],
      ),
      visualBlockingSeverities: envSeverities(
        'JARVIS_VISUAL_REVIEW_BLOCKING_SEVERITIES',
        ['high', 'medium'],
        ['high', 'medium', 'low', 'info'],
      ),
      rawHistoryRetentionDays: envInt('JARVIS_RAW_HISTORY_RETENTION_DAYS', 90),
    },
    calendar: {
      syncIntervalMs: Math.max(60_000, envInt('JARVIS_CALENDAR_SYNC_INTERVAL_MS', 5 * 60_000)),
      windowPastDays: Math.max(1, envInt('JARVIS_CALENDAR_PAST_DAYS', 30)),
      windowFutureDays: Math.max(1, envInt('JARVIS_CALENDAR_FUTURE_DAYS', 180)),
    },
    tools: {
      defaultTimeoutMs: envInt('JARVIS_TOOL_TIMEOUT_MS', 60_000),
      approvalTtlMs: envInt('JARVIS_TOOL_APPROVAL_TTL_MS', 24 * 60 * 60_000),
      auditRetentionDays: envInt('JARVIS_TOOL_AUDIT_RETENTION_DAYS', 90),
      maxRecordChars: envInt('JARVIS_TOOL_MAX_RECORD_CHARS', 4000),
      // No environment override on purpose: raising it is the only interesting
      // direction and that is the DoS knob.
      maxInputChars: 256_000,
    },
    ...overrides,
  };

  // Re-derive paths when home was overridden without explicit paths.
  if (overrides.home && !overrides.dbPath) {
    config.dbPath = path.join(config.home, 'jarvis.db');
    config.worktreesDir = path.join(config.home, 'worktrees');
    config.artifactsDir = path.join(config.home, 'artifacts');
    config.modelCacheDir = path.join(config.home, 'models');
    config.logDir = path.join(config.home, 'logs');
  }
  if (!config.controlOrigins.length) {
    config.controlOrigins = [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      `http://127.0.0.1:${process.env.JARVIS_WEB_PORT ?? '5199'}`,
      `http://localhost:${process.env.JARVIS_WEB_PORT ?? '5199'}`,
    ];
  }
  return config;
}

export function getConfig(): JarvisConfig {
  cached ??= loadConfig();
  return cached;
}

export function setConfig(config: JarvisConfig): void {
  cached = config;
}

/** Create the runtime directories with restrictive permissions where the OS supports it. */
export function ensureDirs(config: JarvisConfig): void {
  for (const dir of [
    config.home,
    config.worktreesDir,
    config.artifactsDir,
    config.modelCacheDir,
    config.logDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // chmod is a no-op on Windows; harmless.
  try {
    fs.chmodSync(config.home, 0o700);
  } catch {
    /* platform without POSIX permissions */
  }
}
