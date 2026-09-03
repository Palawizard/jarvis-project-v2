import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';
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
import { renderProjectRegistry, type Project, type ProjectService } from '../projects/service.js';
import type { Job, JobService } from '../jobs/service.js';
import { renderProjectSnapshot } from '../jobs/pipeline.js';
import type { Message, SessionService } from '../sessions/service.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SearchHit } from '../tools/builtin.js';
import { isToolFreeViolation } from '../agents/toolfree.js';
import { SemanticRouter, type RoutedTurn, type RoutingAudit } from './router.js';
import {
  ACTION_TOOLS,
  CHAT_ACTION_INSTRUCTIONS,
  extractChatAction,
  type ChatAction,
  type ChatActionName,
} from './actions.js';

const log = createLogger('chat');

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
 * Execution statuses that mean the tool never ran.
 *
 * A branch carrying only these can be rewound: there is no effect in Jarvis for
 * the deleted transcript to become inconsistent with. Every other status —
 * including `failed`, `timed_out` and `interrupted`, where the effect is
 * unknown — has to be assumed to have happened.
 */
const NEVER_EXECUTED: string[] = ['pending_approval', 'denied', 'expired'];

/**
 * The conversational front door.
 *
 * Everything the user types arrives here, and exactly one of five things
 * happens: a deterministic memory operation with no model call; a Job, when two
 * independent tool-free classifiers agree the message names a registered
 * repository to change; a question back, when they do not; a structured action
 * requested by the conversational model and decided by trusted code, possibly
 * stopping at a human confirmation; or an ordinary answer.
 *
 * A normal message never creates a Job.
 */
/** Upper bound on how often a partial streamed answer is written to the row. */
const STREAM_PERSIST_MS = 250;

export class ChatService {
  /** One in-flight response per conversation, so Stop has something to abort. */
  private readonly running = new Map<string, AbortController>();

  /**
   * Turns that have reached the point of no return.
   *
   * The entry stays in `running` — a second send must still be refused — but
   * `stop()` reports honestly that there is nothing left to prevent. The window
   * is `job.create` itself: the permission evaluation, the row, and
   * `pipeline.start`, none of which take an abort signal.
   */
  private readonly committed = new Set<string>();

  /** Created once per process, outside the Jarvis home. See `scratchDir`. */
  private scratch: string | undefined;

  /**
   * An empty, private, throwaway directory for general conversation.
   *
   * Deliberately NOT under `config.home`. It used to be `<home>/chat-scratch`,
   * which put `jarvis.db` — every project's memory and the hashed control
   * credential — one `..` away. That only mattered in the exact scenario this
   * whole tool-free defence exists for: a provider release where `--tools ''`
   * stops disabling tools. `mkdtemp` gives a unique 0700 directory nothing else
   * can have pre-created, so the confinement does not rest on a relative path
   * being awkward to guess.
   */
  private scratchDir(): string {
    if (this.scratch && fs.existsSync(this.scratch)) return this.scratch;
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-scratch-'));
    fs.chmodSync(this.scratch, 0o700);
    return this.scratch;
  }

  /** Semantic interpretation. Tool-free, bounded, and never an authority. */
  private readonly router: SemanticRouter;

  constructor(private readonly deps: ChatDeps) {
    this.router = new SemanticRouter({ config: deps.config, agents: deps.agents });
  }

