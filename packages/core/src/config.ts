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

  agents: {
    implementerProvider: 'claude' | 'codex' | undefined;
    reviewerProvider: 'claude' | 'codex' | undefined;
    claudeModel: string;
    /** Permission mode handed to `claude -p`. acceptEdits keeps the worker inside file edits. */
    claudePermissionMode: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
    codexModel: string | undefined;
    /** Hard ceiling on a single agent run. */
    runTimeoutMs: number;
    /** Temporary backoff after a provider reports a rate limit. */
    cooldownMs: number;
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
    /** Max automatic implement->verify->fix loops before handing back to the user. */
    maxFixCycles: number;
    /** Retention for raw history rows, in days. 0 = keep forever. */
    rawHistoryRetentionDays: number;
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
    agents: {
      implementerProvider: envProvider('JARVIS_IMPLEMENTER_PROVIDER'),
      reviewerProvider: envProvider('JARVIS_REVIEWER_PROVIDER'),
      claudeModel: process.env.JARVIS_CLAUDE_MODEL || 'sonnet',
      claudePermissionMode:
        (process.env
          .JARVIS_CLAUDE_PERMISSION_MODE as JarvisConfig['agents']['claudePermissionMode']) ||
        'acceptEdits',
      codexModel: process.env.JARVIS_CODEX_MODEL || undefined,
      runTimeoutMs: envInt('JARVIS_AGENT_TIMEOUT_MS', 30 * 60_000),
      cooldownMs: envInt('JARVIS_PROVIDER_COOLDOWN_MS', 10 * 60_000),
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
      maxFixCycles: envInt('JARVIS_MAX_FIX_CYCLES', 1),
      rawHistoryRetentionDays: envInt('JARVIS_RAW_HISTORY_RETENTION_DAYS', 90),
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
