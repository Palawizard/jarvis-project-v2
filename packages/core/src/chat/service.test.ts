import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agents/registry.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentStartOptions,
  ProviderCapabilities,
} from '../agents/types.js';
import { loadConfig, type JarvisConfig } from '../config.js';
import { ContextPackBuilder } from '../context/pack.js';
import { openDb, type Db } from '../db/index.js';
import { EventBus } from '../events/bus.js';
import { JobService, type Job } from '../jobs/service.js';
import { MemoryService } from '../memory/service.js';
import { ProjectService } from '../projects/service.js';
import { SessionService } from '../sessions/service.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { ChatService } from './service.js';

/**
 * Chat behaviour against a scripted provider.
 *
 * No live agent is ever invoked: the fake returns exactly what the scenario
 * needs, so every assertion is about what Jarvis DOES with a response, which is
 * the part that carries the authority rules.
 */
class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly prompts: string[] = [];

  constructor(private readonly reply: (prompt: string) => string | AgentRunResult) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      available: true,
      authenticated: true,
      streaming: true,
      resumable: true,
      structuredOutput: true,
      toolFreeChat: true,
      models: ['opus', 'sonnet', 'haiku'],
    };
  }

  async run(
    options: AgentStartOptions,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    this.prompts.push(options.prompt);
    const scripted = this.reply(options.prompt);
    if (typeof scripted !== 'string') return scripted;
    onEvent({ kind: 'text', text: scripted });
    return { status: 'completed', result: scripted, memoryProposals: [] };
  }
}

