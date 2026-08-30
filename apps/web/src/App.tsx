import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ConversationSummary,
  type Health,
  type JarvisEvent,
  type Job,
  type Project,
  type SearchHit,
  type ToolExecution,
} from './api.ts';
import { Badge, ConfirmDialog, useModalDialog } from './components.tsx';
import { useAsync, useEventStream, useTheme } from './hooks.ts';
import { ChatView, approvePending } from './views/Chat.tsx';
import { ProjectsView } from './views/Projects.tsx';
import { JobsView } from './views/Jobs.tsx';
import { JobDetailView } from './views/JobDetail.tsx';
import { MemoryView } from './views/Memory.tsx';
import { ToolsView } from './views/Tools.tsx';

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'projects'; id?: string }
  | { name: 'jobs' }
  | { name: 'job'; id: string }
  | { name: 'memory' }
  | { name: 'tools' };

function routeFromPath(pathname = location.pathname): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'chat' && parts[1]) return { name: 'chat', id: parts[1] };
  if (parts[0] === 'projects') return { name: 'projects', ...(parts[1] ? { id: parts[1] } : {}) };
  if (parts[0] === 'jobs' && parts[1]) return { name: 'job', id: parts[1] };
  if (parts[0] === 'jobs') return { name: 'jobs' };
  if (parts[0] === 'memory') return { name: 'memory' };
  if (parts[0] === 'tools') return { name: 'tools' };
  return { name: 'home' };
}

function pathFor(route: Route): string {
  if (route.name === 'chat') return `/chat/${encodeURIComponent(route.id)}`;
  if (route.name === 'projects')
    return `/projects${route.id ? `/${encodeURIComponent(route.id)}` : ''}`;
  if (route.name === 'job') return `/jobs/${encodeURIComponent(route.id)}`;
  if (route.name === 'home') return '/';
  return `/${route.name}`;
}

export function App() {
  const [auth, setAuth] = useState<'checking' | 'locked' | 'authenticated'>('checking');
  useEffect(() => {
    const check = () =>
      void api
        .authStatus()
        .then((status) => setAuth(status.authenticated ? 'authenticated' : 'locked'))
        .catch(() => setAuth('locked'));
    check();
    window.addEventListener('jarvis-auth-failed', check);
    return () => window.removeEventListener('jarvis-auth-failed', check);
  }, []);
  if (auth !== 'authenticated')
    return <PairingView checking={auth === 'checking'} onPaired={() => setAuth('authenticated')} />;
  return <AuthenticatedApp />;
}

function PairingView({ checking, onPaired }: { checking: boolean; onPaired: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.pair(token.trim());
      setToken('');
      onPaired();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="pairing-shell">
      <section className="pairing-card" aria-labelledby="pairing-title">
        <div className="brand">
          <span className="brand-dot" /> Jarvis
        </div>
        <h1 id="pairing-title">Human control locked</h1>
        <p>Enter the one-time pairing token shown in the terminal that started Jarvis.</p>
        <label htmlFor="pairing-token">Pairing token</label>
        <input
          id="pairing-token"
          type="password"
          autoComplete="off"
          value={token}
          disabled={checking || busy}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && token.trim()) void pair();
          }}
        />
        <button
          className="btn primary"
          disabled={checking || busy || !token.trim()}
          onClick={() => void pair()}
        >
          {checking ? 'Checking…' : busy ? 'Pairing…' : 'Pair this browser'}
        </button>
        {error && (
          <div className="api-error" role="alert">
            Authentication failed: {error}
          </div>
        )}
      </section>
    </main>
  );
}

