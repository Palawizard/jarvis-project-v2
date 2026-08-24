import { useEffect, useRef, useState } from 'react';
import { api, type JarvisEvent, type Memory, type Project, type Session } from '../api.ts';
import { useAsync } from '../hooks.ts';
import { Card, Badge, Empty } from '../components.tsx';

/**
 * Home / Command view.
 *
 * Explicit memory commands ("remember …", "forget …", "retiens que …") are
 * handled by the orchestrator without any model call; anything else becomes a
 * development job. The hint below tells the user that, because the difference
 * is worth being explicit about.
 */
export function CommandView({
  session,
  projects,
  projectId,
  onSelectProject,
  onOpenJob,
  lastEvent,
}: {
  session: Session | null;
  projects: Project[];
  projectId: string | null;
  onSelectProject: (id: string | null) => void;
  onOpenJob: (id: string) => void;
  lastEvent: JarvisEvent | null;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetCandidates, setForgetCandidates] = useState<Memory[]>([]);
  const conversation = useAsync(() => api.session(), []);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastEvent?.type === 'session.updated' || lastEvent?.type.startsWith('job.'))
      conversation.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation.data?.messages.length]);

  const submit = async () => {
    const value = text.trim();
    if (!value || !session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.command(value, session.id, projectId);
      setText('');
      setForgetCandidates(result.candidates ?? []);
      conversation.reload();
      if (result.job) onOpenJob(result.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const state = conversation.data?.session.state;
  const messages = conversation.data?.messages ?? [];

  return (
    <div className="page" data-testid="command-view">
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <Card title="Conversation">
            {messages.length === 0 ? (
              <Empty>Ask Jarvis to build something, or tell it something worth remembering.</Empty>
            ) : (
              <div className="chat">
                {messages.map((m) => (
                  <div key={m.id} className={`msg ${m.role}`}>
                    <div className="msg-role">{m.role}</div>
                    <div className="msg-body">{m.content}</div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}

            <div className="composer">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
                }}
                placeholder={
                  projectId
                    ? 'Describe a change to make, or say "remember that ..."'
                    : 'Say "remember that ..." — or pick a project to start a coding job'
                }
                aria-label="Command input"
              />
              <div className="spread">
                <span className="composer-hint">
                  ⌘/Ctrl + Enter to send. "remember/forget/update" is handled locally — no agent
                  quota spent.
                </span>
                <button
                  className="btn primary"
                  onClick={() => void submit()}
                  disabled={busy || !text.trim()}
                >
                  {busy ? 'Working…' : 'Send'}
                </button>
              </div>
              {error && (
                <div className="small" style={{ color: 'var(--err)' }}>
                  {error}
                </div>
              )}
              {forgetCandidates.length > 0 && (
                <div className="grid" style={{ gap: 6, marginTop: 10 }}>
                  {forgetCandidates.map((memory) => (
                    <div key={memory.id} className="spread mem-item">
                      <span className="small">{memory.content}</span>
                      <button
                        className="btn sm danger"
                        onClick={() =>
                          void api.deleteMemory(memory.id).then(() => {
                            setForgetCandidates((items) =>
                              items.filter((item) => item.id !== memory.id),
                            );
                            conversation.reload();
                          })
                        }
                      >
                        Forget this one
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div>
          <Card title="Session working memory">
            {!state ||
            (!state.goal && state.constraints.length === 0 && state.decisions.length === 0) ? (
              <div className="small faint">
                Empty. This is Layer 1 — a compact structured state, never a transcript.
              </div>
            ) : (
              <div className="grid" style={{ gap: 10 }}>
                {state.goal && (
                  <Field label="Goal">
                    <span>{state.goal}</span>
                  </Field>
                )}
                {state.constraints.length > 0 && (
                  <Field label="Constraints">
                    {state.constraints.map((x, i) => (
                      <div key={i}>{x}</div>
                    ))}
                  </Field>
                )}
                {state.decisions.length > 0 && (
                  <Field label="Decisions">
                    {state.decisions.map((x, i) => (
                      <div key={i}>{x}</div>
                    ))}
                  </Field>
                )}
                {state.unresolved.length > 0 && (
                  <Field label="Open">
                    {state.unresolved.map((x, i) => (
                      <div key={i}>{x}</div>
                    ))}
                  </Field>
                )}
                {state.activeJobIds.length > 0 && (
                  <Field label="Active jobs">
                    {state.activeJobIds.map((id) => (
                      <button key={id} className="btn sm" onClick={() => onOpenJob(id)}>
                        {id.slice(-8)}
                      </button>
                    ))}
                  </Field>
                )}
              </div>
            )}
          </Card>

          <Card title="Target project">
            {projects.length === 0 ? (
              <div className="small faint">No projects registered yet.</div>
            ) : (
              <div className="grid" style={{ gap: 6 }}>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    className={`nav-item ${projectId === p.id ? 'active' : ''}`}
                    onClick={() => onSelectProject(projectId === p.id ? null : p.id)}
                  >
                    <span className="nowrap">{p.name}</span>
                    {p.isSelf && <Badge tone="accent">self</Badge>}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div className="small">{children}</div>
    </div>
  );
}
