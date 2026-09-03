import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ConversationDetail,
  type ConversationSummary,
  type JarvisEvent,
  type Job,
  type Message,
  type Project,
  type ToolExecution,
  type ToolOutcome,
  type ToolExecutionStatus,
} from '../api.ts';
import { Badge, ConfirmDialog, Empty, Markdown, PlainText, StageBadge } from '../components.tsx';
import { useAsync } from '../hooks.ts';

export function ChatView({
  conversationId,
  projects,
  conversations,
  lastEvent,
  onMissing,
  onOpenJob,
}: {
  conversationId: string;
  projects: Project[];
  conversations: ConversationSummary[];
  lastEvent: JarvisEvent | null;
  onMissing: () => void;
  onOpenJob: (id: string) => void;
}) {
  const detail = useAsync<ConversationDetail>(
    () => api.conversation(conversationId),
    [conversationId],
  );
  const [draft, setDraft] = useState(
    () => localStorage.getItem(`jarvis-draft:${conversationId}`) ?? '',
  );
  const [busy, setBusy] = useState(false);
  /** Id of the already-sent user message being rewritten, or null for a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    executionId: string;
    tool: string;
    target?: string;
  } | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (detail.error?.includes('not found')) onMissing();
  }, [detail.error, onMissing]);
  // A delta means "more text arrived", and it arrives per token chunk. Every
  // other event is rare and reloads at once; deltas are coalesced so a long
  // answer costs a few refetches instead of one per chunk.
  const deltaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (deltaTimer.current) clearTimeout(deltaTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (lastEvent?.sessionId !== conversationId && !lastEvent?.jobId) return;
    if (lastEvent?.type !== 'message.delta') {
      if (deltaTimer.current) {
        clearTimeout(deltaTimer.current);
        deltaTimer.current = null;
      }
      detail.reload();
      return;
    }
    if (deltaTimer.current) return;
    deltaTimer.current = setTimeout(() => {
      deltaTimer.current = null;
      detail.reload();
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent, conversationId]);
  useEffect(() => {
    setDraft(localStorage.getItem(`jarvis-draft:${conversationId}`) ?? '');
    setEditingId(null);
    setCopied(null);
    setError(null);
    textarea.current?.focus();
  }, [conversationId]);
  useEffect(() => {
    localStorage.setItem(`jarvis-draft:${conversationId}`, draft);
    const node = textarea.current;
    if (node) {
      node.style.height = '0';
      node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
    }
  }, [conversationId, draft]);
  useEffect(() => {
    if (nearBottom)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [detail.data?.messages.length, detail.data?.responding, nearBottom]);

  const jobs = useMemo(
    () => new Map((detail.data?.jobs ?? []).map((job) => [job.id, job])),
    [detail.data?.jobs],
  );
  const tombstones = useMemo(
    () => new Map((detail.data?.tombstones ?? []).map((job) => [job.id, job])),
    [detail.data?.tombstones],
  );
  const executions = useMemo(
    () =>
      new Map((detail.data?.toolExecutions ?? []).map((execution) => [execution.id, execution])),
    [detail.data?.toolExecutions],
  );
  useEffect(() => {
    if (confirm && executions.get(confirm.executionId)?.status !== 'pending_approval') {
      setConfirm(null);
    }
  }, [confirm, executions]);
  const lastUser = [...(detail.data?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    try {
      // Editing an already-sent message resumes the conversation from it: the
      // server drops that turn and everything after it before answering again.
      if (editingId) await api.editLastMessage(conversationId, text, editingId);
      else await api.sendMessage(conversationId, text);
      setEditingId(null);
      detail.reload();
    } catch (reason) {
      setDraft(text);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  };

  /**
   * Copy one message, and only say "Copied" once it really is.
   *
   * `navigator.clipboard` does not exist outside a secure context, and
   * `writeText` rejects when the document is not focused or the permission is
   * refused — so both failures have to reach the person, who otherwise walks
   * away with an empty clipboard and a label saying it worked.
   */
  const copy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setError(null);
      setCopied(message.id);
      setTimeout(() => setCopied(null), 1500);
    } catch (reason) {
      setCopied(null);
      const why = reason instanceof Error ? reason.message : String(reason);
      setError(`Could not copy to the clipboard (${why}). Select the text and copy it yourself.`);
    }
  };

  /**
   * Answer "which repository?" by picking one, rather than by describing it.
   *
   * This is the deterministic way out of a clarification. A click is the
   * person naming the project themselves, so no classifier is consulted and
   * there is nothing left to interpret: the id is exact, and the request is
   * the text trusted code carried forward from the message that was asked
   * about. Typing an answer still works and still goes through routing.
   */
  const chooseTarget = async (message: Message, projectId: string) => {
    const request = message.metadata.pendingRequest;
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createJob(projectId, request, [], true, {
        sessionId: conversationId,
        originMessageId: message.id,
      });
      detail.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!confirm || !detail.data) return;
    setError(null);
    setBusy(true);
    try {
      // Through the shared helper: approve answers 200 even when the tool
      // refused, so calling the API directly closed the dialog silently.
      await approvePending(
        { status: 'pending_approval', execution: { id: confirm.executionId } } as ToolOutcome,
        detail.data.conversation.projectId,
      );
      setConfirm(null);
      detail.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!detail.data)
    return (
      <div className="chat-loading">
        {detail.error ? (
          <div className="api-error">{detail.error}</div>
        ) : (
          <Empty>Loading conversation…</Empty>
        )}
      </div>
    );
  const { conversation, messages } = detail.data;

  return (
    <section className="chat-workspace" data-testid="chat-view">
      <header className="chat-header">
        <div>
          <h1>{conversation.title ?? 'New conversation'}</h1>
          <span className="tiny dim">
            {conversation.projectId
              ? `Context: ${projects.find((project) => project.id === conversation.projectId)?.name ?? conversation.projectId}`
              : 'No project required — talk normally'}
          </span>
        </div>
        <select
          aria-label="Conversation project context"
          value={conversation.projectId ?? ''}
          onChange={(event) =>
            void api
              .updateConversation(conversationId, { projectId: event.target.value || null })
              .then(detail.reload, (reason: unknown) =>
                setError(reason instanceof Error ? reason.message : String(reason)),
              )
          }
        >
          <option value="">Automatic project context</option>
          {projects
            .filter((project) => !project.archivedAt)
            .map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
        </select>
      </header>

      <div
        className="message-scroll"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          setNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 120);
        }}
      >
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <h2>What are we working through?</h2>
            <p>
              Ask a question, think out loud, or tell Jarvis to create and manage a coding Job in
              natural language.
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const linked = message.metadata.jobIds ?? (message.jobId ? [message.jobId] : []);
            return (
              <article
                key={message.id}
                className={`chat-message ${message.role} ${message.status}${
                  editingId === message.id ? ' being-edited' : ''
                }`}
              >
                <div className="message-label">
                  {message.role === 'assistant' ? 'Jarvis' : message.role}
                </div>
                <div className="message-content">
                  {message.role === 'assistant' ? (
                    <Markdown>
                      {message.content || (message.status === 'pending' ? 'Thinking…' : '')}
                    </Markdown>
                  ) : (
                    <PlainText>{message.content}</PlainText>
                  )}
                  {message.status !== 'complete' && (
                    <Badge
                      tone={
                        message.status === 'failed'
                          ? 'err'
                          : message.status === 'streaming' || message.status === 'pending'
                            ? 'run'
                            : 'warn'
                      }
                    >
                      {message.status === 'pending'
                        ? 'thinking'
                        : message.status === 'streaming'
                          ? 'responding'
                          : message.status}
                    </Badge>
                  )}
                  {linked.map((id) => (
                    <JobCard
                      key={id}
                      job={jobs.get(id)}
                      tombstone={tombstones.get(id)}
                      onOpen={onOpenJob}
                    />
                  ))}
                  {message.metadata.candidates?.length && !linked.length ? (
                    <div className="target-choices" data-testid={`target-choices-${message.id}`}>
                      {message.metadata.candidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          className="btn"
                          data-testid={`target-choice-${candidate.id}`}
                          disabled={busy}
                          onClick={() => void chooseTarget(message, candidate.id)}
                        >
                          {candidate.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {/* `tool` is written only by the paths that stopped at a human
                      decision, and it is what this badge is about. Every
                      tool-backed message now carries an `executionId` — that is
                      how an edit knows what the branch already did — so gating
                      on the id alone would put a "Completed" badge under every
                      ordinary action reply. */}
                  {message.metadata.tool &&
                    message.metadata.executionId &&
                    (() => {
                      const execution = executions.get(message.metadata.executionId as string);
                      const state = confirmationState(execution?.status);
                      return state.interactive ? (
                        <button
                          className="btn danger"
                          data-testid={`review-confirmation-${execution?.id}`}
                          onClick={() => {
                            // Never open an irreversible confirmation under an
                            // unrelated failure from an earlier action.
                            setError(null);
                            setConfirm({
                              executionId: message.metadata.executionId as string,
                              tool: message.metadata.tool ?? 'destructive action',
                              ...(typeof message.metadata.target === 'string'
                                ? { target: message.metadata.target }
                                : {}),
                            });
                          }}
                        >
                          {state.label}
                        </button>
                      ) : (
                        <Badge tone={state.tone}>{state.label}</Badge>
                      );
                    })()}
                  {message.content && (
                    <div className="message-actions">
                      <button
                        className="btn sm"
                        data-testid={`copy-message-${message.id}`}
                        onClick={() => void copy(message)}
                      >
                        {copied === message.id ? 'Copied' : 'Copy'}
                      </button>
                      {message.role === 'user' && (
                        <button
                          className="btn sm"
                          data-testid={`edit-message-${message.id}`}
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            setEditingId(message.id);
                            setDraft(message.content);
                            textarea.current?.focus();
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>

      {!nearBottom && (
        <button
          className="btn sm jump-latest"
          onClick={() => {
            setNearBottom(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          Jump to latest ↓
        </button>
      )}
      <footer className="chat-composer">
        {editingId && (
          <div className="tiny dim" data-testid="editing-banner">
            {editingId === lastUser?.id
              ? 'Editing your latest message'
              : 'Editing an earlier message — everything after it will be replaced'}{' '}
            <button
              className="link-button"
              onClick={() => {
                setEditingId(null);
                setDraft('');
              }}
            >
              Cancel
            </button>
          </div>
        )}
        <textarea
          ref={textarea}
          rows={1}
          aria-label="Message Jarvis"
          placeholder="Message Jarvis…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="spread">
          <div className="row">
            {lastUser && !busy && (
              <button
                className="btn sm"
                onClick={() => {
                  setEditingId(lastUser.id);
                  setDraft(lastUser.content);
                  textarea.current?.focus();
                }}
              >
                Edit last
              </button>
            )}
            {messages.at(-1)?.role === 'assistant' &&
              ['failed', 'stopped', 'interrupted'].includes(messages.at(-1)?.status ?? '') && (
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api
                      .retryResponse(conversationId)
                      .then(detail.reload)
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : String(reason)),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Retry
                </button>
              )}
          </div>
          {busy || detail.data.responding ? (
            <button className="btn danger" onClick={() => void api.stopResponse(conversationId)}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!draft.trim()} onClick={() => void submit()}>
              Send
            </button>
          )}
        </div>
        <div className="composer-hint">
          Enter to send · Shift+Enter for a new line · drafts stay in this browser
        </div>
        {error && (
          <div className="api-error" role="alert">
            {error}
          </div>
        )}
      </footer>
      {/* Mounted only while something is actually pending: two confirm dialogs
          in the DOM at once would make `[data-testid=confirm-dialog]` ambiguous
          for both assistive tech and the Visual QA scenario. */}
      {confirm && (
        <ConfirmDialog
          open
          title={`Confirm ${confirm.tool}?`}
          description="Jarvis requested this operation, but only your authenticated confirmation can run it."
          // The model chooses the target, and it is not required to be anything
          // this conversation mentioned. Showing the tool name alone asked for a
          // signature on an unnamed object, so the pending execution's own
          // recorded input is what the human reads before confirming.
          removes={describePendingTarget(
            executions.get(confirm.executionId),
            projects,
            jobs,
            conversations,
            confirm.target,
          )}
          preserves={[
            'unrelated conversations, projects, repositories, and immutable audit evidence',
          ]}
          confirmLabel="Confirm and run"
          busy={busy}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void approve()}
        />
      )}
    </section>
  );
}

/**
 * What the pending execution will actually act on, in the human's words.
 *
 * The recorded `input` is the authority: it is the exact canonical object the
 * approval is bound to, so a confirmation that renders anything else would be
 * describing a different request than the one about to run. Ids are resolved to
 * names where this view already knows them, and the canonical input is always
 * shown too, so nothing about the target is hidden behind a friendly label.
 */
export function describePendingTarget(
  execution: ToolExecution | undefined,
  projects: Project[],
  jobs: Map<string, Job>,
  conversations: ConversationSummary[] = [],
  /** Server-resolved name for the target, which the browser may not be able to see. */
  serverLabel?: string,
): string[] {
  if (!execution) return ['the exact target described in the pending request'];
  const input = (execution.input ?? {}) as Record<string, unknown>;
  const id = typeof input.id === 'string' ? input.id : null;
  const named: string[] = [];
  // A Job names its target as `projectId`, and which repository is about to be
  // worked on is the single most important thing on this dialog: the model
  // chose it, and its prose is not evidence of what it chose.
  if (typeof input.projectId === 'string') {
    const project = projects.find((entry) => entry.id === input.projectId);
    named.push(
      project
        ? 'the project “' +
            project.name +
            '” (' +
            project.rootPath +
            ')' +
            (project.isSelf ? ' — Jarvis itself' : '')
        : String(input.projectId),
    );
  }
  if (id) {
    const project = projects.find((entry) => entry.id === id);
    const job = jobs.get(id);
    if (project) named.push(`the project “${project.name}” (${project.rootPath})`);
    else if (job) named.push(`the Job “${job.goal}”`);
    else if (id.startsWith('ses_')) {
      // A transcript is the one destructive target with no undo, so it has to be
      // named. The server's label wins: the sidebar list here is filtered by
      // status and search, so it cannot name an archived or filtered-out
      // conversation the model was free to choose.
      const conversation = conversations.find((entry) => entry.id === id);
      named.push(
        serverLabel ??
          `the conversation “${conversation?.title ?? 'untitled'}”` +
            (execution.sessionId === id ? ' — this one' : ''),
      );
    } else named.push(id);
  }
  named.push(`request: ${JSON.stringify(input)}`);
  return named;
}

export function confirmationState(status?: ToolExecutionStatus): {
  interactive: boolean;
  label: string;
  tone?: 'ok' | 'warn' | 'err' | 'run';
} {
  switch (status) {
    case 'pending_approval':
      return { interactive: true, label: 'Review confirmation', tone: 'warn' };
    case 'succeeded':
      return { interactive: false, label: 'Completed', tone: 'ok' };
    case 'denied':
      return { interactive: false, label: 'Denied', tone: 'err' };
    case 'expired':
      return { interactive: false, label: 'Expired' };
    case 'running':
      return { interactive: false, label: 'Approved', tone: 'run' };
    case 'failed':
      return { interactive: false, label: 'Failed', tone: 'err' };
    case 'interrupted':
      return { interactive: false, label: 'Interrupted', tone: 'warn' };
    case 'timed_out':
      return { interactive: false, label: 'Timed out', tone: 'warn' };
    default:
      return { interactive: false, label: 'Unavailable' };
  }
}

function JobCard({
  job,
  tombstone,
  onOpen,
}: {
  job?: Job;
  tombstone?: { goal: string; deletedAt: string };
  onOpen: (id: string) => void;
}) {
  if (!job)
    return (
      <div className="job-card deleted">
        <div>
          <strong>{tombstone?.goal ?? 'Deleted Job'}</strong>
          <div className="tiny dim">
            Deleted {tombstone ? new Date(tombstone.deletedAt).toLocaleString() : ''}
          </div>
        </div>
        <Badge>tombstone</Badge>
      </div>
    );
  const cycles = job.fixCycles + job.reviewFixCycles + job.visualFixCycles;
  return (
    <button className="job-card" onClick={() => onOpen(job.id)}>
      <div>
        <strong>{job.goal}</strong>
        <div className="tiny dim">
          {job.pauseReason?.split('\n')[0] ??
            job.error?.split('\n')[0] ??
            `${cycles ? `${cycles} repair cycle${cycles === 1 ? '' : 's'} · ` : ''}${job.id.slice(-8)}`}
        </div>
      </div>
      <StageBadge stage={job.stage} />
    </button>
  );
}

/**
 * Run a pending confirmation to its real conclusion, and fail loudly.
 *
 * The approve route answers 200 even when the tool refused -- a refusal is a
 * successful policy evaluation -- so every caller that only awaited this closed
 * its dialog and reported nothing when the action had actually failed. Throwing
 * puts the outcome back in front of the person who asked for it.
 */
export async function approvePending(
  outcome: ToolOutcome,
  projectId: string | null = null,
): Promise<ToolOutcome> {
  const settled =
    outcome.status === 'pending_approval'
      ? await api.approveTool(outcome.execution.id, false, projectId)
      : outcome;
  if (settled.status !== 'succeeded') {
    const detail = 'error' in settled && settled.error ? ': ' + settled.error : '';
    throw new Error(settled.execution.toolName + ' did not run (' + settled.status + ')' + detail);
  }
  return settled;
}
