import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../memory/secrets.js';
import type { JarvisConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRegistry } from '../agents/registry.js';
import { classifyAgentFailure, describeAgentFailure } from '../agents/registry.js';
import type { AgentEvent, AgentRunResult } from '../agents/types.js';
import type { ContextPackBuilder } from '../context/pack.js';
import type { MemoryService } from '../memory/service.js';
import type { Memory, MemoryScope } from '../memory/types.js';
import { classifyExplicitMemory, detectExplicitCommand } from '../memory/policy.js';
import type { Project, ProjectService } from '../projects/service.js';
import type { Job, JobService } from '../jobs/service.js';
import { renderProjectSnapshot } from '../jobs/pipeline.js';
import type { Message, SessionService } from '../sessions/service.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SearchHit } from '../tools/builtin.js';
import {
  ACTION_TOOLS,
  CHAT_ACTION_INSTRUCTIONS,
  extractChatAction,
  type ChatAction,
  type ChatActionName,
} from './actions.js';

export interface ChatDeps {
  config: JarvisConfig;
  bus: EventBus;
  agents: AgentRegistry;
  context: ContextPackBuilder;
  memory: MemoryService;
  projects: ProjectService;
  jobs: JobService;
  sessions: SessionService;
  tools: ToolRegistry;
}

export type ChatTurnKind =
  'memory' | 'chat' | 'action' | 'clarification' | 'confirmation_required' | 'error';

export interface ChatTurn {
  conversationId: string;
  kind: ChatTurnKind;
  reply: string;
  userMessage: Message | null;
  assistantMessage: Message | null;
  action?: {
    name: ChatActionName;
    status: 'executed' | 'confirmation_required' | 'refused';
    /** Set when the action is waiting for the human. Approve it to run it. */
    executionId?: string;
    error?: string;
  };
  job?: Job | null;
  /** Ambiguous "forget" targets, rendered in-chat for exact selection. */
  memoryCandidates?: Memory[];
  /** Ambiguous project resolution, rendered in-chat for exact selection. */
  projectCandidates?: Project[];
}

/** Reasonable ceiling on transcript turns handed to the model. */
const CONTEXT_TURNS = 12;

/**
 * The conversational front door.
 *
 * Everything the user types arrives here, and exactly one of four things
 * happens: a deterministic memory operation with no model call, a structured
 * action requested by the model and decided by trusted code, a request for
 * human confirmation, or an ordinary answer. A normal message never creates a
 * Job — that only happens when an action explicitly asks for one and a project
 * resolves unambiguously.
 */
/** Upper bound on how often a partial streamed answer is written to the row. */
const STREAM_PERSIST_MS = 250;

export class ChatService {
  /** One in-flight response per conversation, so Stop has something to abort. */
  private readonly running = new Map<string, AbortController>();

