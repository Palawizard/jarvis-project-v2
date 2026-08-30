import { useMemo, useState } from 'react';
import { api, type Job, type JobDeletionPlan, type Project } from '../api.ts';
import { Card, ConfirmDialog, Empty, StageBadge, rowActivation } from '../components.tsx';
import { useAsync } from '../hooks.ts';
import { approvePending } from './Chat.tsx';

export function JobsView({
  jobs: initial,
  projects,
  onOpen,
  onChanged,
  onOpenConversation,
  onOpenProject,
}: {
  jobs: Job[];
  projects: Project[];
  onOpen: (id: string) => void;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
  onOpenProject: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [archived, setArchived] = useState('active');
  const [sort, setSort] = useState('updated');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{
    kind: 'delete' | 'cancel';
    jobs: Job[];
    plan?: JobDeletionPlan;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = useAsync(
    () =>
      api.jobs({
        archived,
        sort,
        limit: '200',
        ...(search ? { search } : {}),
        ...(projectId ? { projectId } : {}),
        ...(status ? { status } : {}),
      }),
    [archived, sort, search, projectId, status],
  );
  const jobs = remote.data ?? initial;
  const byId = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const refresh = () => {
    remote.reload();
    onChanged();
    setSelected(new Set());
  };
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const setErrorFrom = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const requestDelete = async (job: Job) => {
    setError(null);
    try {
      const plan = await api.jobDeletionPlan(job.id);
      // Never offer an irreversible confirmation for something the server will
      // refuse: say why instead of failing after the user commits to it.
      if (!plan.eligible) {
        setError(plan.reason);
        return;
      }
      setConfirm({ kind: 'delete', jobs: [job], plan });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const confirmAction = async () => {
    if (!confirm) return;
    setError(null);
    await act(async () => {
      for (const job of confirm.jobs) {
        if (confirm.kind === 'cancel') await approvePending(await api.cancelJob(job.id));
        else await approvePending(await api.deleteJob(job.id));
      }
      setConfirm(null);
    });
  };

  return (
    <div className="page wide" data-testid="jobs-view">
      <div className="page-title">
        <div>
          <h1>Jobs</h1>
          <p>Background development work stays inspectable and never blocks chat.</p>
        </div>
      </div>
      <div className="filters">
        <input
          type="search"
          aria-label="Search Jobs"
          placeholder="Search Jobs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Filter Jobs by project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter Jobs by status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          {[
            'pending',
            'running',
            'paused',
            'awaiting_user',
            'failed',
            'completed',
            'cancelled',
          ].map((value) => (
            <option key={value} value={value}>
              {value.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select
          aria-label="Archived Jobs"
          value={archived}
          onChange={(event) => setArchived(event.target.value)}
        >
          <option value="active">Active history</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
        <select
          aria-label="Sort Jobs"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
        </select>
      </div>
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <button
            className="btn sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                for (const id of selected) await api.archiveJob(id, true);
              })
            }
          >
            Archive selected
          </button>
          <button
            className="btn sm danger"
            disabled={busy}
            onClick={() =>
              void Promise.all(
                [...selected].map(async (id) => ({
                  job: jobs.find((job) => job.id === id),
                  plan: await api.jobDeletionPlan(id),
                })),
              ).then((items) => {
                const eligible = items
                  .filter((item) => item.job && item.plan.eligible)
                  .map((item) => item.job as Job);
                if (!eligible.length)
                  setError('None of the selected Jobs is eligible for deletion.');
                else
                  setConfirm({
                    kind: 'delete',
                    jobs: eligible,
                    plan: {
                      eligible: true,
                      reason: `${eligible.length} eligible Job(s)`,
                      removes: ['disposable worktrees, branches, screenshots, and pipeline rows'],
                      preserves: [
                        'repositories, memories, deletion tombstones, immutable evidence',
                      ],
                    },
                  });
              }, setErrorFrom)
            }
          >
            Delete eligible
          </button>
        </div>
      )}
      <Card title={`${archived === 'archived' ? 'Archived' : 'Jobs'} (${jobs.length})`}>
        {jobs.length === 0 ? (
          <Empty>No Jobs match these filters.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="mobile-cards">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all Jobs"
                      checked={jobs.length > 0 && selected.size === jobs.length}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked ? new Set(jobs.map((job) => job.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th>Goal</th>
                  <th>Project</th>
                  <th>Stage</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    data-testid={`job-row-${job.id}`}
                    className="clickable"
                    onClick={() => onOpen(job.id)}
                    {...rowActivation(`Open job ${job.goal}`, () => onOpen(job.id))}
                  >
                    <td data-label="Select" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${job.goal}`}
                        checked={selected.has(job.id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(job.id);
                            else next.delete(job.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td data-label="Goal">
                      {/* One wrapper, so the cell has exactly one value child.
                          The mobile card layout turns each cell into a
                          `72px | 1fr` grid whose first column is the generated
                          label: a second sibling here fell back into that 72px
                          column, and the note -- the only place the
                          awaiting-user reason is explained -- was clipped to
                          "Candidate is ...". */}
                      <div className="cell-value">
                        <strong>{job.goal}</strong>
                        {(job.pauseReason || job.error) && (
                          <div className="tiny danger-text job-note">
                            {(job.pauseReason ?? job.error)?.split('\n')[0]}
                          </div>
                        )}
                      </div>
                    </td>
                    <td data-label="Project" className="small dim nowrap">
                      {byId.get(job.projectId)?.name ?? 'Unregistered project'}
                    </td>
                    <td data-label="Stage">
                      <StageBadge stage={job.stage} />
                    </td>
                    <td data-label="Updated" className="tiny faint nowrap">
                      {new Date(job.updatedAt).toLocaleString()}
                    </td>
                    <td data-label="Actions" onClick={(event) => event.stopPropagation()}>
                      <details className="item-menu">
                        <summary aria-label={`Actions for ${job.goal}`}>•••</summary>
                        <div role="menu">
                          <button onClick={() => onOpen(job.id)}>Open</button>
                          {job.stage === 'paused' && (
                            <button onClick={() => void act(() => api.resumeJob(job.id))}>
                              Resume
                            </button>
                          )}
                          {['failed', 'completed', 'cancelled', 'paused', 'awaiting_user'].includes(
                            job.stage,
                          ) && (
                            <button
                              onClick={() =>
                                void act(async () => {
                                  const outcome = await api.retryJob(job.id);
                                  if (outcome.status === 'succeeded')
                                    onOpen((outcome.result as Job).id);
                                })
                              }
                            >
                              Run again
                            </button>
                          )}
                          {['pending', 'running'].includes(job.status) && (
                            <button onClick={() => setConfirm({ kind: 'cancel', jobs: [job] })}>
                              Cancel
                            </button>
                          )}
                          <button
                            onClick={() => void act(() => api.archiveJob(job.id, !job.archivedAt))}
                          >
                            {job.archivedAt ? 'Unarchive' : 'Archive'}
                          </button>
                          <button onClick={() => void navigator.clipboard.writeText(job.id)}>
                            Copy Job ID
                          </button>
                          {job.sessionId && (
                            <button onClick={() => onOpenConversation(job.sessionId as string)}>
                              Source conversation
                            </button>
                          )}
                          <button onClick={() => onOpenProject(job.projectId)}>Open project</button>
                          <button className="danger-text" onClick={() => void requestDelete(job)}>
                            Delete
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
          title={
            confirm?.kind === 'cancel'
              ? `Cancel “${confirm.jobs[0]?.goal ?? 'Job'}”?`
              : `Delete ${confirm?.jobs.length === 1 ? `“${confirm.jobs[0]?.goal ?? 'Job'}”` : `${confirm?.jobs.length ?? 0} Jobs`}?`
          }
          description={
            confirm?.kind === 'cancel'
              ? 'The running process will stop. Partial work remains contained until you resume or delete it.'
              : confirm?.plan?.eligible === false
                ? confirm.plan.reason
                : (confirm?.plan?.reason ??
                  'Eligible disposable Job state will be permanently removed.')
          }
          removes={
            confirm?.kind === 'cancel' ? ['the active agent process'] : confirm?.plan?.removes
          }
          preserves={
            confirm?.kind === 'cancel'
              ? ['the Job, worktree, edits, and audit trail']
              : confirm?.plan?.preserves
          }
          confirmLabel={confirm?.kind === 'cancel' ? 'Cancel Job' : 'Delete'}
          busy={busy}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmAction()}
        />
      )}
    </div>
  );
}