function AuthenticatedApp() {
  const [route, setRoute] = useState<Route>(() => routeFromPath());
  const [theme, toggleTheme] = useTheme();
  const [lastEvent, setLastEvent] = useState<JarvisEvent | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [archivedChats, setArchivedChats] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [rename, setRename] = useState<ConversationSummary | null>(null);
  const [deleteChat, setDeleteChat] = useState<ConversationSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const bootstrapFailed = useRef(false);
  const [palette, setPalette] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');

  const health = useAsync<Health>(() => api.health(), []);
  const projects = useAsync<Project[]>(() => api.projects({ status: 'all' }), []);
  const jobs = useAsync<Job[]>(() => api.jobs({ archived: 'active', limit: '200' }), []);
  const conversations = useAsync<ConversationSummary[]>(
    () =>
      api.conversations({
        status: archivedChats ? 'archived' : 'active',
        search: chatSearch || undefined,
      }),
    [archivedChats, chatSearch],
  );
  const toolRequests = useAsync<{ pending: ToolExecution[] }>(() => api.toolExecutions(), []);
  const search = useAsync<SearchHit[]>(
    () => (globalQuery.trim() ? api.search(globalQuery) : Promise.resolve([])),
    [globalQuery],
  );
  const { connected } = useEventStream(
    useCallback((event: JarvisEvent) => setLastEvent(event), []),
  );

  // Latest route, readable from async callbacks that must not act on a stale one.
  const routeRef = useRef(route);
  routeRef.current = route;

  const navigate = useCallback((next: Route, replace = false) => {
    const path = pathFor(next);
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    setRoute(next);
    setDrawer(false);
  }, []);

  useEffect(() => {
    const pop = () => setRoute(routeFromPath());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (lastEvent?.type.startsWith('job.') || lastEvent?.type === 'system.recovery') jobs.reload();
    // Not `message.delta`: the sidebar shows titles and activity, neither of
    // which changes while tokens arrive, and reloading the whole conversation
    // list per token chunk was the most expensive thing streaming did.
    if (
      lastEvent?.type.startsWith('conversation.') ||
      lastEvent?.type === 'message.created' ||
      lastEvent?.type === 'message.completed' ||
      lastEvent?.type === 'message.failed' ||
      lastEvent?.type === 'job.linked'
    )
      conversations.reload();
    if (lastEvent?.type.startsWith('tool.')) toolRequests.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);
  useEffect(() => {
    if (busy || route.name !== 'home' || conversations.loading || conversations.error) return;
    if (bootstrapFailed.current) return;
    const first = conversations.data?.[0];
    if (first) navigate({ name: 'chat', id: first.id }, true);
    else {
      setBusy(true);
      void api
        .createConversation()
        .then((conversation) => {
          conversations.reload();
          // The user may have opened or started a conversation while this
          // request was in flight. Navigating unconditionally would yank them
          // out of it — and out of anything already typed there.
          if (routeRef.current.name === 'home') {
            navigate({ name: 'chat', id: conversation.id }, true);
          }
        })
        .catch((reason: unknown) => {
          // Latch: `busy` is a dependency of this effect, so retrying on failure
          // re-fires it immediately and POSTs again as fast as the network
          // allows, once per round trip, forever.
          bootstrapFailed.current = true;
          reportFailure(reason);
        })
        .finally(() => setBusy(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, route.name, conversations.loading, conversations.error, conversations.data, navigate]);

  const activeJobs = useMemo(
    () => (jobs.data ?? []).filter((job) => ['running', 'pending'].includes(job.status)),
    [jobs.data],
  );
  const attention = useMemo(
    () =>
      (jobs.data ?? []).filter((job) => ['awaiting_user', 'paused', 'failed'].includes(job.status)),
    [jobs.data],
  );
  const errors = [
    health.error,
    projects.error,
    jobs.error,
    conversations.error,
    toolRequests.error,
    actionError,
  ].filter((value): value is string => Boolean(value));
  // Pin, archive and rename now answer 409 when the mutation did not really
  // happen. Dropping that on the floor showed the user nothing at all, which is
  // the same silent-success problem the route was fixed for.
  const reportFailure = (reason: unknown) =>
    setActionError(reason instanceof Error ? reason.message : String(reason));

  const newChat = async () => {
    setBusy(true);
    try {
      const conversation = await api.createConversation();
      conversations.reload();
      navigate({ name: 'chat', id: conversation.id });
    } catch (reason) {
      reportFailure(reason);
    } finally {
      setBusy(false);
    }
  };
  const removeConversation = async () => {
    if (!deleteChat) return;
    setActionError(null);
    setBusy(true);
    try {
      await approvePending(await api.deleteConversation(deleteChat.id));
      const deletedId = deleteChat.id;
      setDeleteChat(null);
      conversations.reload();
      if (route.name === 'chat' && route.id === deletedId) navigate({ name: 'home' }, true);
    } catch (reason) {
      reportFailure(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`app chat-app ${drawer ? 'drawer-open' : ''}`}>
      <button
        className="drawer-scrim"
        data-testid="drawer-scrim"
        aria-label="Close conversations"
        onClick={() => setDrawer(false)}
      />
      <aside
        className="conversation-sidebar"
        aria-label="Conversations"
        data-testid="conversation-sidebar"
      >
        <div className="sidebar-brand">
          <div className="brand">
            <span className="brand-dot" /> Jarvis
          </div>
          <button
            className="btn sm"
            aria-label="Close conversation drawer"
            onClick={() => setDrawer(false)}
          >
            ×
          </button>
        </div>
        <button className="btn primary new-chat" disabled={busy} onClick={() => void newChat()}>
          ＋ New chat
        </button>
        <button
          className="search-trigger"
          data-testid="global-search-open"
          onClick={() => setPalette(true)}
        >
          ⌕ Search <kbd>Ctrl K</kbd>
        </button>
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Filter conversations"
          value={chatSearch}
          onChange={(event) => setChatSearch(event.target.value)}
        />
        <div className="conversation-list">
          {(conversations.data ?? []).map((conversation) => (
            <div
              className={`conversation-row ${route.name === 'chat' && route.id === conversation.id ? 'active' : ''}`}
              key={conversation.id}
              data-testid={`conversation-row-${conversation.id}`}
            >
              <button
                className="conversation-open"
                onClick={() => navigate({ name: 'chat', id: conversation.id })}
              >
                <span className="conversation-title">
                  {conversation.pinned ? '◆ ' : ''}
                  {conversation.title ?? 'New conversation'}
                </span>
                <span className="conversation-preview">
                  {conversation.preview ?? 'No messages yet'}
                </span>
              </button>
              <details className="item-menu">
                <summary
                  data-testid={`conversation-menu-${conversation.id}`}
                  aria-label={`Actions for ${conversation.title ?? 'conversation'}`}
                >
                  •••
                </summary>
                <div role="menu" data-testid={`conversation-actions-${conversation.id}`}>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setActionError(null);
                      setRename(conversation);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    onClick={() =>
                      void api
                        .updateConversation(conversation.id, { pinned: !conversation.pinned })
                        .then(conversations.reload, reportFailure)
                    }
                  >
                    {conversation.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() =>
                      void api
                        .updateConversation(conversation.id, { archived: !archivedChats })
                        .then(() => {
                          conversations.reload();
                          if (route.name === 'chat' && route.id === conversation.id)
                            navigate({ name: 'home' });
                        }, reportFailure)
                    }
                  >
                    {archivedChats ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    role="menuitem"
                    data-testid={`conversation-delete-${conversation.id}`}
                    className="danger-text"
                    onClick={() => {
                      setActionError(null);
                      setDeleteChat(conversation);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </details>
            </div>
          ))}
          {!conversations.loading && (conversations.data?.length ?? 0) === 0 && (
            <div className="empty tiny">No {archivedChats ? 'archived ' : ''}conversations.</div>
          )}
        </div>
        <button className="archive-toggle" onClick={() => setArchivedChats((value) => !value)}>
          {archivedChats ? '← Recent conversations' : 'Archived conversations'}
        </button>
        <nav className="app-nav" aria-label="Workspace">
          <Nav
            active={route.name === 'projects'}
            label="Projects"
            onClick={() => navigate({ name: 'projects' })}
            count={projects.data?.filter((project) => !project.archivedAt).length}
          />
          <Nav
            active={route.name === 'jobs' || route.name === 'job'}
            label="Jobs"
            onClick={() => navigate({ name: 'jobs' })}
            count={activeJobs.length || undefined}
          />
          <Nav
            active={route.name === 'memory'}
            label="Memory"
            onClick={() => navigate({ name: 'memory' })}
            count={health.data?.memory.active}
          />
          <Nav
            active={route.name === 'tools'}
            label="Tools"
            onClick={() => navigate({ name: 'tools' })}
            count={toolRequests.data?.pending.length || undefined}
          />
        </nav>
        <div className="sidebar-status">
          <span className={connected ? 'ok-text' : 'faint'}>
            {connected ? '● live' : '○ offline'}
          </span>
          {attention.length > 0 && (
            <button onClick={() => navigate({ name: 'jobs' })}>
              {attention.length} need attention
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="mobile-bar">
          <button
            className="btn sm"
            data-testid="mobile-drawer-open"
            aria-label="Open conversations"
            onClick={() => setDrawer(true)}
          >
            ☰
          </button>
          <span>Jarvis</span>
          <button className="btn sm" onClick={() => setPalette(true)}>
            ⌕
          </button>
        </div>
        {errors.length > 0 && (
          <div className="api-error" role="alert">
            Jarvis API error: {[...new Set(errors)].join(' · ')}
          </div>
        )}
        {route.name === 'chat' && (
          <ChatView
            conversationId={route.id}
            projects={projects.data ?? []}
            conversations={conversations.data ?? []}
            lastEvent={lastEvent}
            onMissing={() => navigate({ name: 'home' }, true)}
            onOpenJob={(id) => navigate({ name: 'job', id })}
          />
        )}
        {route.name === 'projects' && (
          <ProjectsView
            projects={projects.data ?? []}
            selectedId={route.id}
            onSelect={(id) => navigate({ name: 'projects', ...(id ? { id } : {}) })}
            onOpenJob={(id) => navigate({ name: 'job', id })}
            onChanged={projects.reload}
          />
        )}
        {route.name === 'jobs' && (
          <JobsView
            jobs={jobs.data ?? []}
            projects={projects.data ?? []}
            onOpen={(id) => navigate({ name: 'job', id })}
            onChanged={jobs.reload}
            onOpenConversation={(id) => navigate({ name: 'chat', id })}
            onOpenProject={(id) => navigate({ name: 'projects', id })}
          />
        )}
        {route.name === 'job' && (
          <JobDetailView
            jobId={route.id}
            lastEvent={lastEvent}
            artifactsDir={health.data?.artifactsDir ?? ''}
            onBack={() => navigate({ name: 'jobs' })}
            onOpenJob={(id) => navigate({ name: 'job', id })}
          />
        )}
        {route.name === 'memory' && (
          <MemoryView projects={projects.data ?? []} lastEvent={lastEvent} />
        )}
        {route.name === 'tools' && (
          <ToolsView projects={projects.data ?? []} projectId={null} lastEvent={lastEvent} />
        )}
        {route.name === 'home' && <div className="empty">Opening Jarvis…</div>}
        <button className="theme-float btn sm" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </main>

      <GlobalSearch
        open={palette}
        query={globalQuery}
        hits={search.data ?? []}
        loading={search.loading}
        onQuery={setGlobalQuery}
        onClose={() => {
          setPalette(false);
          setGlobalQuery('');
        }}
        onOpen={(hit) => {
          setPalette(false);
          setGlobalQuery('');
          navigate(
            hit.type === 'conversation'
              ? { name: 'chat', id: hit.id }
              : hit.type === 'project'
                ? { name: 'projects', id: hit.id }
                : { name: 'job', id: hit.id },
          );
        }}
      />
      {rename && (
        <RenameDialog
          conversation={rename}
          busy={busy}
          error={actionError}
          onCancel={() => setRename(null)}
          onSave={(title) => {
            setBusy(true);
            void api
              .updateConversation(rename.id, { title })
              .then(() => {
                setRename(null);
                conversations.reload();
              }, reportFailure)
              .finally(() => setBusy(false));
          }}
        />
      )}
      {deleteChat && (
        <ConfirmDialog
          open
          title={`Delete “${deleteChat?.title ?? 'conversation'}”?`}
          description="The conversation and its working state will be permanently removed."
          removes={[
            'its transcript',
            'conversation-only working state',
            'conversation-specific metadata',
          ]}
          preserves={[
            'Jobs created from it',
            'global and project memories',
            'application and self-upgrade evidence',
          ]}
          confirmLabel="Delete conversation"
          busy={busy}
          error={actionError}
          onCancel={() => setDeleteChat(null)}
          onConfirm={() => void removeConversation()}
        />
      )}
    </div>
  );
}

function Nav({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={`nav-${label.toLowerCase()}`}
      className={`nav-item ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

function RenameDialog({
  conversation,
  busy,
  error,
  onCancel,
  onSave,
}: {
  conversation: ConversationSummary;
  busy: boolean;
  /** Inside the dialog: showModal() makes the shell's banner unreachable. */
  error?: string | null;
  onCancel: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(conversation.title ?? '');
  const ref = useModalDialog(true);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      data-testid="rename-dialog"
      aria-labelledby="rename-title"
      onCancel={onCancel}
    >
      <h2 id="rename-title">Rename conversation</h2>
      <input
        autoFocus
        aria-label="Conversation title"
        value={title}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && title.trim()) onSave(title.trim());
        }}
      />
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      <div className="row dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !title.trim()}
          onClick={() => onSave(title.trim())}
        >
          Save
        </button>
      </div>
    </dialog>
  );
}

function GlobalSearch({
  open,
  query,
  hits,
  loading,
  onQuery,
  onClose,
  onOpen,
}: {
  open: boolean;
  query: string;
  hits: SearchHit[];
  loading: boolean;
  onQuery: (value: string) => void;
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
}) {
  // Driven by the real `open` prop: this component stays mounted, so the effect
  // has to re-run when it flips. showModal() gives the backdrop and focus trap.
  const ref = useModalDialog(open);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className="palette"
      data-testid="global-search"
      aria-label="Global search"
      onCancel={onClose}
      onKeyDown={(event) => {
        // Not redundant with onCancel: focus starts in the search input, and a
        // search input consumes Escape to clear itself, so the dialog never
        // sees a cancel while the palette is being typed into.
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        autoFocus
        type="search"
        data-testid="global-search-input"
        placeholder="Search chats, projects, and Jobs…"
        aria-label="Global search query"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      <div className="palette-results">
        {loading ? (
          <div className="empty">Searching…</div>
        ) : (
          hits.map((hit) => (
            <button
              key={`${hit.type}:${hit.id}`}
              data-testid={`search-hit-${hit.type}-${hit.id}`}
              onClick={() => onOpen(hit)}
            >
              <Badge tone={hit.type === 'conversation' ? 'accent' : undefined}>
                {hit.type === 'conversation' ? 'Chat' : hit.type === 'job' ? 'Job' : 'Project'}
              </Badge>
              <span>
                <strong>{hit.title}</strong>
                <small>{hit.subtitle}</small>
              </span>
            </button>
          ))
        )}
        {query && !loading && hits.length === 0 && <div className="empty">No matches.</div>}
      </div>
      <div className="palette-foot">
        <span>Navigation only — search never runs actions.</span>
        <button className="btn sm" onClick={onClose}>
          Esc
        </button>
      </div>
    </dialog>
  );
}

export { StageBadge } from './components.tsx';