  /** Empty, parent-owned, and never the Jarvis home. Created on first use. */
  private scratchDir(): string {
    const dir = path.join(this.deps.config.home, 'chat-scratch');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  constructor(private readonly deps: ChatDeps) {}

  isResponding(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  stop(conversationId: string): boolean {
    const controller = this.running.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async send(input: { conversationId: string; text: string }): Promise<ChatTurn> {
    const { sessions } = this.deps;
    const conversation = sessions.get(input.conversationId);
    if (!conversation) throw new Error('conversation not found');
    const text = input.text.trim();
    if (!text) throw new Error('text is required');
    if (this.running.has(conversation.id)) {
      throw new Error('this conversation is already producing a response');
    }

    const userMessage = sessions.addMessage(conversation.id, 'user', text);

    // Stage A: explicit memory commands stay deterministic and local. Spending
    // provider quota to decide whether "remember that I prefer pnpm" is a memory
    // command is exactly the pattern the design forbids.
    const explicit = detectExplicitCommand(text);
    if (explicit) return this.handleMemoryCommand(conversation.id, explicit, userMessage);

    return this.respond(conversation.id, userMessage);
  }

  /**
   * Re-run the last assistant turn.
   *
   * The user's message is reused rather than duplicated, and the failed or
   * stopped response is replaced instead of accumulating dead attempts.
   */
  async retry(conversationId: string): Promise<ChatTurn> {
    const { sessions } = this.deps;
    if (this.running.has(conversationId)) {
      throw new Error('this conversation is already producing a response');
    }
    // Ask the database for the newest row rather than the tail of a window:
    // whether this conversation has ten messages or ten thousand, "last" must
    // mean last.
    const last = sessions.lastMessage(conversationId);
    if (last?.role !== 'assistant' || !['failed', 'stopped', 'interrupted'].includes(last.status)) {
      throw new Error('only a failed, stopped, or interrupted response can be retried');
    }
    sessions.deleteMessage(last.id);
    const userMessage = sessions.lastUserMessage(conversationId);
    if (!userMessage) throw new Error('there is no user message to answer');
    return this.respond(conversationId, userMessage);
  }

  /** Replace the most recent user message and answer the new one. */
  async editLastUserMessage(conversationId: string, text: string): Promise<ChatTurn> {
    const { sessions } = this.deps;
    // Refuse before deleting anything. This used to delete the tail and then
    // call send(), which throws while a response is streaming -- losing both the
    // old turn and the new text.
    if (this.running.has(conversationId)) {
      throw new Error('this conversation is already producing a response');
    }
    const lastUser = sessions.lastUserMessage(conversationId);
    if (!lastUser) throw new Error('there is no user message to edit');
    // Everything after the message being replaced, found from the real end of
    // the transcript rather than from a window that may not contain it.
    for (const message of sessions
      .messages(conversationId, 500)
      .filter((message) => message.createdAt >= lastUser.createdAt && message.role !== 'user')) {
      sessions.deleteMessage(message.id);
    }
    sessions.deleteMessage(lastUser.id);
    return this.send({ conversationId, text });
  }

  // ------------------------------------------------------------- memory path --

  private async handleMemoryCommand(
    conversationId: string,
    explicit: ReturnType<typeof detectExplicitCommand> & object,
    userMessage: Message,
  ): Promise<ChatTurn> {
    const { memory, sessions } = this.deps;
    const conversation = sessions.get(conversationId);
    const projectId = conversation?.projectId ?? null;
    const scopes = [
      { scope: 'user' as MemoryScope, scopeId: null },
      ...(projectId ? [{ scope: 'project' as MemoryScope, scopeId: projectId }] : []),
    ];

    if (explicit.action === 'remember') {
      const scope: MemoryScope = projectId ? 'project' : 'user';
      const outcome = await memory.remember({
        scope,
        scopeId: projectId,
        kind: classifyExplicitMemory(explicit.payload, scope),
        content: explicit.payload,
        sourceType: 'user_explicit',
        sourceRef: { sessionId: conversationId },
        explicit: true,
      });
      const reply =
        outcome.status === 'stored'
          ? `Remembered${outcome.supersededId ? ' (and superseded the previous value)' : ''}.`
          : outcome.status === 'duplicate'
            ? 'I already knew that — kept the existing memory.'
            : `Not stored: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`;
      return this.finishMemoryTurn(conversationId, userMessage, reply);
    }

    if (explicit.action === 'forget') {
      const resolution = await memory.resolveForget(explicit.payload, scopes);
      if (resolution.status === 'not_found') {
        return this.finishMemoryTurn(
          conversationId,
          userMessage,
          `I could not find a memory matching "${explicit.payload}".`,
        );
      }
      if (resolution.status === 'ambiguous') {
        return {
          ...this.finishMemoryTurn(
            conversationId,
            userMessage,
            'Several memories could match. Choose the exact one to forget.',
          ),
          memoryCandidates: resolution.candidates,
        };
      }
      memory.forget(resolution.memory.id);
      return this.finishMemoryTurn(
        conversationId,
        userMessage,
        `Forgot: "${resolution.memory.content}"`,
      );
    }

    const matches = await memory.retrieve({ query: explicit.payload, scopes, limit: 3 });
    const target = matches[0];
    if (target) {
      await memory.correct(target.memory.id, explicit.payload, { sessionId: conversationId });
      return this.finishMemoryTurn(
        conversationId,
        userMessage,
        'Updated — the previous version is kept as superseded.',
      );
    }
    await memory.remember({
      scope: projectId ? 'project' : 'user',
      scopeId: projectId,
      kind: 'correction',
      content: explicit.payload,
      sourceType: 'user_explicit',
      sourceRef: { sessionId: conversationId },
      explicit: true,
    });
    return this.finishMemoryTurn(conversationId, userMessage, 'Noted as a new memory.');
  }

  private finishMemoryTurn(conversationId: string, userMessage: Message, reply: string): ChatTurn {
    const assistantMessage = this.deps.sessions.addMessage(conversationId, 'assistant', reply, {
      metadata: { activity: 'memory' },
    });
    return {
      conversationId,
      kind: 'memory',
      reply,
      userMessage,
      assistantMessage,
    };
  }

  // --------------------------------------------------------------- chat path --

  private async respond(conversationId: string, userMessage: Message): Promise<ChatTurn> {
    const { sessions, agents, context, projects, config } = this.deps;
    const conversation = sessions.get(conversationId);
    if (!conversation) throw new Error('conversation not found');

    const placeholder = sessions.addMessage(conversationId, 'assistant', '', {
      status: 'pending',
    });
    const controller = new AbortController();
    this.running.set(conversationId, controller);

    try {
      const project = conversation.projectId ? projects.get(conversation.projectId) : null;
      const pack = await context.build({
        role: 'chat',
        query: userMessage.content,
        projectId: conversation.projectId,
        sessionId: conversationId,
        projectSnapshot: project ? renderProjectSnapshot(project) : null,
        sessionState: sessions.renderState(conversation.state),
      });

      const routed = await agents.route('chat', {
        taskProfile: { modelProfile: 'balanced' },
      });
      if (!routed.provider) {
        const reason = `No conversational provider is available right now: ${routed.reason}`;
        sessions.updateMessage(placeholder.id, {
          content: reason,
          status: 'failed',
          metadata: { error: reason },
        });
        return {
          conversationId,
          kind: 'error',
          reply: reason,
          userMessage,
          assistantMessage: sessions.getMessage(placeholder.id),
        };
      }

      sessions.updateMessage(placeholder.id, { status: 'streaming' });
      let streamed = '';
      let persistedAt = 0;
      const onEvent = (event: AgentEvent) => {
        if (event.kind !== 'text') return;
        streamed += event.text;
        // Persist the partial answer so a crash leaves what really arrived,
        // marked interrupted, rather than an empty bubble or a fake completion.
        //
        // Rate-bounded: a provider emits one text event per token chunk, and
        // writing each one meant an UPDATE, a session touch and an SSE frame per
        // chunk -- hundreds per answer, each one making the browser re-fetch the
        // whole conversation. Every terminal path below writes the complete
        // `streamed` string, so at most STREAM_PERSIST_MS of text is ever
        // missing from the row, and only if the process dies mid-answer.
        const now = Date.now();
        if (now - persistedAt < STREAM_PERSIST_MS) return;
        persistedAt = now;
        sessions.updateMessage(placeholder.id, { content: streamed, status: 'streaming' });
      };

      let result: AgentRunResult;
      try {
        result = await routed.provider.run(
          {
            // Never a worktree: general conversation has no repository to edit.
            // Never the Jarvis home either -- that directory holds jarvis.db
            // with every project's memory and the hashed control credential.
            // An empty parent-owned scratch directory means the confinement
            // does not rest on a provider flag behaving as documented.
            cwd: this.scratchDir(),
            prompt: this.buildChatPrompt(userMessage.content, pack.rendered, conversationId),
            role: 'chat',
            ...(routed.decision.model ? { model: routed.decision.model } : {}),
            // Jarvis owns the context, so there is no provider thread to break.
            ephemeral: true,
            safeMode: true,
            timeoutMs: config.agents.runTimeoutMs,
            signal: controller.signal,
          },
          onEvent,
        );
      } catch (error) {
        result = {
          status: 'failed',
          result: '',
          error: error instanceof Error ? error.message : String(error),
          memoryProposals: [],
        };
      }
      agents.recordResult(routed.provider.id, result);

      if (controller.signal.aborted || result.status === 'cancelled') {
        sessions.updateMessage(placeholder.id, {
          content: streamed,
          status: 'stopped',
          metadata: { error: 'stopped by you' },
        });
        return {
          conversationId,
          kind: 'chat',
          reply: streamed,
          userMessage,
          assistantMessage: sessions.getMessage(placeholder.id),
        };
      }
      if (result.status !== 'completed') {
        const kind = classifyAgentFailure(result);
        const reply = describeAgentFailure(kind, result.error);
        // Keep whatever really arrived, exactly as the stop path does. The
        // failure belongs in metadata, which the UI already renders as a badge:
        // overwriting the content threw away an answer the user watched stream.
        sessions.updateMessage(placeholder.id, {
          content: streamed || reply,
          status: 'failed',
          metadata: { error: reply },
        });
        return {
          conversationId,
          kind: 'error',
          reply,
          userMessage,
          assistantMessage: sessions.getMessage(placeholder.id),
        };
      }

      return await this.applyResponse(conversationId, userMessage, placeholder.id, result.result);
    } catch (error) {
      // The placeholder was inserted before this block, so anything that throws
      // on the way to the provider would otherwise leave a "thinking" bubble in
      // the transcript forever: retry() only accepts a failed, stopped or
      // interrupted message, so nothing short of a restart could clear it.
      const reason = error instanceof Error ? error.message : String(error);
      sessions.updateMessage(placeholder.id, {
        content: redactSecrets(reason),
        status: 'failed',
        metadata: { error: redactSecrets(reason) },
      });
      throw error;
    } finally {
      this.running.delete(conversationId);
    }
  }

  /** Split the answer from any action request, then decide the action. */
  private async applyResponse(
    conversationId: string,
    userMessage: Message,
    placeholderId: string,
    raw: string,
  ): Promise<ChatTurn> {
    const { sessions } = this.deps;
    const { prose, action, error } = extractChatAction(raw);
    const settle = (reply: string, metadata: Record<string, unknown> = {}, jobId?: string) => {
      sessions.updateMessage(placeholderId, {
        content: reply,
        status: 'complete',
        metadata: { ...metadata, ...(jobId ? { jobIds: [jobId] } : {}) },
      });
      return sessions.getMessage(placeholderId);
    };

    if (error) {
      const reply = `${prose}\n\n_I could not act on that: ${error}._`.trim();
      return {
        conversationId,
        kind: 'chat',
        reply,
        userMessage,
        assistantMessage: settle(reply),
      };
    }
    if (!action || action.action === 'normal_chat') {
      const reply = prose || '(no answer was produced)';
      return { conversationId, kind: 'chat', reply, userMessage, assistantMessage: settle(reply) };
    }
    if (action.action === 'clarify') {
      const reply = [prose, action.question, ...(action.options ?? []).map((o) => `- ${o}`)]
        .filter(Boolean)
        .join('\n\n');
      return {
        conversationId,
        kind: 'clarification',
        reply,
        userMessage,
        assistantMessage: settle(reply, { activity: 'clarification' }),
      };
    }
    return this.dispatch(conversationId, userMessage, placeholderId, prose, action);
  }

  // ------------------------------------------------------------- dispatching --

  /**
   * Turn a validated action request into a real domain operation.
   *
   * Everything goes through the tool permission boundary as `actor: 'agent'`,
   * which is what makes the authority story simple: an agent can never reach a
   * sensitive or destructive tool, so a destructive request necessarily becomes
   * a confirmation the human answers. The model cannot confirm its own request,
   * because approving is a separate authenticated call the model cannot make.
   */
  private async dispatch(
    conversationId: string,
    userMessage: Message,
    placeholderId: string,
    prose: string,
    action: Exclude<ChatAction, { action: 'normal_chat' } | { action: 'clarify' }>,
  ): Promise<ChatTurn> {
    const { sessions, jobs, tools } = this.deps;
    const settle = (
      reply: string,
      kind: ChatTurnKind,
      extra: Partial<ChatTurn> = {},
      metadata: Record<string, unknown> = {},
    ): ChatTurn => {
      sessions.updateMessage(placeholderId, {
        content: reply,
        status: 'complete',
        metadata: { activity: action.action, ...metadata },
      });
      return {
        conversationId,
        kind,
        reply,
        userMessage,
        assistantMessage: sessions.getMessage(placeholderId),
        ...extra,
      };
    };

    const resolved = await this.resolveActionInput(conversationId, action, userMessage);
    if ('problem' in resolved) {
      const reply = [prose, resolved.problem].filter(Boolean).join('\n\n');
      return settle(reply, 'clarification', {
        ...(resolved.projectCandidates ? { projectCandidates: resolved.projectCandidates } : {}),
      });
    }

    const toolName = ACTION_TOOLS[action.action];
    if (!toolName) {
      return settle(prose || 'Nothing to do.', 'chat');
    }

    const outcome = await tools.execute(toolName, resolved.input, {
      actor: 'agent',
      sessionId: conversationId,
      projectId: resolved.projectId ?? null,
      ...(resolved.jobId ? { jobId: resolved.jobId } : {}),
    });

    if (outcome.status === 'denied' && outcome.execution.reasonCode === 'actor_risk_ceiling') {
      const asUser = await tools.escalateAgentRequest(outcome.execution.id, resolved.input);
      if (asUser.status === 'pending_approval') {
        const reply = [
          prose,
          `This needs your confirmation: **${toolName}**. I cannot confirm it myself.`,
        ]
          .filter(Boolean)
          .join('\n\n');
        return settle(
          reply,
          'confirmation_required',
          {
            action: {
              name: action.action,
              status: 'confirmation_required',
              executionId: asUser.execution.id,
            },
          },
          {
            executionId: asUser.execution.id,
            tool: toolName,
            ...(resolved.targetLabel ? { target: resolved.targetLabel } : {}),
          },
        );
      }
      return this.settleToolOutcome(settle, prose, action.action, toolName, asUser);
    }

    if (outcome.status === 'pending_approval') {
      const reply = [prose, `This needs your confirmation: **${toolName}**.`]
        .filter(Boolean)
        .join('\n\n');
      return settle(
        reply,
        'confirmation_required',
        {
          action: {
            name: action.action,
            status: 'confirmation_required',
            executionId: outcome.execution.id,
          },
        },
        {
          executionId: outcome.execution.id,
          tool: toolName,
          ...(resolved.targetLabel ? { target: resolved.targetLabel } : {}),
        },
      );
    }

    if (outcome.status === 'succeeded' && action.action === 'create_job') {
      const job = outcome.result as Job;
      // Conversation state is linked inside `job.create` itself, so a Job the
      // human confirms later lands in the same place as one created here.
      if (job.originMessageId === null) {
        jobs.patch(job.id, { originMessageId: userMessage.id });
      }
      this.deps.bus.emit({
        type: 'job.linked',
        jobId: job.id,
        sessionId: conversationId,
        payload: { goal: job.goal, projectId: job.projectId },
      });
      const reply = prose || `Started **${job.goal}** on ${this.projectName(job.projectId)}.`;
      return settle(
        reply,
        'action',
        { job, action: { name: action.action, status: 'executed' } },
        { jobIds: [job.id] },
      );
    }

    if (outcome.status === 'succeeded' && action.action === 'inspect_job' && resolved.jobId) {
      // The answer about a Job is assembled from the Job row, not from what the
      // model believed about it a moment ago.
      const summary = this.describeJob(resolved.jobId);
      const reply = [prose, summary].filter(Boolean).join('\n\n');
      return settle(
        reply,
        'action',
        {
          job: jobs.get(resolved.jobId),
          action: { name: action.action, status: 'executed' },
        },
        { jobIds: [resolved.jobId] },
      );
    }

    return this.settleToolOutcome(settle, prose, action.action, toolName, outcome);
  }

  /** Deterministic, always-current one-paragraph status for a Job. */
  private describeJob(jobId: string): string {
    const job = this.deps.jobs.get(jobId);
    if (!job) {
      const tombstone = this.deps.jobs.tombstone(jobId);
      return tombstone
        ? `**${tombstone.goal}** was deleted on ${tombstone.deletedAt}.`
        : 'That Job no longer exists.';
    }
    const cycles = job.fixCycles + job.reviewFixCycles + job.visualFixCycles;
    return [
      `**${job.goal}** — ${this.projectName(job.projectId)}`,
      `- Stage: ${job.stage} (${job.status})`,
      cycles ? `- Repair cycles: ${cycles}` : '',
      job.pauseReason ? `- Paused: ${job.pauseReason.split('\n')[0]}` : '',
      job.error && !job.pauseReason ? `- Error: ${job.error.split('\n')[0]}` : '',
      `- Job id: \`${job.id}\``,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private settleToolOutcome(
    settle: (
      reply: string,
      kind: ChatTurnKind,
      extra?: Partial<ChatTurn>,
      metadata?: Record<string, unknown>,
    ) => ChatTurn,
    prose: string,
    name: ChatActionName,
    toolName: string,
    outcome: Awaited<ReturnType<ToolRegistry['execute']>>,
  ): ChatTurn {
    if (outcome.status === 'succeeded') {
      // A read-only action's whole point is its result. The model wrote its
      // prose BEFORE the tool ran, so it cannot contain the answer -- replying
      // with the prose alone answered "search my chats for sitepilot" with
      // "Done: search.everything."
      const answer = renderObservation(name, outcome.result);
      const reply = [prose, answer].filter(Boolean).join('\n') || `Done: ${toolName}.`;
      return settle(reply, 'action', { action: { name, status: 'executed' } });
    }
    const error = 'error' in outcome ? outcome.error : 'the action could not be completed';
    const reply = [prose, `I could not do that: ${error}`].filter(Boolean).join('\n\n');
    return settle(reply, 'error', { action: { name, status: 'refused', error } });
  }

  // --------------------------------------------------------------- resolution --

  /**
   * Turn conversational references ("that job", "Sitepilot", nothing at all)
   * into exact ids, or explain why that is not possible.
   */
  private async resolveActionInput(
    conversationId: string,
    action: Exclude<ChatAction, { action: 'normal_chat' } | { action: 'clarify' }>,
    userMessage: Message,
  ): Promise<
    | {
        input: Record<string, unknown>;
        projectId?: string | null;
        jobId?: string;
        /** How to name this action's target to a human, resolved server-side. */
        targetLabel?: string;
      }
    | { problem: string; projectCandidates?: Project[] }
  > {
    const { sessions, jobs, projects } = this.deps;
    const conversation = sessions.get(conversationId);

    const project = (
      ref?: string,
    ): { project: Project } | { problem: string; candidates: Project[] } => {
      const resolution = projects.resolve(ref ?? userMessage.content, {
        affinityProjectId: conversation?.projectId ?? null,
      });
      if (resolution.status === 'resolved') return { project: resolution.project };
      if (resolution.status === 'ambiguous') {
        return {
          problem:
            `Several projects match: ${resolution.candidates.map((p) => p.name).join(', ')}. ` +
            'Which one do you mean?',
          candidates: resolution.candidates,
        };
      }
      return {
        problem:
          'I could not tell which project you mean. Name it, or say "in <project>" and I will use that.',
        candidates: [] as Project[],
      };
    };

    const job = (ref?: string): { job: Job } | { problem: string } => {
      const linked = jobs.list({ sessionId: conversationId, archived: 'all', limit: 50 });
      if (!ref) {
        // An unqualified "it" means the work still in flight. Two of those and
        // no reference is exactly the case where guessing is worse than asking.
        const open = linked.filter((candidate) =>
          ['running', 'pending', 'paused', 'awaiting_user'].includes(candidate.status),
        );
        if (open.length > 1) {
          return {
            problem: `Several Jobs here are still open: ${open
              .map((candidate) => `"${candidate.goal}"`)
              .join(', ')}. Which one?`,
          };
        }
        const chosen = open[0] ?? linked[0];
        if (!chosen) {
          return { problem: 'This conversation has no Job I can act on. Which Job do you mean?' };
        }
        return { job: chosen };
      }
      const exact = jobs.get(ref);
      if (exact) return { job: exact };
      const needle = ref.toLowerCase();
      const matches = linked.filter(
        (candidate) =>
          candidate.id.endsWith(needle) || candidate.goal.toLowerCase().includes(needle),
      );
      if (matches.length === 1) return { job: matches[0] as Job };
      if (matches.length > 1) {
        return {
          problem: `Several Jobs match "${ref}". Open the Jobs page and pick the exact one.`,
        };
      }
      const tombstone = jobs.tombstone(ref);
      if (tombstone)
        return { problem: `"${tombstone.goal}" was deleted on ${tombstone.deletedAt}.` };
      return { problem: `I could not find a Job matching "${ref}".` };
    };

    switch (action.action) {
      case 'create_job': {
        const found = project(action.project);
        if ('problem' in found) {
          return {
            problem: found.problem,
            ...(found.candidates ? { projectCandidates: found.candidates } : {}),
          };
        }
        // Affinity is remembered only once the Job really exists (see dispatch).
        // Writing it here meant an unattended change to what the conversation is
        // about that survived the human refusing the Job it was resolved for.
        return {
          projectId: found.project.id,
          input: {
            projectId: found.project.id,
            request: action.request,
            acceptance: action.acceptance ?? [],
            autostart: true,
            originMessageId: userMessage.id,
          },
        };
      }
      case 'inspect_job':
      case 'cancel_job':
      case 'resume_job':
      case 'retry_job':
      case 'archive_job':
      case 'delete_job': {
        const found = job(action.job);
        if ('problem' in found) return found;
        const target = found.job as Job;
        return {
          jobId: target.id,
          projectId: target.projectId,
          input:
            action.action === 'archive_job'
              ? { id: target.id, archived: true }
              : action.action === 'retry_job'
                ? { id: target.id, autostart: true }
                : { id: target.id },
        };
      }
      case 'list_projects':
        return { input: { status: 'active' } };
      case 'search':
        return { input: { query: action.query, limit: 8 } };
      case 'inspect_project':
      case 'redetect_project':
      case 'unregister_project': {
        const found = project(action.project);
        if ('problem' in found) {
          return {
            problem: found.problem,
            ...(found.candidates ? { projectCandidates: found.candidates } : {}),
          };
        }
        return { projectId: found.project.id, input: { id: found.project.id } };
      }
      case 'archive_project': {
        const found = project(action.project);
        if ('problem' in found) {
          return {
            problem: found.problem,
            ...(found.candidates ? { projectCandidates: found.candidates } : {}),
          };
        }
        return {
          projectId: found.project.id,
          input: { id: found.project.id, archived: action.archived },
        };
      }
      case 'update_project': {
        const found = project(action.project);
        if ('problem' in found) {
          return {
            problem: found.problem,
            ...(found.candidates ? { projectCandidates: found.candidates } : {}),
          };
        }
        const target = found.project;
        const aliases = new Set(target.aliases);
        if (action.addAlias) aliases.add(action.addAlias);
        if (action.removeAlias) aliases.delete(action.removeAlias);
        return {
          projectId: target.id,
          input: {
            id: target.id,
            ...(action.name !== undefined ? { name: action.name } : {}),
            ...(action.addAlias || action.removeAlias ? { aliases: [...aliases] } : {}),
            ...(action.devUrl !== undefined ? { devUrl: action.devUrl } : {}),
            ...(action.summary !== undefined ? { summary: action.summary } : {}),
          },
        };
      }
      case 'new_conversation':
        return { input: action.title ? { title: action.title } : {} };
      case 'rename_conversation':
        return { input: { id: conversationId, title: action.title } };
      case 'archive_conversation':
        return { input: { id: conversationId, archived: action.archived } };
      case 'delete_conversation': {
        // The model may name any conversation, including one it only saw in a
        // search hit. Resolve it here so the confirmation can always say WHICH
        // transcript is about to be destroyed -- an id the human cannot place is
        // not something they can meaningfully agree to, and this is the one
        // destructive target with no undo.
        const target = action.conversation ?? conversationId;
        const found = this.deps.sessions.get(target);
        if (!found) return { problem: `I could not find a conversation matching "${target}".` };
        // Named here, where every conversation is visible. The browser only
        // holds the filtered sidebar list, so it cannot name an archived or
        // filtered-out conversation -- and this is the one destructive target
        // with no undo.
        return {
          input: { id: found.id },
          targetLabel: `the conversation “${found.title ?? 'untitled'}”${
            found.id === conversationId ? ' — this one' : ''
          }`,
        };
      }
      default: {
        // Exhaustiveness: an action added to the schema without a resolver here
        // must fail closed rather than reach a tool with no arguments.
        const never: never = action;
        return { problem: `unsupported action ${JSON.stringify(never)}` };
      }
    }
  }

  private projectName(projectId: string): string {
    return this.deps.projects.get(projectId)?.name ?? projectId;
  }

  private buildChatPrompt(userText: string, contextPack: string, conversationId: string): string {
    const transcript = this.deps.sessions
      .recentMessages(conversationId, CONTEXT_TURNS)
      .filter((message) => message.content.trim())
      .map((message) => `${message.role === 'user' ? 'User' : 'Jarvis'}: ${message.content}`)
      .join('\n\n');

    const linked = this.deps.jobs
      .list({ sessionId: conversationId, archived: 'all', limit: 5 })
      .map(
        (job) =>
          `- ${job.id} "${job.goal}" on ${this.projectName(job.projectId)} — ${job.stage}` +
          `${job.pauseReason ? ` (${job.pauseReason.split('\n')[0]})` : ''}`,
      )
      .join('\n');

    return `You are Jarvis, a local-first assistant that lives on this machine and also runs the
user's coding jobs. Talk like a knowledgeable colleague: direct, concrete, no filler.
Answer ordinary questions ordinarily — explanations, opinions and brainstorming are
just conversation and must not turn into any Jarvis operation.

${contextPack ? `# Context Jarvis retrieved for you\n\n${contextPack}\n` : ''}
${linked ? `# Jobs linked to this conversation\n${linked}\n` : ''}
${transcript ? `# Conversation so far\n${transcript}\n` : ''}
# The user's latest message
${userText}

${CHAT_ACTION_INSTRUCTIONS}`;
  }
}

/**
 * Turn a read-only action's result into something a person can read.
 *
 * Assembled from the returned rows, never from what the model said: the answer
 * to "what did you find" has to be what was actually found.
 */
function renderObservation(name: ChatActionName, result: unknown): string {
  if (name === 'search') {
    const hits = result as SearchHit[];
    if (!Array.isArray(hits) || hits.length === 0) return 'Nothing matched that.';
    return hits
      .slice(0, 8)
      .map((hit) => `- **${hit.title}** (${hit.type}) — ${hit.subtitle}`)
      .join('\n');
  }
  if (name === 'list_projects') {
    const projects = result as Project[];
    if (!Array.isArray(projects) || projects.length === 0) return 'No projects are registered.';
    return projects.map((project) => `- **${project.name}** — ${project.rootPath}`).join('\n');
  }
  if (name === 'inspect_project') {
    const detail = result as { project?: Project } | Project | null;
    const project = (detail && 'project' in detail ? detail.project : detail) as Project | null;
    if (!project) return '';
    return [
      `**${project.name}** — ${project.rootPath}`,
      project.summary ?? '',
      project.stack?.languages?.length ? `Languages: ${project.stack.languages.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
