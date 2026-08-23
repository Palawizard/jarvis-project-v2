import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Health, type Job, type JarvisEvent, type Project, type Session } from './api.ts';
import { useAsync, useEventStream, useTheme } from './hooks.ts';
import { Badge, StageBadge } from './components.tsx';
import { CommandView } from './views/Command.tsx';
import { ProjectsView } from './views/Projects.tsx';
import { JobsView } from './views/Jobs.tsx';
import { JobDetailView } from './views/JobDetail.tsx';
import { MemoryView } from './views/Memory.tsx';

export type Route =
  | { name: 'command' }
  | { name: 'projects'; id?: string }
  | { name: 'jobs' }
  | { name: 'job'; id: string }
  | { name: 'memory' };

export function App() {
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
  const apiErrors = [health.error, projects.error, sessionData.error, jobs.error].filter(
    (error): error is string => !!error,
  );

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
      </main>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

export { StageBadge };
