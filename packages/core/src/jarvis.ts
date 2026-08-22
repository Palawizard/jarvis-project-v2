import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb, type Db } from './db/index.js';
import { ensureDirs, getConfig, loadConfig, setConfig, type JarvisConfig } from './config.js';
import { EventBus } from './events/bus.js';
import { MemoryService } from './memory/service.js';
import { ContextPackBuilder } from './context/pack.js';
import { ProjectService } from './projects/service.js';
import { SessionService } from './sessions/service.js';
import { JobService } from './jobs/service.js';
import { JobPipeline } from './jobs/pipeline.js';
import { AgentRegistry } from './agents/registry.js';
import { VerificationEngine } from './verification/engine.js';
import { ReviewEngine } from './review/engine.js';
import { VisualQaEngine } from './visualqa/engine.js';
import { registerBuiltinTools } from './tools/builtin.js';
import type { ToolRegistry } from './tools/registry.js';
import { createLogger } from './logger.js';

const log = createLogger('jarvis');

/**
 * Composition root.
 *
 * One place where every subsystem is wired, so tests and the orchestrator build
 * the same object graph and there is no hidden global state between them.
 */
export class Jarvis {
  readonly config: JarvisConfig;
  readonly db: Db;
  readonly bus: EventBus;
  readonly memory: MemoryService;
  readonly context: ContextPackBuilder;
  readonly projects: ProjectService;
  readonly sessions: SessionService;
  readonly jobs: JobService;
  readonly agents: AgentRegistry;
  readonly verification: VerificationEngine;
  readonly review: ReviewEngine;
  readonly visualQa: VisualQaEngine;
  readonly pipeline: JobPipeline;
  readonly tools: ToolRegistry;

  constructor(config: JarvisConfig = getConfig()) {
    this.config = config;
    setConfig(config);
    ensureDirs(config);
    this.db = openDb(config);
    this.bus = new EventBus(this.db);
    this.memory = new MemoryService({ db: this.db, bus: this.bus, config });
    this.context = new ContextPackBuilder(this.db, this.memory, config);
    this.projects = new ProjectService(this.db);
    this.sessions = new SessionService(this.db, this.bus);
    this.jobs = new JobService(this.db, this.bus);
    this.agents = new AgentRegistry(config);
    this.verification = new VerificationEngine(this.db, config.artifactsDir, this.bus);
    this.review = new ReviewEngine(this.db, this.agents, this.bus);
    this.visualQa = new VisualQaEngine(this.db, config.artifactsDir, this.bus);
    this.tools = registerBuiltinTools({ memory: this.memory, projects: this.projects, jobs: this.jobs });
    this.pipeline = new JobPipeline({
      db: this.db,
      bus: this.bus,
      config,
      jobs: this.jobs,
      projects: this.projects,
      sessions: this.sessions,
      memory: this.memory,
      context: this.context,
      agents: this.agents,
      verification: this.verification,
      review: this.review,
    });
  }

  static open(overrides: Partial<JarvisConfig> = {}): Jarvis {
    return new Jarvis(loadConfig(overrides));
  }

  /**
   * Startup housekeeping. Idempotent and safe to run on every boot.
   * Order matters: recover crashed jobs before anything reads job state.
   */
  async boot(): Promise<{ recovered: { jobs: number; runs: number }; expired: number; selfProject: string | null }> {
    const recovered = this.jobs.recoverInterrupted();
    if (recovered.jobs || recovered.runs) {
      log.warn('recovered interrupted work from a previous run', recovered);
    }
    const expired = this.memory.expireStale();
    this.memory.trimCoreUserMemory();
    this.sessions.pruneHistory(this.config.pipeline.rawHistoryRetentionDays);

    const selfProject = await this.registerSelf().catch((error: unknown) => {
      log.warn('could not register Jarvis as a project', { error: String(error) });
      return null;
    });
    return { recovered, expired, selfProject: selfProject?.id ?? null };
  }

  /**
   * Register the Jarvis repository as a Project so "improve yourself" is an
   * ordinary job. The running instance is never modified — jobs targeting this
   * project still go through an isolated worktree and stop at awaiting_user.
   */
  async registerSelf() {
    const repoRoot = findRepoRoot();
    if (!repoRoot) return null;
    const existing = this.projects.getSelf();
    if (existing) return this.projects.refreshDetection(existing.id) ?? existing;
    return this.projects.register({
      name: 'jarvis',
      rootPath: repoRoot,
      isSelf: true,
      devUrl: 'http://localhost:5199',
      summary:
        'Jarvis itself: a local-first, memory-first AI assistant. TypeScript pnpm monorepo — ' +
        'apps/orchestrator (Hono API + SSE), apps/web (Vite React UI), packages/core (domain).',
    });
  }

  close(): void {
    this.db.close();
  }
}

/** Walk up from this module to the repo root (the directory holding pnpm-workspace.yaml). */
function findRepoRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
