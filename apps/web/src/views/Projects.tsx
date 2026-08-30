import { useMemo, useState } from 'react';
import { api, type Memory, type Project, type UnregisterPreflight } from '../api.ts';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  MemoryCard,
  StageBadge,
  rowActivation,
} from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { approvePending } from './Chat.tsx';

export function ProjectsView({
  projects,
  selectedId,
  onSelect,
  onOpenJob,
  onChanged,
}: {
  projects: Project[];
  selectedId?: string;
  onSelect: (id?: string) => void;
  onOpenJob: (id: string) => void;
  onChanged: () => void;
}) {
  return selectedId ? (
    <ProjectDetail
      id={selectedId}
      onBack={() => onSelect()}
      onOpenJob={onOpenJob}
      onChanged={onChanged}
    />
  ) : (
    <ProjectList projects={projects} onSelect={onSelect} onChanged={onChanged} />
  );
}

function ProjectList({
  projects,
  onSelect,
  onChanged,
}: {
  projects: Project[];
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [rootPath, setRootPath] = useState('');
  const [devUrl, setDevUrl] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [sort, setSort] = useState<'name' | 'updated'>('name');
  const [confirm, setConfirm] = useState<{ project: Project; plan: UnregisterPreflight } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reportFailure = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const visible = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            (filter === 'all' || (filter === 'archived') === Boolean(project.archivedAt)) &&
            [project.name, project.rootPath, ...project.aliases].some((value) =>
              value.toLowerCase().includes(search.toLowerCase()),
            ),
        )
        .sort((a, b) =>
          sort === 'updated'
            ? b.updatedAt.localeCompare(a.updatedAt)
            : a.name.localeCompare(b.name),
        ),
    [projects, filter, search, sort],
  );
  const add = async () => {
    if (!rootPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProject(rootPath.trim(), undefined, devUrl.trim() || undefined);
      setRootPath('');
      setDevUrl('');
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const unregister = async () => {
    if (!confirm) return;
    setError(null);
    setBusy(true);
    try {
      await approvePending(await api.unregisterProject(confirm.project.id), confirm.project.id);
      setConfirm(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page wide" data-testid="projects-view">
      <div className="page-title">
        <div>
          <h1>Projects</h1>
          <p>Registered repositories are capabilities, not a prerequisite for conversation.</p>
        </div>
      </div>
      <Card title="Register a local Git repository">
        <div className="row wrap">
          <input
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="C:\path\to\repo"
            aria-label="Repository path"
            style={{ flex: 2, minWidth: 260 }}
          />
          <input
            value={devUrl}
            onChange={(event) => setDevUrl(event.target.value)}
            placeholder="Dev URL (optional)"
            aria-label="Dev URL"
            style={{ flex: 1, minWidth: 180 }}
          />
          <button
            className="btn primary"
            disabled={busy || !rootPath.trim()}
            onClick={() => void add()}
          >
            Register
          </button>
        </div>
        <p className="tiny faint">
          Jarvis registers metadata only. It never deletes the repository from disk, and coding Jobs
          use isolated worktrees.
        </p>
      </Card>
      <div className="filters">
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Project state"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
        <select
          aria-label="Sort projects"
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="name">Name</option>
          <option value="updated">Recent activity</option>
        </select>
      </div>
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      <Card title={`Projects (${visible.length})`}>
        {visible.length === 0 ? (
          <Empty>No projects match.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="mobile-cards">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Stack</th>
                  <th>Path</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((project) => (
                  <tr
                    key={project.id}
                    className="clickable"
                    onClick={() => onSelect(project.id)}
                    {...rowActivation(`Open project ${project.name}`, () => onSelect(project.id))}
                  >
                    <td data-label="Name">
                      {/* One wrapper: a stacked mobile card cell is a
                          `72px | 1fr` grid whose first column is the generated
                          label, so a second child here wrapped the alias list
                          into that 72px sliver. Same shape as the Jobs note. */}
                      <div className="cell-value">
                        <div className="row">
                          <strong>{project.name}</strong>
                          {project.isSelf && <Badge tone="accent">self</Badge>}
                          {project.archivedAt && <Badge>archived</Badge>}
                        </div>
                        {project.aliases.length > 0 && (
                          <div className="tiny faint">{project.aliases.join(', ')}</div>
                        )}
                      </div>
                    </td>
                    <td data-label="Stack" className="small dim">
                      {[...project.stack.languages, ...project.stack.frameworks]
                        .slice(0, 4)
                        .join(', ') || '—'}
                    </td>
                    <td
                      data-label="Path"
                      className="mono tiny dim"
                      style={{ overflowWrap: 'anywhere' }}
                    >
                      {project.rootPath}
                    </td>
                    <td data-label="Updated" className="tiny faint nowrap">
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </td>
                    <td data-label="Actions" onClick={(event) => event.stopPropagation()}>
                      <details className="item-menu">
                        <summary aria-label={`Actions for ${project.name}`}>•••</summary>
                        <div role="menu">
                          <button onClick={() => onSelect(project.id)}>Open</button>
                          <button
                            onClick={() => void navigator.clipboard.writeText(project.rootPath)}
                          >
                            Copy path
                          </button>
                          <button
                            onClick={() =>
                              void api.refreshProject(project.id).then(onChanged, reportFailure)
                            }
                          >
                            Re-detect
                          </button>
                          {!project.isSelf && (
                            <button
                              onClick={() =>
                                void api
                                  .archiveProject(project.id, !project.archivedAt)
                                  .then(onChanged, reportFailure)
                              }
                            >
                              {project.archivedAt ? 'Unarchive' : 'Archive'}
                            </button>
                          )}
                          <button
                            className="danger-text"
                            disabled={project.isSelf}
                            onClick={() =>
                              void api.unregisterPreflight(project.id).then((plan) => {
                                // Say why, rather than offering an irreversible
                                // confirmation the server has already told us
                                // it will refuse.
                                if (!plan.eligible) setError(plan.reason);
                                else setConfirm({ project, plan });
                              }, reportFailure)
                            }
                          >
                            Unregister
                          </button>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {confirm && (
        <ConfirmDialog
          open
          title={`Unregister “${confirm?.project.name ?? 'project'}”?`}
          description={confirm?.plan.reason ?? 'Remove this Jarvis project registration.'}
          removes={
            confirm?.plan.mode === 'hard'
              ? ['the Jarvis project registration']
              : ['the project from active resolution']
          }
          preserves={[
            'the repository and every file on disk',
            ...(confirm?.plan.mode === 'soft'
              ? ['Jobs, memory, and audit history via an archived project record']
              : []),
          ]}
          confirmLabel="Unregister"
          busy={busy}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void unregister()}
        />
      )}
    </div>
  );
}

function ProjectDetail({
  id,
  onBack,
  onOpenJob,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onOpenJob: (id: string) => void;
  onChanged: () => void;
}) {
  const detail = useAsync(() => api.project(id), [id]);
  const [request, setRequest] = useState('');
  const [memorySearch, setMemorySearch] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'purge' | 'forget'; memory?: Memory } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reportFailure = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  if (!detail.data)
    return (
      <div className="page">
        {detail.error ? <div className="api-error">{detail.error}</div> : <Empty>Loading…</Empty>}
      </div>
    );
  const { project, jobs, memory, snapshot } = detail.data;
  const memories = memory.items.filter((item) =>
    [item.content, item.subject ?? '', item.sourceType].some((value) =>
      value.toLowerCase().includes(memorySearch.toLowerCase()),
    ),
  );
  const createJob = async () => {
    if (!request.trim()) return;
    setBusy(true);
    try {
      const job = await api.createJob(project.id, request.trim(), [], true);
      setRequest('');
      onOpenJob(job.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const destructive = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'purge')
        await approvePending(await api.purgeProjectMemory(project.id), project.id);
      else if (confirm.memory) await api.deleteMemory(confirm.memory.id);
      setConfirm(null);
      detail.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page wide">
      <div className="page-title">
        <div className="row wrap">
          <button className="btn sm" onClick={onBack}>
            ← Projects
          </button>
          <h1>{project.name}</h1>
          {project.isSelf && <Badge tone="accent">self-development target</Badge>}
          {project.archivedAt && <Badge>archived</Badge>}
        </div>
        <button
          className="btn sm"
          onClick={() =>
            void api.refreshProject(project.id).then(() => {
              detail.reload();
              onChanged();
            }, reportFailure)
          }
        >
          Re-detect stack
        </button>
      </div>
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <Card title="Ask Jarvis to change this project">
            <textarea
              aria-label="Job request"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Describe the change…"
            />
            <div className="spread">
              <span className="tiny faint">
                Creates an isolated background Job. Never auto-merged.
              </span>
              <button
                className="btn primary"
                disabled={busy || !request.trim()}
                onClick={() => void createJob()}
              >
                Start Job
              </button>
            </div>
          </Card>
          <ProjectSettings
            project={project}
            onSaved={() => {
              detail.reload();
              onChanged();
            }}
          />
          <Card title="Repository state">
            <pre>{snapshot}</pre>
          </Card>
        </div>
        <div>
          <Card title={`Recent Jobs (${jobs.length})`}>
            {jobs.length === 0 ? (
              <Empty>No Jobs yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {jobs.map((job) => (
                    <tr
                      key={job.id}
                      className="clickable"
                      onClick={() => onOpenJob(job.id)}
                      {...rowActivation(`Open job ${job.goal}`, () => onOpenJob(job.id))}
                    >
                      <td>{job.goal}</td>
                      <td>
                        <StageBadge stage={job.stage} />
                      </td>
                      <td className="tiny faint">{new Date(job.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card
            title={`Project memory (${memory.total})`}
            actions={
              <button className="btn sm danger" onClick={() => setConfirm({ kind: 'purge' })}>
                Purge all
              </button>
            }
          >
            <input
              type="search"
              aria-label="Search project memory"
              placeholder="Filter project memory"
              value={memorySearch}
              onChange={(event) => setMemorySearch(event.target.value)}
              style={{ marginBottom: 10 }}
            />
            {memories.length === 0 ? (
              <Empty>No matching project memory.</Empty>
            ) : (
              <div className="grid">
                {memories.map((item) => (
                  <MemoryCard
                    key={item.id}
                    memory={item}
                    onInspect={() => undefined}
                    onForget={() => setConfirm({ kind: 'forget', memory: item })}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          open
          title={
            confirm.kind === 'purge'
              ? `Purge all memory for ${project.name}?`
              : 'Forget this project memory?'
          }
          description={
            confirm?.kind === 'purge'
              ? 'All eligible project-scoped memory will be permanently removed after explicit authorization.'
              : 'The memory stops being retrievable but its supersession/audit semantics remain.'
          }
          removes={[
            confirm?.kind === 'purge'
              ? 'eligible project memories and embeddings'
              : 'this memory from active retrieval',
          ]}
          preserves={['the repository, Jobs, conversations, and immutable evidence']}
          confirmLabel={confirm?.kind === 'purge' ? 'Purge memory' : 'Forget'}
          busy={busy}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void destructive()}
        />
      )}
    </div>
  );
}

function ProjectSettings({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(project.name);
  const [aliases, setAliases] = useState(project.aliases.join(', '));
  const [devUrl, setDevUrl] = useState(project.devUrl ?? '');
  const [summary, setSummary] = useState(project.summary ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Project settings">
      <div className="settings-form">
        <label>
          Display name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Aliases
          <input
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="site, website, app"
          />
        </label>
        <label>
          Dev URL
          <input value={devUrl} onChange={(event) => setDevUrl(event.target.value)} />
        </label>
        <label>
          Summary
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <button
          className="btn primary"
          disabled={busy || !name.trim()}
          onClick={() => {
            setBusy(true);
            void api
              .updateProject(project.id, {
                name: name.trim(),
                aliases: aliases
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
                devUrl: devUrl.trim() || null,
                summary: summary.trim() || null,
              })
              .then(onSaved, (reason: unknown) =>
                setSaveError(reason instanceof Error ? reason.message : String(reason)),
              )
              .finally(() => setBusy(false));
          }}
        >
          Save settings
        </button>
        {saveError && (
          <div className="api-error" role="alert">
            {saveError}
          </div>
        )}
      </div>
      <div className="tiny faint mono">
        {project.rootPath} · {project.defaultBranch} · updated{' '}
        {new Date(project.updatedAt).toLocaleString()}
      </div>
    </Card>
  );
}
