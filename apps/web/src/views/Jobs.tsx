import { type Job, type Project } from '../api.ts';
import { Card, Empty, StageBadge } from '../components.tsx';

export function JobsView({
  jobs,
  projects,
  onOpen,
}: {
  jobs: Job[];
  projects: Project[];
  onOpen: (id: string) => void;
}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'pending');
  const awaiting = jobs.filter((j) => j.status === 'awaiting_user');
  const done = jobs.filter((j) => !['running', 'pending', 'awaiting_user'].includes(j.status));

  const table = (list: Job[]) => (
    <table>
      <thead>
        <tr>
          <th>Goal</th>
          <th style={{ width: 130 }}>Project</th>
          <th style={{ width: 140 }}>Stage</th>
          <th style={{ width: 150 }}>Updated</th>
        </tr>
      </thead>
      <tbody>
        {list.map((job) => (
          <tr
            key={job.id}
            className="clickable"
            role="link"
            tabIndex={0}
            aria-label={`Open job ${job.goal}`}
            onClick={() => onOpen(job.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(job.id);
              }
            }}
          >
            <td>
              <div>{job.goal}</div>
              {job.error && (
                <div className="tiny" style={{ color: 'var(--err)' }}>
                  {job.error}
                </div>
              )}
            </td>
            <td className="small dim nowrap">{byId.get(job.projectId)?.name ?? '—'}</td>
            <td>
              <StageBadge stage={job.stage} />
            </td>
            <td className="tiny faint nowrap">{new Date(job.updatedAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="page">
      {awaiting.length > 0 && (
        <Card title={`Awaiting your decision (${awaiting.length})`}>{table(awaiting)}</Card>
      )}
      <Card title={`Active (${active.length})`}>
        {active.length === 0 ? <Empty>Nothing running.</Empty> : table(active)}
      </Card>
      <Card title={`History (${done.length})`}>
        {done.length === 0 ? <Empty>No finished jobs yet.</Empty> : table(done)}
      </Card>
    </div>
  );
}