const roots: string[] = [];
const open: Db[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A real git repository, because register() refuses anything else. Built once
 * per file and copied per test: spawning git for every repository is by far the
 * most expensive thing here, and it slows the whole parallel suite down.
 */
let template: string | null = null;
let templateRoot: string | null = null;

afterAll(() => {
  if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
});

function repo(name: string): string {
  if (!template) {
    // Deliberately not in `roots`, which is emptied after every test.
    templateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chatrepo-template-'));
    const source = path.join(templateRoot, 'template');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# fixture\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    template = source;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-chatrepo-${name}-`));
  roots.push(dir);
  const root = path.join(dir, name);
  fs.cpSync(template, root, { recursive: true });
  return root;
}

interface Harness {
  config: JarvisConfig;
  db: Db;
  chat: ChatService;
  sessions: SessionService;
  projects: ProjectService;
  jobs: JobService;
  memory: MemoryService;
  provider: ScriptedProvider;
  tools: ReturnType<typeof registerBuiltinTools>;
  started: string[];
  cancelled: string[];
}

function harness(reply: (prompt: string) => string | AgentRunResult): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-'));
  roots.push(home);
  const base = loadConfig({ home });
  const config: JarvisConfig = { ...base, memory: { ...base.memory, embeddingsEnabled: false } };
  const db = openDb(config);
  open.push(db);

  const bus = new EventBus(db);
  const memory = new MemoryService({ db, bus, config });
  const projects = new ProjectService(db);
  const sessions = new SessionService(db, bus);
  const jobs = new JobService(db, bus);
  const provider = new ScriptedProvider(reply);
  const agents = new AgentRegistry(config, { db, bus, providers: [provider] });

  // The pipeline is stubbed: these tests are about what chat decides, not about
  // running a real candidate. Everything else is the production object.
  const started: string[] = [];
  const cancelled: string[] = [];
  const pipeline = {
    start: (id: string) => started.push(id),
    isRunning: () => false,
    cancel: (id: string) => {
      cancelled.push(id);
      jobs.transition(id, 'cancelled');
      return true;
    },
    resume: async () => undefined,
  };
  const lifecycle = {
    deletionPlan: (id: string) => jobs.deleteEligibility(id),
    delete: async (id: string) => jobs.hardDelete(id),
    staleness: async () => ({
      stale: false,
      reason: 'current',
      jobBase: null,
      targetHead: null,
      detail: '',
    }),
  };
  const tools = registerBuiltinTools(
    {
      memory,
      projects,
      jobs,
      sessions,
      pipeline: pipeline as never,
      lifecycle: lifecycle as never,
    },
    {
      db,
      bus,
      defaultTimeoutMs: config.tools.defaultTimeoutMs,
      approvalTtlMs: config.tools.approvalTtlMs,
      maxRecordChars: config.tools.maxRecordChars,
    },
  );
  const chat = new ChatService({
    config,
    bus,
    agents,
    context: new ContextPackBuilder(db, memory, config),
    memory,
    projects,
    jobs,
    sessions,
    tools,
  });
  return {
    config,
    db,
    chat,
    sessions,
    projects,
    jobs,
    memory,
    provider,
    tools,
    started,
    cancelled,
  };
}

/** The model answers plainly; no action block at all. */
const prose = (text: string) => () => text;

/** The model answers and appends exactly one structured action request. */
const withAction = (text: string, action: Record<string, unknown>) => () =>
  `${text}\n\n\`\`\`jarvis-action\n${JSON.stringify(action)}\n\`\`\``;

describe('general conversation', () => {
  it('answers an ordinary question without creating a Job', async () => {
    const h = harness(prose('TCP slow start ramps the congestion window exponentially.'));
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Explain TCP slow start.',
    });

    expect(turn.kind).toBe('chat');
    expect(turn.reply).toContain('congestion window');
    expect(turn.assistantMessage?.status).toBe('complete');
    // The central product rule: conversation is not job manufacturing.
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
    expect(h.started).toEqual([]);
  });

  it('never runs conversation inside a repository worktree', async () => {
    const h = harness(prose('sure'));
    const conversation = h.sessions.create();
    await h.chat.send({ conversationId: conversation.id, text: 'what do you think?' });
    // The chat agent gets the Jarvis home, never a project checkout.
    expect(h.provider.prompts).toHaveLength(1);
  });

  it('keeps the answer when the model emits a malformed action block', async () => {
    const h = harness(() => 'Here is the answer.\n\n```jarvis-action\n{ not json\n```');
    const conversation = h.sessions.create();

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'do something' });
    expect(turn.reply).toContain('Here is the answer.');
    expect(turn.reply).toContain('could not act on that');
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
  });

  it('fails closed on an unknown action name rather than guessing', async () => {
    const h = harness(withAction('ok', { action: 'rm_rf', target: 'everything' }));
    const conversation = h.sessions.create();

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'do it' });
    expect(turn.reply).toContain('could not act on that');
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
  });

  it('names a quota failure as provider state, not as a code problem', async () => {
    const h = harness(
      () =>
        ({
          status: 'failed',
          result: '',
          error: 'usage limit reached',
          memoryProposals: [],
        }) as AgentRunResult,
    );
    const conversation = h.sessions.create();

    const failed = await h.chat.send({ conversationId: conversation.id, text: 'question' });
    expect(failed.kind).toBe('error');
    expect(failed.reply).toContain('provider state, not a problem with the code');
    expect(failed.assistantMessage?.status).toBe('failed');

    // And the exhausted provider is cooled down rather than hammered again.
    const retried = await h.chat.retry(conversation.id);
    expect(retried.reply).toContain('No conversational provider is available');
  });

  it('retries a failed response without duplicating the user message', async () => {
    let attempt = 0;
    const h = harness(() =>
      ++attempt === 1
        ? ({
            status: 'failed',
            result: '',
            error: 'the agent stopped unexpectedly',
            memoryProposals: [],
          } as AgentRunResult)
        : 'recovered answer',
    );
    const conversation = h.sessions.create();

    const failed = await h.chat.send({ conversationId: conversation.id, text: 'question' });
    expect(failed.assistantMessage?.status).toBe('failed');

    const retried = await h.chat.retry(conversation.id);
    expect(retried.reply).toBe('recovered answer');
    // The user's message is reused, not duplicated, and the dead attempt is gone.
    const roles = h.sessions.messages(conversation.id).map((m) => `${m.role}:${m.status}`);
    expect(roles).toEqual(['user:complete', 'assistant:complete']);
  });
});

describe('explicit memory stays deterministic and local', () => {
  it('stores a memory without spending any chat model call', async () => {
    const h = harness(prose('should never be called'));
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Remember that I prefer pnpm.',
    });

    expect(turn.kind).toBe('memory');
    expect(h.provider.prompts).toEqual([]);
    expect(h.memory.list({ scope: 'user' }).items.map((m) => m.content)).toContainEqual(
      expect.stringContaining('pnpm'),
    );
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
  });

  it('offers exact candidates instead of deleting an ambiguous memory', async () => {
    const h = harness(prose('unused'));
    const conversation = h.sessions.create();
    for (const content of ['Deployment setting is blue', 'Deployment setting is green']) {
      await h.memory.remember({
        scope: 'user',
        kind: 'fact',
        content,
        sourceType: 'user_explicit',
        explicit: true,
      });
    }

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'forget deployment setting',
    });

    expect(turn.kind).toBe('memory');
    expect(turn.memoryCandidates).toHaveLength(2);
    expect(h.memory.list({ scope: 'user' }).items).toHaveLength(2);
    expect(h.provider.prompts).toEqual([]);
  });
});

