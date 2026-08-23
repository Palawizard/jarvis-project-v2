import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContextPackBuilder,
  EventBus,
  JobPipeline,
  JobService,
  MemoryService,
  ProjectService,
  ReviewEngine,
  SessionService,
  VerificationEngine,
  loadConfig,
  openDb,
  type AgentProvider,
  type AgentRegistry,
  type AgentRunResult,
  type AgentStartOptions,
  type Db,
  type ProviderCapabilities,
  type ProviderId,
} from '../../packages/core/src/index.js';

const homes: string[] = [];
let activeDb: Db | null = null;

afterEach(() => {
  try {
    activeDb?.close();
  } catch {
    // Already closed by the persistence assertion.
  }
  activeDb = null;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function provider(id: ProviderId): AgentProvider {
  const capabilities: ProviderCapabilities = {
    id,
    available: true,
    authenticated: true,
    streaming: true,
    resumable: true,
    structuredOutput: true,
    models: ['test'],
  };
  return {
    id,
    capabilities: async () => capabilities,
    run: async (options: AgentStartOptions, onEvent): Promise<AgentRunResult> => {
      onEvent({ kind: 'started', sessionId: `${id}-session`, model: 'test' });
      if (options.role === 'implementer') {
        fs.writeFileSync(path.join(options.cwd, 'feature.txt'), 'implemented by the fixture\n');
        const result = 'Added the requested fixture and left verification to Jarvis.';
        onEvent({ kind: 'text', text: result });
        return {
          status: 'completed',
          result,
          sessionId: `${id}-session`,
          memoryProposals: [
            {
              type: 'decision',
              scope: 'project',
              subject: 'decision.fixture_format',
              content: 'The integration fixture uses a plain text artifact and a Node verifier.',
              importance: 0.8,
              confidence: 0.99,
              reason: 'Verified project convention from the completed job',
            },
          ],
        };
      }
      const result =
        '```json\n{"verdict":"approve","summary":"The focused change meets the request and its deterministic check passed.","findings":[]}\n```';
      onEvent({ kind: 'text', text: result });
      return {
        status: 'completed',
        result,
        sessionId: `${id}-session`,
        memoryProposals: [],
      };
    },
  };
}

describe('bootstrap vertical slice without cloud quota', () => {
  it('persists scoped memory and completes worktree, verification, review and episode stages', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-integration-'));
    homes.push(home);
    const repo = path.join(home, 'project');
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(repo, 'verify.mjs'),
      "import fs from 'node:fs'; if (!fs.existsSync(new URL('./feature.txt', import.meta.url))) process.exit(1);\n",
    );
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '.');
    git(
      repo,
      '-c',
      'user.name=Jarvis Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-m',
      'base',
    );

    const base = loadConfig({
      home,
      memory: { ...loadConfig({ home }).memory, embeddingsEnabled: false },
      context: { ...loadConfig({ home }).context, budgetTokens: 500 },
    });
    const db = openDb(base);
    activeDb = db;
    const bus = new EventBus(db);
    const memory = new MemoryService({ db, bus, config: base });
    const context = new ContextPackBuilder(db, memory, base);
    const projects = new ProjectService(db);
    const sessions = new SessionService(db, bus);
    const jobs = new JobService(db, bus);
    const verification = new VerificationEngine(db, base.artifactsDir, bus);
    const claude = provider('claude');
    const codex = provider('codex');
    const registry = {
      get: (id: ProviderId) => (id === 'claude' ? claude : codex),
      capabilities: async () => [await claude.capabilities(), await codex.capabilities()],
      route: async (role: string) => ({
        provider: role === 'reviewer' ? codex : claude,
        capabilities: await (role === 'reviewer' ? codex : claude).capabilities(),
      }),
    } as unknown as AgentRegistry;
    const review = new ReviewEngine(db, registry, bus, base);
    const pipeline = new JobPipeline({
      db,
      bus,
      config: base,
      jobs,
      projects,
      sessions,
      memory,
      context,
      agents: registry,
      verification,
      review,
    });

    const project = await projects.register({
      name: 'fixture-a',
      rootPath: repo,
      commands: { test: 'node verify.mjs' },
    });
    const sibling = await memory.remember({
      scope: 'project',
      scopeId: 'project-b',
      kind: 'fact',
      content: 'Project B uses a completely unrelated deployment process.',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(sibling.status).toBe('stored');

    const oldPreference = await memory.remember({
      scope: 'project',
      scopeId: project.id,
      kind: 'preference',
      subject: 'preference.fixture',
      content: 'Preference = A',
      sourceType: 'user_explicit',
      explicit: true,
    });
    const newPreference = await memory.remember({
      scope: 'project',
      scopeId: project.id,
      kind: 'preference',
      subject: 'preference.fixture',
      content: 'Preference = B',
      sourceType: 'user_explicit',
      explicit: true,
    });
    expect(oldPreference.status).toBe('stored');
    expect(newPreference.status).toBe('stored');
    if (oldPreference.status !== 'stored' || newPreference.status !== 'stored') return;
    expect(memory.get(oldPreference.memory.id)?.status).toBe('superseded');

    const job = jobs.create({
      projectId: project.id,
      request: 'Create the feature fixture and verify it.',
      acceptance: ['feature.txt exists', 'the configured verifier passes'],
    });
    pipeline.start(job.id);

    const deadline = Date.now() + 30_000;
    let finished = jobs.get(job.id);
    while (finished?.status === 'pending' || finished?.status === 'running') {
      if (Date.now() > deadline) throw new Error('pipeline did not finish');
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = jobs.get(job.id);
    }

    expect(finished?.stage).toBe('awaiting_user');
    expect(finished?.worktreePath).toBeTruthy();
    if (!finished?.worktreePath) throw new Error('candidate worktree missing');
    expect(fs.existsSync(path.join(finished.worktreePath, 'feature.txt'))).toBe(true);
    expect(verification.list(job.id).some((result) => result.status === 'passed')).toBe(true);
    expect(review.list(job.id)[0]?.verdict).toBe('approve');
    expect(jobs.runs(job.id).map((run) => run.role)).toEqual(['implementer', 'reviewer']);

    const episode = finished?.episodeId ? memory.get(finished.episodeId) : null;
    expect(episode?.kind).toBe('episode');
    if (!episode) throw new Error('job episode missing');
    expect(episode?.content).toContain('Verification: test:passed');
    expect(episode?.content).not.toContain('```json');

    const resumePack = await context.build({
      role: 'implementer',
      query: 'fixture plain text artifact Node verifier',
      projectId: project.id,
      jobId: 'related-job',
      budgetTokens: 1200,
    });
    expect(resumePack.selections.some((selection) => selection.memoryId === episode?.id)).toBe(
      true,
    );
    expect(resumePack.rendered).not.toContain('Project B uses');
    expect(resumePack.usedTokens).toBeLessThanOrEqual(1200);

    const episodeId = episode.id;
    db.close();
    activeDb = null;
    const reopened = openDb(base);
    activeDb = reopened;
    const persisted = new MemoryService({
      db: reopened,
      bus: new EventBus(reopened),
      config: base,
    });
    expect(persisted.get(episodeId)?.content).toBe(episode?.content);
    reopened.close();
    activeDb = null;
  });
});
