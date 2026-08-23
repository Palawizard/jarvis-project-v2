import { useState } from 'react';
import { api, type Project } from '../api.ts';
import { useAsync } from '../hooks.ts';
import { Card, Badge, Empty, MemoryCard, StageBadge } from '../components.tsx';

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
  if (selectedId) {
    return (
      <ProjectDetail
        id={selectedId}
        onBack={() => onSelect(undefined)}
        onOpenJob={onOpenJob}
        onChanged={onChanged}
      />
    );
  }
  return <ProjectList projects={projects} onSelect={onSelect} onChanged={onChanged} />;
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!rootPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProject(rootPath.trim(), undefined, devUrl.trim() || undefined);
      setRootPath('');
      setDevUrl('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <Card title="Register a local git repository">
        <div className="row wrap">
          <input
            type="text"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="C:\path\to\repo"
            style={{ flex: 2, minWidth: 260 }}
            aria-label="Repository path"
          />
          <input
            type="text"
            value={devUrl}
            onChange={(e) => setDevUrl(e.target.value)}
            placeholder="dev URL for visual QA (optional)"
            style={{ flex: 1, minWidth: 200 }}
            aria-label="Dev URL"
          />
          <button
            className="btn primary"
            onClick={() => void add()}
            disabled={busy || !rootPath.trim()}
          >
            Register
          </button>
        </div>
        {error && (
          <div className="small" style={{ color: 'var(--err)', marginTop: 8 }}>
            {error}
          </div>
        )}
        <div className="small faint" style={{ marginTop: 8 }}>
          The repository must be a git repo with at least one commit. Jarvis never writes to your
          working tree — jobs run in an isolated worktree.
        </div>
      </Card>

      <Card title={`Projects (${projects.length})`}>
        {projects.length === 0 ? (
          <Empty>No projects yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Stack</th>
                <th>Path</th>
                <th>Verification</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr
                  key={p.id}
                  className="clickable"
                  role="link"
                  tabIndex={0}
                  aria-label={`Open project ${p.name}`}
                  onClick={() => onSelect(p.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(p.id);
                    }
                  }}
                >
                  <td>
                    <div className="row">
                      <strong>{p.name}</strong>
                      {p.isSelf && <Badge tone="accent">self</Badge>}
                    </div>
                  </td>
                  <td className="small dim">
                    {[...p.stack.languages, ...p.stack.frameworks].slice(0, 4).join(', ') || '—'}
                  </td>
                  <td className="mono tiny dim nowrap" style={{ maxWidth: 300 }}>
                    {p.rootPath}
                  </td>
                  <td className="small dim">
                    {['lint', 'typecheck', 'test', 'build']
                      .filter((k) => p.commands[k])
                      .join(', ') || 'none detected'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
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
  onOpenJob: (jobId: string) => void;
  onChanged: () => void;
}) {
  const detail = useAsync(() => api.project(id), [id]);
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);

  if (detail.error)
    return (
      <div className="page">
        <Card title="Error">{detail.error}</Card>
      </div>
    );
  if (!detail.data)
    return (
      <div className="page">
        <Empty>Loading…</Empty>
      </div>
    );

  const { project, jobs, memory, snapshot } = detail.data;

  const createJob = async () => {
    if (!request.trim()) return;
    setBusy(true);
    try {
      const job = await api.createJob(project.id, request.trim(), [], true);
      setRequest('');
      onOpenJob(job.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={onBack}>
          ← Projects
        </button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{project.name}</h2>
        {project.isSelf && <Badge tone="accent">self-development target</Badge>}
        <span style={{ flex: 1 }} />
        <button
          className="btn sm"
          onClick={() =>
            void api.refreshProject(project.id).then(() => {
              detail.reload();
              onChanged();
            })
          }
        >
          Re-detect stack
        </button>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <Card title="New job">
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="Describe the change in plain language…"
              aria-label="Job request"
            />
            <div className="spread" style={{ marginTop: 8 }}>
              <span className="small faint">Runs in an isolated worktree. Never auto-merged.</span>
              <button
                className="btn primary"
                onClick={() => void createJob()}
                disabled={busy || !request.trim()}
              >
                Start job
              </button>
            </div>
          </Card>

          <Card title="Snapshot given to agents">
            <pre>{snapshot}</pre>
          </Card>

          <Card title={`Recent jobs (${jobs.length})`}>
            {jobs.length === 0 ? (
              <Empty>No jobs yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {jobs.map((j) => (
                    <tr
                      key={j.id}
                      className="clickable"
                      role="link"
                      tabIndex={0}
                      aria-label={`Open job ${j.goal}`}
                      onClick={() => onOpenJob(j.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenJob(j.id);
                        }
                      }}
                    >
                      <td>{j.goal}</td>
                      <td style={{ width: 130 }}>
                        <StageBadge stage={j.stage} />
                      </td>
                      <td className="tiny faint nowrap" style={{ width: 100 }}>
                        {new Date(j.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title="Configuration">
            <table>
              <tbody>
                <tr>
                  <td className="dim small">Path</td>
                  <td className="mono tiny">{project.rootPath}</td>
                </tr>
                <tr>
                  <td className="dim small">Branch</td>
                  <td className="mono tiny">{project.defaultBranch}</td>
                </tr>
                <tr>
                  <td className="dim small">Dev URL</td>
                  <td className="mono tiny">{project.devUrl ?? '—'}</td>
                </tr>
                {Object.entries(project.commands)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td className="dim small">{k}</td>
                      <td className="mono tiny">{v}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>

          <Card
            title={`Project memory (${memory.total})`}
            actions={
              <button
                className="btn sm danger"
                onClick={() => {
                  if (
                    confirm(`Delete ALL Jarvis memory for ${project.name}? This cannot be undone.`)
                  ) {
                    void api.purgeProjectMemory(project.id).then(() => detail.reload());
                  }
                }}
              >
                Delete all
              </button>
            }
          >
            {memory.items.length === 0 ? (
              <Empty>Nothing learned yet. Memory accumulates as jobs complete.</Empty>
            ) : (
              <div className="grid" style={{ gap: 8 }}>
                {memory.items.slice(0, 30).map((m) => (
                  <MemoryCard key={m.id} memory={m} />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