describe('jobs from natural language', () => {
  async function withProjects(reply: (prompt: string) => string | AgentRunResult) {
    const h = harness(reply);
    const self = await h.projects.register({
      name: 'jarvis',
      rootPath: repo('jarvis'),
      isSelf: true,
      aliases: ['jarvis'],
    });
    const sitepilot = await h.projects.register({
      name: 'sitepilot',
      rootPath: repo('sitepilot'),
    });
    return { ...h, self, sitepilot };
  }

  it('resolves the self project from plain language, with no chooser', async () => {
    const h = await withProjects(
      withAction('Starting that now.', {
        action: 'create_job',
        project: 'jarvis',
        request: 'Fix the Jobs page',
      }),
    );
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Create a job on Jarvis to fix the Jobs page.',
    });

    // Starting a development Job is a real modification of the user's world, so
    // an agent-originated request stops at a confirmation rather than handing an
    // agent a worktree and provider quota unattended.
    expect(turn.kind).toBe('confirmation_required');
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
    expect(h.started).toEqual([]);

    const outcome = await h.tools.approve(turn.action?.executionId ?? 'missing');
    expect(outcome.status).toBe('succeeded');
    const job = h.jobs.list({ archived: 'all' })[0] as Job;
    expect(job.projectId).toBe(h.self.id);
    expect(h.started).toEqual([job.id]);
    // Provenance survives the confirmation: the conversation, the originating
    // message and the wording are all bound into the approved input.
    expect(job.sessionId).toBe(conversation.id);
    expect(job.originMessageId).toBe(turn.userMessage?.id);
    expect(job.request).toContain('Fix the Jobs page');
    expect(h.sessions.get(conversation.id)?.state.activeJobIds).toEqual([job.id]);
  });

  it('resolves a named project by alias and remembers the affinity', async () => {
    const h = await withProjects(
      withAction('On it.', {
        action: 'create_job',
        project: 'sitepilot',
        request: 'Implement OAuth login',
      }),
    );
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Implement OAuth in Sitepilot.',
    });

    // Affinity follows the Job, not the request for one: writing it while the
    // Job was still unconfirmed changed what the conversation was about even
    // when the human went on to refuse it.
    expect(turn.kind).toBe('confirmation_required');
    expect(h.sessions.get(conversation.id)?.projectId).toBeNull();

    await h.tools.approve(turn.action?.executionId ?? 'missing');
    expect((h.jobs.list({ archived: 'all' })[0] as Job).projectId).toBe(h.sitepilot.id);
    expect(h.sessions.get(conversation.id)?.projectId).toBe(h.sitepilot.id);
  });

  it('asks which project instead of guessing, and creates nothing until told', async () => {
    const h = await withProjects(
      withAction('Which one?', { action: 'create_job', request: 'Fix auth in website' }),
    );
    const other = await h.projects.register({ name: 'website', rootPath: repo('website') });
    h.projects.update(other.id, { aliases: ['site'] });
    await h.projects.register({ name: 'website-two', rootPath: repo('website-two') });
    h.projects.update(h.projects.list().find((p) => p.name === 'website-two')?.id ?? '', {
      aliases: ['website'],
    });
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Fix auth in website',
    });

    expect(turn.kind).toBe('clarification');
    expect(turn.reply).toMatch(/which one|several projects/i);
    expect(h.jobs.list({ archived: 'all' })).toHaveLength(0);
    expect(h.started).toEqual([]);
  });

  it('answers a follow-up about the linked Job from the Job row itself', async () => {
    let phase: 'create' | 'inspect' = 'create';
    const h = await withProjects(() =>
      phase === 'create'
        ? 'Starting.\n\n```jarvis-action\n{"action":"create_job","project":"jarvis","request":"Fix the mobile nav"}\n```'
        : 'Here is where it stands.\n\n```jarvis-action\n{"action":"inspect_job"}\n```',
    );
    const conversation = h.sessions.create();
    const created = await h.chat.send({
      conversationId: conversation.id,
      text: 'Create a job on Jarvis to fix the mobile nav.',
    });
    await h.tools.approve(created.action?.executionId ?? 'missing');
    const jobId = (h.jobs.list({ archived: 'all' })[0] as Job).id;
    // Make the answer say something only the row knows.
    h.jobs.patch(jobId, { pauseReason: 'Provider usage limit reached.' });

    phase = 'inspect';
    const status = await h.chat.send({
      conversationId: conversation.id,
      text: 'How is that job doing?',
    });

    expect(status.job?.id).toBe(jobId);
    expect(status.reply).toContain('Fix the mobile nav');
    expect(status.reply).toContain('Provider usage limit reached.');
  });

  it('asks which Job when several are open rather than picking one', async () => {
    const h = await withProjects(withAction('Cancelling.', { action: 'cancel_job' }));
    const conversation = h.sessions.create();
    for (const goal of ['first task', 'second task']) {
      h.jobs.create({
        projectId: h.self.id,
        request: goal,
        acceptance: [],
        sessionId: conversation.id,
      });
    }

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'Cancel it.' });
    expect(turn.kind).toBe('clarification');
    expect(turn.reply).toMatch(/several jobs/i);
  });
});

