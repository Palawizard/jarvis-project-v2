import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type Health,
  type Job,
  type JarvisEvent,
  type Project,
  type Session,
  type ToolExecution,
} from './api.ts';
import { useAsync, useEventStream, useTheme } from './hooks.ts';
import { Badge, StageBadge } from './components.tsx';
import { CommandView } from './views/Command.tsx';
import { ProjectsView } from './views/Projects.tsx';
import { JobsView } from './views/Jobs.tsx';
import { JobDetailView } from './views/JobDetail.tsx';
import { MemoryView } from './views/Memory.tsx';
import { ToolsView } from './views/Tools.tsx';

export type Route =
  | { name: 'command' }
  | { name: 'projects'; id?: string }
  | { name: 'jobs' }
  | { name: 'job'; id: string }
  | { name: 'memory' }
  | { name: 'tools' };

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

  if (auth !== 'authenticated') {
    return <PairingView checking={auth === 'checking'} onPaired={() => setAuth('authenticated')} />;
  }
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
  const [route, setRoute] = useState<Route>({ name: 'command' });
  const [theme, toggleTheme] = useTheme();
  const [lastEvent, setLastEvent] = useState<JarvisEvent | null>(null);

  const health = useAsync<Health>(() => api.health(), []);
  const projects = useAsync<Project[]>(() => api.projects(), []);
  const sessionData = useAsync<{ session: Session; rendered: string; messages: never[] }>(
    () => api.session() as never,
    [],
  );
  const jobs = useAsync<Job[]>(() => api.jobs(), []);
  const toolRequests = useAsync<{ pending: ToolExecution[] }>(() => api.toolExecutions(), []);

  // A single stream feeds every view; each view re-reads what it needs.
  const { connected } = useEventStream(
    useCallback((event: JarvisEvent) => {
      setLastEvent(event);
    }, []),
  );

  // Refresh the job list only on job-level events, not on every agent token.
  useEffect(() => {
    if (lastEvent && (lastEvent.type.startsWith('job.') || lastEvent.type === 'system.recovery')) {
      jobs.reload();
    }
    // A permission request the user never sees is a permission request that
    // silently blocks work, so the badge tracks the stream everywhere.
    if (lastEvent?.type.startsWith('tool.')) toolRequests.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  const activeJobs = useMemo(
    () => (jobs.data ?? []).filter((j) => j.status === 'running' || j.status === 'pending'),
    [jobs.data],
  );
  const awaiting = useMemo(
    () => (jobs.data ?? []).filter((j) => j.status === 'awaiting_user'),
    [jobs.data],
  );
  const pendingTools = toolRequests.data?.pending ?? [];
  const apiErrors = [
    health.error,
    projects.error,
    sessionData.error,
    jobs.error,
    toolRequests.error,
  ].filter((error): error is string => !!error);

  const session = sessionData.data?.session ?? null;
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (session?.projectId) setProjectId(session.projectId);
  }, [session?.projectId]);

  const selectProject = useCallback(
    async (id: string | null) => {
      setProjectId(id);
      if (session) await api.setSessionProject(session.id, id).catch(() => undefined);
    },
    [session],
  );

  const title =
    route.name === 'command'
      ? 'Command'
      : route.name === 'projects'
        ? 'Projects'
        : route.name === 'jobs'
          ? 'Jobs'
          : route.name === 'job'
            ? 'Job'
            : route.name === 'tools'
              ? 'Tools and permissions'
              : 'Memory';

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Jarvis
        </div>
        <NavItem
          active={route.name === 'command'}
          onClick={() => setRoute({ name: 'command' })}
          label="Command"
        />
        <NavItem
          active={route.name === 'projects'}
          onClick={() => setRoute({ name: 'projects' })}
          label="Projects"
          count={projects.data?.length}
        />
        <NavItem
          active={route.name === 'jobs' || route.name === 'job'}
          onClick={() => setRoute({ name: 'jobs' })}
          label="Jobs"
          count={activeJobs.length || undefined}
        />
        <NavItem
          active={route.name === 'memory'}
          onClick={() => setRoute({ name: 'memory' })}
          label="Memory"
          count={health.data?.memory.active}
        />
        <NavItem
          active={route.name === 'tools'}
          onClick={() => setRoute({ name: 'tools' })}
          label="Tools"
          count={pendingTools.length || undefined}
          testId="nav-tools"
        />

        <div className="sidebar-foot">
          <div>
            <span>stream</span>
            <span className={connected ? '' : 'faint'}>{connected ? 'live' : 'offline'}</span>
          </div>
          {health.data?.providers.map((p) => (
            <div key={p.id} title={p.reason ?? p.authMethod ?? ''}>
              <span>{p.id}</span>
              <span
                style={{
                  color: p.cooldownUntil ? 'var(--warn)' : p.available ? 'var(--ok)' : 'var(--err)',
                }}
              >
                {p.cooldownUntil ? 'cooldown' : p.available ? 'available' : 'unavailable'}
              </span>
            </div>
          ))}
          <div title={health.data?.memory.embeddings.error ?? health.data?.memory.embeddings.model}>
            <span>semantic</span>
            <span
              style={{
                color: !health.data?.memory.embeddings.enabled
                  ? 'var(--text-faint)'
                  : health.data?.memory.embeddings.disabledForProcess
                    ? 'var(--err)'
                    : health.data?.memory.embeddings.ready
                      ? 'var(--ok)'
                      : 'var(--warn)',
              }}
            >
              {!health.data?.memory.embeddings.enabled
                ? 'off'
                : health.data?.memory.embeddings.disabledForProcess
                  ? 'failed'
                  : health.data?.memory.embeddings.ready
                    ? 'ready'
                    : 'lazy'}
            </span>
          </div>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <h1>{title}</h1>
          {awaiting.length > 0 && (
            <button className="btn sm" onClick={() => setRoute({ name: 'jobs' })}>
              <Badge tone="warn">{awaiting.length} awaiting you</Badge>
            </button>
          )}
          {pendingTools.length > 0 && (
            <button className="btn sm" onClick={() => setRoute({ name: 'tools' })}>
              <Badge tone="warn">
                {pendingTools.length} permission{' '}
                {pendingTools.length === 1 ? 'request' : 'requests'}
              </Badge>
            </button>
          )}
          <span className="spacer" />
          <select
            className="topbar-project"
            value={projectId ?? ''}
            onChange={(e) => void selectProject(e.target.value || null)}
            aria-label="Active project"
          >
            <option value="">No project selected</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isSelf ? ' (self)' : ''}
              </option>
            ))}
          </select>
          <button className="btn sm theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? '☾' : '☀'}
          </button>
        </header>

        {apiErrors.length > 0 && (
          <div className="api-error" role="alert">
            Jarvis API error: {[...new Set(apiErrors)].join(' · ')}
          </div>
        )}

        {route.name === 'command' && (
          <CommandView
            session={session}
            projects={projects.data ?? []}
            projectId={projectId}
            onSelectProject={selectProject}
            onOpenJob={(id) => setRoute({ name: 'job', id })}
            lastEvent={lastEvent}
          />
        )}
        {route.name === 'projects' && (
          <ProjectsView
            projects={projects.data ?? []}
            selectedId={route.id}
            onSelect={(id) => setRoute({ name: 'projects', ...(id ? { id } : {}) })}
            onOpenJob={(id) => setRoute({ name: 'job', id })}
            onChanged={projects.reload}
          />
        )}
        {route.name === 'jobs' && (
          <JobsView
            jobs={jobs.data ?? []}
            projects={projects.data ?? []}
            onOpen={(id) => setRoute({ name: 'job', id })}
          />
        )}
        {route.name === 'job' && (
          <JobDetailView
            jobId={route.id}
            lastEvent={lastEvent}
            artifactsDir={health.data?.artifactsDir ?? ''}
            onBack={() => setRoute({ name: 'jobs' })}
          />
        )}
        {route.name === 'memory' && (
          <MemoryView projects={projects.data ?? []} lastEvent={lastEvent} />
        )}
        {route.name === 'tools' && (
          <ToolsView projects={projects.data ?? []} projectId={projectId} lastEvent={lastEvent} />
        )}
      </main>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  label,
  count,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  testId?: string;
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} data-testid={testId}>
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

export { StageBadge };