  isResponding(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  /**
   * Stop the in-flight turn, if there still is one that can be stopped.
   *
   * Returns false — honestly — from the moment a turn starts committing a side
   * effect it cannot take back, not merely once it has finished committing one.
   * So this can prevent a Job from being created and can never claim to have
   * cancelled one that already exists, nor one that is halfway into existing.
   * Cancelling the work itself is `job.cancel`, a separate capability.
   */
  stop(conversationId: string): boolean {
    const controller = this.running.get(conversationId);
    if (!controller || this.committed.has(conversationId)) return false;
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

    return this.handleTurn(conversation.id, userMessage);
  }

  /**
   * Route the turn, then answer it if routing did not settle it.
   *
   * Stage B: what KIND of thing is this? Decided by a dedicated tool-free
   * classifier before the conversational model sees anything, because leaving
   * it to the conversational model is what produced the regression this exists
   * to prevent: asked to "code sur le projet Jarvis", the provider explored its
   * own empty scratch directory and asked the human where the Jarvis repository
   * was, and no Job was ever created.
   *
   * The classifier interprets; it decides nothing. Trusted code validates what
   * comes back, resolves the project itself, and is the only thing that can
   * reach a tool — and before an unattended agent starts, a second independent
   * classifier has to agree. See `router.ts`.
   *
   * The placeholder is created HERE, before routing, and handed to whichever
   * path settles the turn. Routing takes two provider runs, so creating it
   * afterwards meant the longest part of a turn ran with no assistant row at
   * all: the user watched nothing happen, and a crash in that window left a
   * turn `retry()` refused, because there was no failed message to retry.
   *
   * One controller for the whole turn, for the same reason: two
   * near-simultaneous sends (a double click, a retried fetch, two tabs) must not
   * both get past the in-flight check and open two worktrees for one
   * instruction, and a gap between routing and answering is a place for the
   * second one to slip through.
   */
  private async handleTurn(conversationId: string, userMessage: Message): Promise<ChatTurn> {
    const { sessions } = this.deps;
    // A turn that already created a Job is finished, whatever the transcript
    // looks like. `retry()` accepts an interrupted message, and crash recovery
    // marks one interrupted the moment the process comes back — so a crash in
    // the window between `job.create` and settling the assistant row used to
    // present a Retry button that routed the same sentence again and opened a
    // second worktree. Answering from the Job that exists costs no provider
    // call and cannot produce a second one.
    const existing = this.deps.jobs.byOriginMessage(userMessage.id);
    if (existing) return this.restoreJobTurn(conversationId, userMessage, existing);
    const placeholder = sessions.addMessage(conversationId, 'assistant', '', {
      status: 'pending',
    });
    const controller = new AbortController();
    this.running.set(conversationId, controller);
    try {
      const routed = await this.routeSemantically(
        conversationId,
        userMessage,
        placeholder.id,
        controller,
      );
      if (routed) return routed;
      return await this.respond(conversationId, userMessage, placeholder.id, controller);
    } catch (error) {
      // The placeholder exists from the first line, so anything that throws on
      // the way would otherwise leave a "thinking" bubble in the transcript
      // forever: retry() only accepts a failed, stopped or interrupted message,
      // so nothing short of a restart could clear it.
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      if (sessions.getMessage(placeholder.id)?.status === 'pending') {
        sessions.updateMessage(placeholder.id, {
          content: reason,
          status: 'failed',
          metadata: { error: reason },
        });
      }
      throw error;
    } finally {
      this.running.delete(conversationId);
      this.committed.delete(conversationId);
    }
  }

  /**
   * Settle a turn from the Job it already created, without routing again.
   *
   * Idempotency is enforced underneath this as well — `JobService.create`
   * returns the existing row for an origin message, and a unique index makes a
   * duplicate impossible even under a concurrent write — so this is the
   * behaviour, not the guarantee. What it adds is that the conversation ends up
   * pointing at that Job instead of quietly starting a second one, and that a
   * recovered turn spends nothing to get there.
   */
  private restoreJobTurn(conversationId: string, userMessage: Message, job: Job): ChatTurn {
    const { sessions } = this.deps;
    const reply = `Started **${job.goal}** on ${this.projectName(job.projectId)}.`;
    const message = sessions.addMessage(conversationId, 'assistant', reply, {
      status: 'complete',
      jobId: job.id,
      metadata: { activity: 'action', jobIds: [job.id] },
    });
    this.deps.bus.emit({
      type: 'job.linked',
      jobId: job.id,
      sessionId: conversationId,
      payload: { goal: job.goal, projectId: job.projectId },
    });
    log.info('restored an existing Job for a retried turn', {
      jobId: job.id,
      messageId: userMessage.id,
    });
    return {
      conversationId,
      kind: 'action',
      reply,
      userMessage,
      assistantMessage: message,
      job,
    };
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
    // Through the full turn, routing included. Retry used to answer directly,
    // which was harmless when routing did not exist and is not now: routing is
    // the only path to a Job, so retrying "fix the login bug in Jarvis" after a
    // provider outage would have quietly downgraded it to a chat answer, and
    // nothing would have said why the work never started.
    return this.handleTurn(conversationId, userMessage);
  }

  /**
   * Replace a user message and answer the new one, dropping everything after it.
   *
   * With no `messageId` this is "edit last". With one, the conversation resumes
   * from that message: the edited turn and every message that followed it are
   * removed, so the transcript never shows an answer to a question that is no
   * longer there.
   *
   * Rewinding is only honest while the branch being deleted left nothing behind
   * it. Every guard below is one way it could have.
   */
  async editLastUserMessage(
    conversationId: string,
    text: string,
    messageId?: string,
  ): Promise<ChatTurn> {
    const { sessions } = this.deps;
    // Refuse before deleting anything. This used to delete the tail and then
    // call send(), which throws while a response is streaming -- losing both the
    // old turn and the new text.
    if (this.running.has(conversationId)) {
      throw new Error('this conversation is already producing a response');
    }
    const target = messageId
      ? sessions.getMessage(messageId)
      : sessions.lastUserMessage(conversationId);
    // The conversation check is the authority: a message id names a row in the
    // whole database, so without it the route would rewind someone else's
    // transcript from this one.
    if (!target || target.role !== 'user' || target.sessionId !== conversationId) {
      throw new Error('there is no user message to edit');
    }
    // Positional, not timestamp-based: two rows written in the same millisecond
    // are ordered by rowid, and `createdAt >= target` would have taken an
    // earlier sibling with it.
    const recent = sessions.messages(conversationId, 500);
    const from = recent.findIndex((message) => message.id === target.id);
    if (from < 0) throw new Error('that message is too far back in the transcript to edit');
    const doomed = recent.slice(from);
    const executions = [
      ...new Set(
        doomed
          .map((message) => message.metadata.executionId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ]
      .map((id) => this.deps.tools.getExecution(id))
      .filter((execution) => execution !== null);

    if (executions.some((execution) => execution.status === 'running')) {
      throw new Error('that message has a running action; wait for it to finish before editing');
    }
    // A turn that started work cannot be edited away. `committed` is cleared
    // when the turn ends, so by the time the Job is running this conversation
    // looks idle — and the edit deletes the assistant row carrying the Job's
    // card, leaving an agent writing in a worktree that the transcript no
    // longer mentions, while the re-sent message starts a second one. Rewriting
    // the request is not how you stop work: `job.cancel` is.
    if (doomed.some((message) => this.deps.jobs.byOriginMessage(message.id))) {
      throw new Error('that message already started a Job; cancel the Job instead of editing it');
    }
    // An execution that only READ can be edited through: deleting the messages
    // around it leaves nothing in Jarvis that the transcript now contradicts.
    // Anything above `observe` changed durable state this rewind cannot undo,
    // and it does NOT have to have been confirmed to have done so — a
    // `safe_action` like `conversation.create` is auto-approved and succeeds
    // inside the turn. Deleting its branch would leave the effect in Jarvis
    // with nothing left to explain where it came from.
    if (
      executions.some(
        (execution) => execution.risk !== 'observe' && !NEVER_EXECUTED.includes(execution.status),
      )
    ) {
      throw new Error('that branch may already have changed state; undo the action before editing');
    }
    // Memory commands never reach the tool boundary — they are handled
    // deterministically in `send` — so they have no execution row to inspect.
    if (
      doomed.some(
        (message) => message.role === 'user' && detectExplicitCommand(message.content) !== null,
      )
    ) {
      throw new Error('that branch changed memory; undo the memory change before editing');
    }
    // Nothing here ran, so nothing may run later either: an approval dialog for
    // a request whose message is about to disappear has no context left.
    for (const execution of executions) {
      if (execution.status === 'pending_approval') {
        this.deps.tools.deny(execution.id, 'superseded by an edited message');
      }
    }
    for (const message of doomed) sessions.deleteMessage(message.id);
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

  // ----------------------------------------------------- semantic routing --

  /**
   * Route one message semantically, and act only on what trusted code can prove.
   *
   * Returns null for "not my business" — the turn is an ordinary conversation,
   * including every project-management request, which reaches the domain the
   * way it always has: as a structured `jarvis-action` the responder emits and
   * the permission boundary decides.
   *
   * What a classifier contributes is exactly one thing: a project id, chosen
   * from a list this turn handed it and re-resolved here. The instruction the
   * coding agent executes is the human's own message, carried by trusted code —
   * see `pendingRequest`. Nothing a model wrote becomes a path, a command, an
   * instruction or an authority.
   */
  private async routeSemantically(
    conversationId: string,
    userMessage: Message,
    placeholderId: string,
    controller: AbortController,
  ): Promise<ChatTurn | null> {
    const { sessions, projects } = this.deps;
    const conversation = sessions.get(conversationId);
    const active = projects.list({ status: 'active' });
    // Nothing registered means nothing a code change could target, so there is
    // no decision here worth a provider call.
    if (active.length === 0) return null;

    const affinity = conversation?.projectId ? projects.get(conversation.projectId) : null;
    const history = sessions.messages(conversationId, CONTEXT_TURNS);
    const asked = priorTargetQuestion(history, [userMessage.id, placeholderId]);
    const awaiting = asked?.projectId ? projects.get(asked.projectId) : null;

    const decision: RoutedTurn = await this.router.route({
      text: userMessage.content,
      projects: active,
      affinity: affinity && !affinity.archivedAt ? affinity : null,
      // USER messages only, and never an assistant turn.
      //
      // This used to replay both roles, minus a growing list of exclusions —
      // first Jarvis's own target questions, then clarification activity — and
      // each round of review found another route by which text nobody trusted
      // arrived anyway. An assistant turn carries whatever the conversational
      // model wrote, and `renderObservation` copies `project.summary` into one,
      // so a registered repository's README could reach a classifier two hops
      // later. Dropping the role entirely closes every one of those at once and
      // leaves nothing to keep extending. Anaphora still resolves: "implémente
      // ça" refers to what the USER asked for, and the repository comes from
      // trusted affinity, not from what Jarvis said back.
      recentUserMessages: history
        .filter(
          (message) =>
            message.id !== userMessage.id && message.role === 'user' && message.content.trim(),
        )
        .slice(-2)
        .map((message) => message.content),
      priorConfirmation: awaiting && !awaiting.archivedAt ? awaiting : null,
      priorAsked: Boolean(asked),
      // Never a worktree, and never the Jarvis home: routing reads nothing.
      cwd: this.scratchDir(),
      signal: controller.signal,
    });
    log.info('semantic routing', decision.audit);

    // A stop that landed while the classifiers were running ends the turn here.
    // Falling through to `respond()` instead would answer at length a question
    // the human had already told Jarvis to drop.
    const stopped = (): ChatTurn => {
      const reply = 'Stopped before starting any work.';
      sessions.updateMessage(placeholderId, {
        content: reply,
        status: 'stopped',
        metadata: { error: 'stopped by you', routing: decision.audit },
      });
      return {
        conversationId,
        kind: 'chat',
        reply,
        userMessage,
        assistantMessage: sessions.getMessage(placeholderId),
      };
    };
    if (controller.signal.aborted) return stopped();

    if (decision.outcome.kind === 'conversation') {
      // The responder settles this turn and owns the placeholder from here. The
      // audit still has to survive: "routing could not be reached, so this
      // became an ordinary answer" is exactly the case where a person asks why
      // their Job never started, and it is the one branch that used to record
      // nothing at all.
      if (decision.audit.rejected) {
        sessions.updateMessage(placeholderId, { metadata: { routing: decision.audit } });
      }
      return null;
    }

    if (decision.outcome.kind === 'clarification') {
      const reply = decision.outcome.question;
      // The user's own words are carried forward here, in trusted code, so the
      // next turn can start the Job on what they actually asked for. Asking a
      // model to remember it across turns loses it: the recent-turn window is
      // truncated, and after two rounds of questions the original message has
      // fallen out of it entirely.
      sessions.updateMessage(placeholderId, {
        content: reply,
        status: 'complete',
        metadata: {
          activity: 'clarification',
          routing: decision.audit,
          pendingRequest: pendingRequest(history, userMessage, placeholderId),
          candidates: decision.outcome.candidates.map((project) => ({
            id: project.id,
            name: project.name,
          })),
        },
      });
      return {
        conversationId,
        kind: 'clarification',
        reply,
        userMessage,
        assistantMessage: sessions.getMessage(placeholderId),
        ...(decision.outcome.candidates.length
          ? { projectCandidates: decision.outcome.candidates }
          : {}),
      };
    }

    // Checked once more against the async gap above, because this is the last
    // moment before a side effect: `stop()` must never report success for an
    // operation that went on to start an agent anyway. From here `stop()`
    // answers false — the Job is being created, and that cannot be taken back.
    if (controller.signal.aborted) return stopped();
    this.committed.add(conversationId);

    // The project is passed by id so `resolveActionInput` resolves the exact row
    // the classifiers agreed on rather than re-reading the sentence. The request
    // is the human's own words, assembled by trusted code from this message and
    // any question it is answering — never a model's restatement of them.
    return await this.dispatch(
      conversationId,
      userMessage,
      placeholderId,
      '',
      {
        action: 'create_job',
        project: decision.outcome.project.id,
        request: pendingRequest(history, userMessage, placeholderId),
        acceptance: [],
      },
      // Runs as the human, and this is the ONLY path that does.
      //
      // The agent actor exists because a model-emitted `create_job` is the
      // conversational model's INFERENCE about what the human wanted — its own
      // words, its own idea of the task — so it stops at a confirmation. What
      // reaches the tool here contains no model output at all: the request is
      // the person's message verbatim, and the project is a row trusted code
      // resolved from an id it had itself offered. A model chose between
      // candidates; it did not write anything that gets executed. That is the
      // same authority as the "Start Job" button on the project page, which
      // creates a Job with no confirmation at all — and this path is the
      // stricter of the two, because it still goes through the permission
      // boundary and still leaves a tool-execution audit row, which
      // `POST /api/jobs` does not.
      'user',
      decision.audit,
    );
  }

  // --------------------------------------------------------------- chat path --

  private async respond(
    conversationId: string,
    userMessage: Message,
    placeholderId: string,
    controller: AbortController,
  ): Promise<ChatTurn> {
    const { sessions, agents, context, projects, config } = this.deps;
    const conversation = sessions.get(conversationId);
    if (!conversation) throw new Error('conversation not found');
    const placeholder = { id: placeholderId };

    {
      // Per-turn project resolution, before the provider is asked anything.
      //
      // This is NOT conversation affinity and it never writes
      // `conversation.projectId`: it only decides which registered project's
      // bounded metadata is worth injecting for THIS message, so "quelle stack
      // utilise Jarvis ?" is answered from the registry instead of sending the
      // model looking for a repository it cannot reach. Being wrong here costs
      // an unused paragraph of context, which is why `selfMention: 'any'` is
      // safe here and deliberately not used for anything that executes.
      const affinity = conversation.projectId ? projects.get(conversation.projectId) : null;
      const perTurn = projects.resolve(userMessage.content, {
        affinityProjectId: conversation.projectId,
        // Relaxed ONLY in a conversation that is not already about a project.
        // `mentioned` outranks affinity inside `resolve`, so relaxing it always
        // would mean that merely addressing the assistant by name ("Jarvis,
        // what did we decide about auth?") retargets the turn's memory scope at
        // the Jarvis project and drops the conversation's own project memory —
        // which is the "unrelated project memory must never enter context"
        // invariant, not a spare paragraph.
        selfMention: conversation.projectId ? 'reference' : 'any',
      });
      const project = perTurn.status === 'resolved' ? perTurn.project : affinity;
      const stale = project ? (await projects.profileStaleness(project)).stale : false;
      const pack = await context.build({
        role: 'chat',
        query: userMessage.content,
        projectId: project?.id ?? conversation.projectId,
        sessionId: conversationId,
        projectSnapshot: project ? renderProjectSnapshot(project, { stale }) : null,
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
        //
        // The one exception is a tool-free protocol violation. There the prose
        // is the provider narrating its own forbidden behaviour — "the current
        // working folder is empty, where is the Jarvis repository?" — and
        // showing it is most of the user-visible half of the bug this exists to
        // prevent. Nothing from that run is kept.
        const violated = isToolFreeViolation(result.error);
        sessions.updateMessage(placeholder.id, {
          content: violated ? reply : streamed || reply,
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
    /**
     * Who is asking. `agent` — the default, and everything the model can reach —
     * cannot touch a sensitive or destructive tool, so those become
     * confirmations. `user` is passed only by `routeSemantically`, whose tool
     * input carries no model-authored text: the request is the person's own
     * message and the project is a row resolved from an id trusted code offered.
     */
    actor: 'agent' | 'user' = 'agent',
    /** Why this turn is doing this, when a semantic route decided it. */
    routing?: RoutingAudit,
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
        metadata: { activity: action.action, ...(routing ? { routing } : {}), ...metadata },
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
      actor,
      sessionId: conversationId,
      projectId: resolved.projectId ?? null,
      ...(resolved.jobId ? { jobId: resolved.jobId } : {}),
    });

    /**
     * Settle a turn that reached the tool boundary, linked to what it ran.
     *
     * Every assistant row produced by an execution carries that execution's id,
     * whatever the outcome — not only the ones that stopped at a confirmation.
     * That link is what lets an edit ask whether the branch it is about to
     * delete already changed something: without it, an auto-approved
     * state-changing action (`conversation.create` is `safe_action`, so it needs
     * no approval and succeeds inside the turn) left an effect in Jarvis that
     * nothing in the transcript pointed at, and the rewind looked safe.
     *
     * `ran` rather than `outcome`, because an agent request refused at the risk
     * ceiling is re-issued as the user and it is the SECOND execution that
     * carries the decision and any effect.
     */
    let ran = outcome;
    const settleRan = (
      reply: string,
      kind: ChatTurnKind,
      extra: Partial<ChatTurn> = {},
      metadata: Record<string, unknown> = {},
    ): ChatTurn => settle(reply, kind, extra, { executionId: ran.execution.id, ...metadata });

    if (outcome.status === 'denied' && outcome.execution.reasonCode === 'actor_risk_ceiling') {
      const asUser = await tools.escalateAgentRequest(outcome.execution.id, resolved.input);
      ran = asUser;
      if (asUser.status === 'pending_approval') {
        const reply = [
          prose,
          `This needs your confirmation: **${toolName}**. I cannot confirm it myself.`,
        ]
          .filter(Boolean)
          .join('\n\n');
        return settleRan(
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
            tool: toolName,
            ...(resolved.targetLabel ? { target: resolved.targetLabel } : {}),
          },
        );
      }
      return this.settleToolOutcome(settleRan, prose, action.action, toolName, asUser);
    }

    if (outcome.status === 'pending_approval') {
      const reply = [prose, `This needs your confirmation: **${toolName}**.`]
        .filter(Boolean)
        .join('\n\n');
      return settleRan(
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
          tool: toolName,
          ...(resolved.targetLabel ? { target: resolved.targetLabel } : {}),
        },
      );
    }

    if (outcome.status === 'succeeded' && action.action === 'create_job') {
      const job = outcome.result as Job;
      // The Job exists and, with autostart, an agent is already running in a
      // worktree. Stop is a chat control: it can prevent a turn's side effect,
      // and it cannot undo one. So the turn stops advertising itself as
      // cancellable the moment the side effect commits — `stop()` now returns
      // false, and `isResponding()` false, so the composer shows Send rather
      // than Stop. Cancelling the work itself is `job.cancel`, a different
      // capability with its own authority, and turning Stop into an implicit
      // one would be exactly the conflation this avoids.
      this.running.delete(conversationId);
      // Conversation state is linked inside `job.create` itself, so a Job the
      // human confirms later lands in the same place as one created here.
      //
      // There used to be a fallback here that patched `originMessageId` when
      // the Job came back without one. It never did anything: `patch` does not
      // write that column, so the call was a no-op that read like a guarantee.
      // The real one is upstream — `resolveActionInput` puts the message id in
      // the tool input, and `JobService.create` is idempotent in it — and a
      // unique index makes a second Job for one message impossible regardless.
      this.deps.bus.emit({
        type: 'job.linked',
        jobId: job.id,
        sessionId: conversationId,
        payload: { goal: job.goal, projectId: job.projectId },
      });
      const reply = prose || `Started **${job.goal}** on ${this.projectName(job.projectId)}.`;
      return settleRan(
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
      return settleRan(
        reply,
        'action',
        {
          job: jobs.get(resolved.jobId),
          action: { name: action.action, status: 'executed' },
        },
        { jobIds: [resolved.jobId] },
      );
    }

    return this.settleToolOutcome(settleRan, prose, action.action, toolName, outcome);
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
    // Every conversation gets the registry, whether or not a project was
    // resolved for this turn: the model should never have to ask where a
    // registered repository lives, and it cannot know what it is not told.
    const registry = renderProjectRegistry(this.deps.projects.list({ status: 'active' }));
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

${registry ? `# Registered Jarvis projects\nThese are the repositories Jarvis manages, with their real paths. Never ask the\nuser where one of them is, and never try to read one yourself: you have no\nfilesystem access at all, and a coding Job is what touches a repository.\n${registry}\n` : ''}
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
/**
 * What Jarvis asked last turn, if it asked which repository to change.
 *
 * Returns ids only. The QUESTION was phrased by a model — it has to be, so it
 * can be asked in the user's language — and feeding that phrasing back into the
 * next turn's prompt would put model-authored text into the trusted preamble of
 * both classifiers, wearing Jarvis's voice and framed as the thing that settles
 * the repository. That is a channel by which a planted sentence steers both
 * "independent" checks identically, so nothing here returns any text.
 */
function priorTargetQuestion(
  history: Message[],
  ignore: string[],
): { projectId: string | null; request: string | null } | null {
  const before = history.filter((message) => !ignore.includes(message.id));
  const last = before.at(-1);
  if (!last || last.role !== 'assistant' || last.metadata.activity !== 'clarification') return null;
  const routing = last.metadata.routing as RoutingAudit | undefined;
  if (routing?.source !== 'semantic_router') return null;
  const request = last.metadata.pendingRequest;
  return {
    projectId: routing.awaitingProjectId ?? null,
    request: typeof request === 'string' && request.trim() ? request : null,
  };
}

/**
 * The instruction a Job should carry: the human's own words, and only those.
 *
 * When this message answers a question Jarvis asked, the request it is
 * answering is prepended — both halves are things the person typed, so nothing
 * is invented and nothing is dropped. The alternative, asking a model to
 * restate the request, put model-authored text in front of an unattended
 * write-capable agent and lost the original outright once the message fell out
 * of the recent-turn window.
 */
function pendingRequest(history: Message[], userMessage: Message, placeholderId: string): string {
  const pending = priorTargetQuestion(history, [userMessage.id, placeholderId])?.request;
  const text = pending ? `${pending}\n\n${userMessage.content}` : userMessage.content;
  return text.slice(0, 4000);
}

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