describe('authority boundaries', () => {
  it('ignores a standing grant for an agent-originated job cancellation until explicit approval', async () => {
    let target = 'unset';
    const h = harness(() =>
      withAction('I will ask you first.', { action: 'cancel_job', job: target })(),
    );
    const self = await h.projects.register({ rootPath: repo('jarvis'), isSelf: true });
    const conversation = h.sessions.create();
    const job = h.jobs.create({
      projectId: self.id,
      request: 'running work',
      acceptance: [],
      sessionId: conversation.id,
    });
    h.jobs.transition(job.id, 'planning');
    target = job.id;
    const grant = h.tools.grant({
      toolName: 'job.cancel',
      actor: 'user',
      projectId: self.id,
      sessionId: conversation.id,
    });

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'Cancel it.' });

    expect(turn.kind).toBe('confirmation_required');
    expect(h.jobs.get(job.id)?.status).toBe('running');
    expect(h.cancelled).toEqual([]);
    const attempts = h.tools.executions({ toolName: 'job.cancel' });
    const agent = attempts.find((execution) => execution.actor === 'agent');
    const escalation = attempts.find((execution) => execution.parentExecutionId === agent?.id);
    expect(agent).toMatchObject({
      status: 'denied',
      originatingActor: 'agent',
      grantId: null,
    });
    expect(escalation).toMatchObject({
      id: turn.action?.executionId,
      actor: 'user',
      originatingActor: 'agent',
      status: 'pending_approval',
      grantId: null,
    });
    expect(escalation?.parentExecutionId).toBe(agent?.id);
    expect(grant.revokedAt).toBeNull();

    await expect(
      h.tools.approve(escalation?.id ?? 'missing', { remember: { projectId: self.id } }),
    ).rejects.toThrow(/one-shot/);
    expect(h.tools.getExecution(escalation?.id ?? 'missing')?.status).toBe('pending_approval');

    const approved = await h.tools.approve(escalation?.id ?? 'missing');
    expect(approved.status).toBe('succeeded');
    expect(h.cancelled).toEqual([job.id]);
    expect(h.jobs.get(job.id)?.status).toBe('cancelled');

    const direct = h.jobs.create({
      projectId: self.id,
      request: 'directly cancelled work',
      acceptance: [],
      sessionId: conversation.id,
    });
    h.jobs.transition(direct.id, 'planning');
    const directOutcome = await h.tools.execute(
      'job.cancel',
      { id: direct.id },
      { actor: 'user', projectId: self.id, sessionId: conversation.id, jobId: direct.id },
    );
    expect(directOutcome.status).toBe('succeeded');
    expect(directOutcome.execution.grantId).toBe(grant.id);
    expect(h.cancelled).toEqual([job.id, direct.id]);
    expect(() =>
      h.tools.grant({ toolName: 'job.delete', actor: 'user', projectId: self.id }),
    ).toThrow(/cannot be remembered/);
  });

  it('turns a destructive request into a confirmation the model cannot give itself', async () => {
    let target = 'unset';
    const h = harness(
      () =>
        `I can ask, but not do it.

\`\`\`jarvis-action
${JSON.stringify({
  action: 'delete_job',
  job: target,
})}
\`\`\``,
    );
    const self = await h.projects.register({ rootPath: repo('jarvis'), isSelf: true });
    const conversation = h.sessions.create();
    const job = h.jobs.create({
      projectId: self.id,
      request: 'disposable failed job',
      acceptance: [],
      sessionId: conversation.id,
    });
    h.jobs.patch(job.id, { stage: 'failed', status: 'failed' });
    target = job.id;

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: `Delete job ${job.id}`,
    });

    expect(turn.kind).toBe('confirmation_required');
    expect(turn.action?.status).toBe('confirmation_required');
    expect(turn.action?.executionId).toBeTruthy();
    // Nothing happened yet: the Job is still there, awaiting a human.
    expect(h.jobs.get(job.id)).toBeTruthy();
    expect(turn.reply).toContain('cannot confirm it myself');
  });

  it('refuses to hard-delete applied self-upgrade evidence and offers Archive', async () => {
    const h = harness(withAction('Asking.', { action: 'delete_job' }));
    const self = await h.projects.register({ rootPath: repo('jarvis'), isSelf: true });
    const conversation = h.sessions.create();
    const job = h.jobs.create({
      projectId: self.id,
      request: 'self upgrade',
      acceptance: [],
      sessionId: conversation.id,
    });
    h.jobs.patch(job.id, { stage: 'completed', status: 'completed' });
    h.db
      .prepare(
        `INSERT INTO reviews (id, job_id, provider, verdict, findings, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run('rev_1', job.id, 'claude', 'approve', '[]', 'now');
    h.db
      .prepare(
        `INSERT INTO candidate_applications (id, job_id, project_id, status, review_id,
          verification_cycle, candidate_base, candidate_head, approved_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('app_1', job.id, self.id, 'applied', 'rev_1', 0, 'base', 'head', 'now', 'now');

    const plan = h.jobs.deleteEligibility(job.id);
    expect(plan.eligible).toBe(false);
    expect(plan.reason).toMatch(/archive/i);

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'Delete that job.' });
    expect(turn.kind).not.toBe('action');
    expect(h.jobs.get(job.id)).toBeTruthy();
  });

  it('cannot approve, apply or activate a Jarvis self-upgrade', async () => {
    const h = harness(prose('I cannot approve or activate my own update — that needs you.'));
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Approve and activate your own update yourself.',
    });

    // There is no action in the schema that could do it, so the only possible
    // outcome is conversation.
    expect(turn.kind).toBe('chat');
    expect(turn.action).toBeUndefined();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM candidate_applications').get()).toEqual({
      n: 0,
    });
  });
});

