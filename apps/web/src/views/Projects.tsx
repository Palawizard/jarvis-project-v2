import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type JarvisEvent,
  type Memory,
  type Project,
  type UnregisterPreflight,
} from '../api.ts';
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
  lastEvent,
  onSelect,
  onOpenJob,
  onChanged,
}: {
  projects: Project[];
  selectedId?: string;
  lastEvent: JarvisEvent | null;
  onSelect: (id?: string) => void;
  onOpenJob: (id: string) => void;
  onChanged: () => void;
}) {
  return selectedId ? (
    <ProjectDetail
      id={selectedId}
      lastEvent={lastEvent}
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
  // On by default: a project Jarvis knows nothing about is a project it answers
  // questions about badly. The cost is stated next to the box, and registration
  // succeeds whatever the analysis does.
  const [analyze, setAnalyze] = useState(true);
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
      await api.addProject(rootPath.trim(), undefined, devUrl.trim() || undefined, analyze);
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
        <label className="check" data-testid="analyze-on-add">
          <input
            type="checkbox"
            checked={analyze}
            onChange={(event) => setAnalyze(event.target.checked)}
          />
          <span>
            Analyse the project after adding it
            <span className="tiny faint">
              {' '}
              — a read-only coding agent reads the repository once to learn its stack and
              architecture. Uses provider quota; registration succeeds either way.
            </span>
          </span>
        </label>
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
  lastEvent,
  onBack,
  onOpenJob,
  onChanged,
}: {
  id: string;
  lastEvent: JarvisEvent | null;
  onBack: () => void;
  onOpenJob: (id: string) => void;
  onChanged: () => void;
}) {
  const detail = useAsync(() => api.project(id), [id]);
  // Analysis finishes minutes after the click, on the server. `lastEvent` is
  // the same SSE stream the rest of the app watches; without this the profile
  // appears only after a manual reload.
  useEffect(() => {
    if (lastEvent?.type.startsWith('project.')) detail.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);
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
  const { project, jobs, memory, snapshot, analysis } = detail.data;
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
        <div className="row">
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
          <AnalyzeButton
            project={project}
            running={analysis.running}
            onDone={() => {
              detail.reload();
              onChanged();
            }}
            onError={reportFailure}
          />
        </div>
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
          <ProjectAnalysisCard
            project={project}
            analysis={analysis}
            onChanged={() => {
              detail.reload();
              onChanged();
            }}
            onError={reportFailure}
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

type AnalysisMeta = { running: boolean; stale: boolean; head: string | null };

/** True while a run is claimed, whether the server or the row says so. */
function analysisInFlight(project: Project, analysis: AnalysisMeta): boolean {
  return (
    analysis.running ||
    project.analysis?.status === 'running' ||
    project.analysis?.status === 'queued'
  );
}

function AnalyzeButton({
  project,
  running,
  onDone,
  onError,
}: {
  project: Project;
  running: boolean;
  onDone: () => void;
  onError: (reason: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight =
    running || project.analysis?.status === 'running' || project.analysis?.status === 'queued';
  const label = inFlight
    ? 'Analysing…'
    : project.profile
      ? 'Re-analyse project'
      : 'Analyse project';
  return (
    <button
      className="btn sm primary"
      data-testid="analyze-project"
      disabled={busy || inFlight}
      title="Sends a read-only agent to read this repository. Uses provider quota."
      onClick={() => {
        setBusy(true);
        void api
          .analyzeProject(project.id)
          .then(onDone, onError)
          .finally(() => setBusy(false));
      }}
    >
      {label}
    </button>
  );
}

/**
 * What Jarvis has learned about this project, and how current it is.
 *
 * Deliberately explicit about staleness rather than hiding an old profile: a
 * profile from six commits ago is still the best orientation available, and
 * pretending otherwise would mean re-analysing on every commit and burning
 * provider quota for nothing.
 */
function ProjectAnalysisCard({
  project,
  analysis,
  onChanged,
  onError,
}: {
  project: Project;
  analysis: AnalysisMeta;
  onChanged: () => void;
  onError: (reason: unknown) => void;
}) {
  const profile = project.profile;
  const inFlight = analysisInFlight(project, analysis);
  const failed = project.analysis?.status === 'failed';
  return (
    <Card
      title="Project analysis"
      actions={
        inFlight ? (
          <button
            className="btn sm"
            data-testid="cancel-analysis"
            onClick={() => void api.cancelProjectAnalysis(project.id).then(onChanged, onError)}
          >
            Stop
          </button>
        ) : (
          <AnalyzeButton
            project={project}
            running={analysis.running}
            onDone={onChanged}
            onError={onError}
          />
        )
      }
    >
      <div className="row wrap" data-testid="analysis-status">
        {inFlight && <Badge tone="run">analysing</Badge>}
        {!inFlight && failed && <Badge tone="err">analysis failed</Badge>}
        {!inFlight && !failed && profile && <Badge tone="ok">analysed</Badge>}
        {!inFlight && !failed && !profile && <Badge>not analysed</Badge>}
        {profile && analysis.stale && <Badge tone="warn">out of date</Badge>}
      </div>
      {failed && project.analysis?.error && (
        <p className="tiny" role="alert">
          {project.analysis.error}
        </p>
      )}
      {!profile && !inFlight && (
        <Empty>
          Jarvis has not read this repository yet. Analysing it once lets Jarvis answer questions
          about the project and gives coding Jobs a head start.
        </Empty>
      )}
      {profile && (
        <>
          <p className="tiny faint">
            {new Date(profile.analyzedAt).toLocaleString()} · commit{' '}
            <span className="mono">{profile.analyzedCommit.slice(0, 12)}</span>
            {profile.provider ? ` · ${profile.provider}` : ''}
            {profile.model ? ` (${profile.model})` : ''}
          </p>
          {analysis.stale && (
            <p className="tiny faint">
              The repository has moved on since this analysis. It is still used as orientation —
              re-analyse when it stops matching what you see.
            </p>
          )}
          {profile.purpose && <p>{profile.purpose}</p>}
          {profile.architecture && <p className="small dim">{profile.architecture}</p>}
          <dl className="profile-grid">
            <ProfileList label="Languages" values={profile.languages} inline />
            <ProfileList label="Frameworks" values={profile.frameworks} inline />
            <ProfileList
              label="Modules"
              values={profile.modules.map((module) =>
                [module.name, module.path].filter(Boolean).join(' — '),
              )}
            />
            <ProfileList label="Entrypoints" values={profile.entrypoints} />
            <ProfileList label="Conventions" values={profile.conventions} />
            <ProfileList label="Risks" values={profile.risks} />
            <ProfileList label="Read first" values={profile.inspectFirst} />
          </dl>
          <p className="tiny faint">
            Orientation only. Jarvis still runs the commands it detected itself — nothing an
            analysis writes is ever executed.
          </p>
        </>
      )}
    </Card>
  );
}

function ProfileList({
  label,
  values,
  inline,
}: {
  label: string;
  values: string[];
  inline?: boolean;
}) {
  if (values.length === 0) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {inline ? (
          values.join(', ')
        ) : (
          <ul>
            {/* Index keys: these lists are model-produced, render-only and never
                reordered, and duplicate entries are possible. */}
            {values.map((value, index) => (
              <li key={`${index}-${value}`}>{value}</li>
            ))}
          </ul>
        )}
      </dd>
    </>
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
      <div className="tiny faint mono project-meta">
        {project.rootPath} · {project.defaultBranch} · updated{' '}
        {new Date(project.updatedAt).toLocaleString()}
      </div>
    </Card>
  );
}
