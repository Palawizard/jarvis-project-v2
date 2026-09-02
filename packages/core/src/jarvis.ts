import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb, type Db } from './db/index.js';
import { selfSurfaceScenario } from './visualqa/surfaces.js';
import { seedCandidateFixtures } from './runtime/fixtures.js';
import { ensureDirs, getConfig, loadConfig, setConfig, type JarvisConfig } from './config.js';
import { EventBus } from './events/bus.js';
import { MemoryService } from './memory/service.js';
import { ContextPackBuilder } from './context/pack.js';
import { ProjectService, normaliseProjectName, type ProjectConfig } from './projects/service.js';
import { ProjectAnalysisService } from './projects/analysis.js';
import { SessionService } from './sessions/service.js';
import { JobService } from './jobs/service.js';
import { JobPipeline } from './jobs/pipeline.js';
import { JobLifecycle } from './jobs/lifecycle.js';
import { ChatService } from './chat/service.js';
import { AgentRegistry } from './agents/registry.js';
import { VerificationEngine } from './verification/engine.js';
import { ReviewEngine } from './review/engine.js';
import { VisualQaEngine } from './visualqa/engine.js';
import { InteractiveVisualQaAgent } from './visualqa/agent.js';
import { CandidateApplicationService } from './application/service.js';
import { UpgradeManager } from './upgrade/manager.js';
import { registerBuiltinTools } from './tools/builtin.js';
import type { ToolRegistry } from './tools/registry.js';
import { createLogger } from './logger.js';
import { HumanControlAuth } from './auth/control.js';

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
  readonly projectAnalysis: ProjectAnalysisService;
  readonly sessions: SessionService;
  readonly jobs: JobService;
  readonly agents: AgentRegistry;
  readonly verification: VerificationEngine;
  readonly review: ReviewEngine;
  readonly visualQa: VisualQaEngine;
  readonly visualAgent: InteractiveVisualQaAgent;
  readonly pipeline: JobPipeline;
  readonly lifecycle: JobLifecycle;
  readonly chat: ChatService;
  readonly applications: CandidateApplicationService;
  readonly upgrades: UpgradeManager;
  readonly tools: ToolRegistry;
  readonly control: HumanControlAuth;

  constructor(config: JarvisConfig = getConfig()) {
    this.config = config;
    setConfig(config);
    ensureDirs(config);
    this.db = openDb(config);
    this.bus = new EventBus(this.db);
    this.control = new HumanControlAuth(this.db);
    this.memory = new MemoryService({ db: this.db, bus: this.bus, config });
    this.context = new ContextPackBuilder(this.db, this.memory, config);
    this.projects = new ProjectService(this.db);
    this.sessions = new SessionService(this.db, this.bus);
    this.jobs = new JobService(this.db, this.bus);
    this.agents = new AgentRegistry(config, { db: this.db, bus: this.bus });
    this.projectAnalysis = new ProjectAnalysisService({
      config,
      bus: this.bus,
      agents: this.agents,
      projects: this.projects,
      memory: this.memory,
    });
    this.verification = new VerificationEngine(this.db, config.artifactsDir, this.bus);
    this.review = new ReviewEngine(this.db, this.agents, this.bus, this.config);
    this.visualQa = new VisualQaEngine(this.db, config.artifactsDir, this.bus);
    this.visualAgent = new InteractiveVisualQaAgent(
      this.db,
      this.agents,
      this.jobs,
      config.artifactsDir,
      this.bus,
    );
    this.applications = new CandidateApplicationService(
      this.db,
      this.bus,
      this.jobs,
      this.projects,
      this.verification,
      this.review,
      config.worktreesDir,
      config.artifactsDir,
    );
    this.upgrades = new UpgradeManager(
      this.db,
      this.bus,
      this.jobs,
      this.projects,
      this.applications,
      config,
    );
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
      visualQa: this.visualQa,
      visualAgent: this.visualAgent,
    });
    this.lifecycle = new JobLifecycle({
      jobs: this.jobs,
      projects: this.projects,
      pipeline: this.pipeline,
      config,
    });
    // One catalog for both the buttons and the sentences: a management action
    // gets the same policy decision whichever way it was asked for.
    this.tools = registerBuiltinTools(
      {
        memory: this.memory,
        projects: this.projects,
        projectAnalysis: this.projectAnalysis,
        jobs: this.jobs,
        sessions: this.sessions,
        pipeline: this.pipeline,
        lifecycle: this.lifecycle,
      },
      {
        db: this.db,
        bus: this.bus,
        defaultTimeoutMs: config.tools.defaultTimeoutMs,
        approvalTtlMs: config.tools.approvalTtlMs,
        maxRecordChars: config.tools.maxRecordChars,
      },
    );
    this.chat = new ChatService({
      config,
      bus: this.bus,
      agents: this.agents,
      context: this.context,
      memory: this.memory,
      projects: this.projects,
      jobs: this.jobs,
      sessions: this.sessions,
      tools: this.tools,
    });
  }

  static open(overrides: Partial<JarvisConfig> = {}): Jarvis {
    return new Jarvis(loadConfig(overrides));
  }

  /**
   * Startup housekeeping. Idempotent and safe to run on every boot.
   * Order matters: recover crashed jobs before anything reads job state.
   */
  async boot(): Promise<{
    recovered: { jobs: number; runs: number; messages: number };
    tools: { interrupted: number; expired: number };
    expired: number;
    selfProject: string | null;
    fixtures: string[];
  }> {
    const interruptedResponses = this.sessions.recoverInterruptedMessages();
    // Analysis runs live in memory but record their state on the project row,
    // so a crash mid-run would otherwise leave a project "analysing" forever.
    const interruptedAnalyses = await this.projectAnalysis.recoverInterrupted();
    const recovered = { ...this.jobs.recoverInterrupted(), messages: interruptedResponses };
    const interruptedApplications = this.applications.recoverInterrupted();
    // A tool that died mid-action may have had an effect on the outside world,
    // so it is surfaced as interrupted and never replayed automatically.
    const tools = this.tools.recoverInterrupted();
    if (recovered.jobs || recovered.runs || recovered.messages || interruptedAnalyses) {
      log.warn('recovered interrupted work from a previous run', {
        ...recovered,
        analyses: interruptedAnalyses,
      });
    }
    if (interruptedApplications) {
      log.warn('candidate applications require inspection after restart', {
        applications: interruptedApplications,
      });
    }
    const expired = this.memory.expireStale();
    this.memory.trimCoreUserMemory();
    this.sessions.pruneHistory(this.config.pipeline.rawHistoryRetentionDays);
    this.tools.pruneAudit(this.config.tools.auditRetentionDays);

    const selfProject = await this.registerSelf().catch((error: unknown) => {
      log.warn('could not register Jarvis as a project', { error: String(error) });
      return null;
    });
    // Candidate runtimes only: deterministic Visual-QA state in this isolated
    // home. `seedCandidateFixtures` refuses outright on the real runtime.
    const fixtures = seedCandidateFixtures(this.db, { projectId: selfProject?.id ?? null });
    if (fixtures.length) log.info('candidate visual QA fixtures seeded', { fixtures });
    return { recovered, tools, expired, selfProject: selfProject?.id ?? null, fixtures };
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
    const config: ProjectConfig = {
      candidateRuntime: {
        // A candidate is never supervised: it must not bootstrap an upgrade
        // supervisor, and it runs from source rather than the built dist.
        command: { executable: process.execPath, args: ['scripts/dev.mjs', '--unsupervised'] },
        portEnvironment: 'JARVIS_WEB_PORT',
        apiPortEnvironment: 'JARVIS_PORT',
        healthPath: '/health',
      },
      // `required: true` means "a visual pass is required before this candidate
      // may be applied", not "run Visual QA on every job": deterministic
      // eligibility decides that from the diff. The scenario below is a route
      // hint and the legacy pre-plan approval fallback; the interactive agent
      // derives what to test from the feature itself.
      visualQa: { required: true, scenarios: [selfSurfaceScenario('chat-workspace')] },
      verification: {
        steps: [
          { name: 'format', command: 'pnpm format:check' },
          { name: 'lint', command: 'pnpm lint' },
          { name: 'typecheck', command: 'pnpm typecheck' },
          { name: 'unit', command: 'pnpm test', kind: 'check' },
          { name: 'integration', command: 'pnpm test:integration', kind: 'integration' },
          { name: 'build', command: 'pnpm build' },
          { name: 'e2e', command: 'pnpm test:e2e', kind: 'e2e', timeoutMs: 20 * 60_000 },
        ],
      },
    };
    // "Fix the Jobs page in Jarvis" resolves without a chooser through the
    // project name and the self-reference test in ProjectService, NOT through
    // aliases. These two were seeded here as aliases, and an alias matches
    // anywhere in a sentence at a tier above conversation affinity -- so
    // "Jarvis fix the login bug" resolved this repository and silently
    // retargeted a conversation that was about something else. Seeded values
    // are stripped from an existing row too, so a deployed database heals on
    // the next boot; any alias the user added themselves is kept.
    const seededAddress = new Set(['jarvis', 'yourself']);
    const aliases = (existing?.aliases ?? []).filter(
      (alias) => !seededAddress.has(normaliseProjectName(alias)),
    );
    if (existing) {
      this.projects.update(existing.id, {
        aliases,
        config: { ...existing.config, ...config },
      });
      return this.projects.refreshDetection(existing.id) ?? existing;
    }
    return this.projects.register({
      name: 'jarvis',
      rootPath: repoRoot,
      isSelf: true,
      aliases,
      devUrl: 'http://localhost:5199',
      summary:
        'Jarvis itself: a local-first, memory-first AI assistant. TypeScript pnpm monorepo — ' +
        'apps/orchestrator (Hono API + SSE), apps/web (Vite React UI), packages/core (domain).',
      config,
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