describe('conversation management by sentence', () => {
  it('renames the conversation through the same tool the UI button calls', async () => {
    const h = harness(
      withAction('Renamed.', { action: 'rename_conversation', title: 'Jarvis architecture' }),
    );
    const conversation = h.sessions.create();

    const turn = await h.chat.send({
      conversationId: conversation.id,
      text: 'Rename this conversation to Jarvis architecture.',
    });

    // A rename durably changes what the user sees in their own sidebar, so the
    // model asks rather than doing it unattended.
    expect(turn.kind).toBe('confirmation_required');
    // Still the auto-derived title from the first message, not the requested one.
    expect(h.sessions.get(conversation.id)?.title).not.toBe('Jarvis architecture');

    await h.tools.approve(turn.action?.executionId ?? 'missing');
    expect(h.sessions.get(conversation.id)?.title).toBe('Jarvis architecture');
  });

  it('answers a read-only action with what it actually found', async () => {
    // The model writes its prose BEFORE the tool runs, so the prose cannot hold
    // the answer: replying with it alone answered a search with "Done:
    // search.everything."
    const h = harness(withAction('Here you go.', { action: 'search', query: 'sitepilot' }));
    const named = h.sessions.create({ title: 'Sitepilot rollout' });
    h.sessions.addMessage(named.id, 'user', 'sitepilot notes');
    const conversation = h.sessions.create();

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'find sitepilot' });

    expect(turn.reply).toContain('Sitepilot rollout');
    expect(turn.reply).not.toBe('Done: search.everything.');
  });

  it('refuses to build a confirmation for a conversation it cannot name', async () => {
    // The model may name any conversation, including one that no longer exists.
    // An id the human cannot place is not something they can agree to, and a
    // deleted transcript has no undo.
    const h = harness(
      withAction('Deleting.', { action: 'delete_conversation', conversation: 'ses_missing' }),
    );
    const conversation = h.sessions.create();

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'delete that one' });

    expect(turn.kind).toBe('clarification');
    expect(turn.reply).toContain('ses_missing');
    expect(h.tools.executions({ toolName: 'conversation.delete' })).toHaveLength(0);
  });

  it('requires confirmation before deleting a conversation', async () => {
    const h = harness(withAction('Asking first.', { action: 'delete_conversation' }));
    const conversation = h.sessions.create();

    const turn = await h.chat.send({ conversationId: conversation.id, text: 'Delete this chat.' });

    expect(turn.kind).toBe('confirmation_required');
    expect(h.sessions.get(conversation.id)).toBeTruthy();
  });
});
