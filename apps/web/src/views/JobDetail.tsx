import { useEffect, useState } from 'react';
import { api, artifactUrl, type ContextPack, type JarvisEvent } from '../api.ts';
import { useAsync } from '../hooks.ts';
import { Badge, Card, Diff, Empty, MemoryCard, Pipeline, StageBadge } from '../components.tsx';

/**
 * Full job result view.
 *
 * Everything shown here is recorded evidence: real exit codes, the reviewer's
 * structured findings, actual screenshots, and the exact memories that were
 * injected. Nothing is inferred or optimistic.
 */
export function JobDetailView({
  jobId,
  lastEvent,
  artifactsDir,
  onBack,
}: {
  jobId: string;
  lastEvent: JarvisEvent | null;
  artifactsDir: string;
  onBack: () => void;
}) {
  const detail = useAsync(() => api.job(jobId), [jobId]);
  const [pack, setPack] = useState<ContextPack | null>(null);

  // Live refresh, but only for events belonging to this job.
  useEffect(() => {
    if (lastEvent?.jobId === jobId) detail.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent, jobId]);

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

  const {
    job,
    runs,
    candidate,
    verifications,
    reviews,
    visualQa,
    events,
    episode,
    contextPacks,
    running,
    project,
  } = detail.data;
  const review = reviews[reviews.length - 1];
  const implementationRun = runs.findLast(
    (run) => (run.role === 'implementer' || run.role === 'fixer') && !!run.result,
  );
  const skipped = project?.commands.dev && project.devUrl ? [] : (['visual_qa'] as const);

  return (
    <div className="page wide">
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={onBack}>
          ← Jobs
        </button>
        <h2 style={{ margin: 0, fontSize: 18 }}>{job.goal}</h2>
        <StageBadge stage={job.stage} />
        {running && <Badge tone="run">worker live</Badge>}
        <span style={{ flex: 1 }} />
        {running && (
          <button
            className="btn sm danger"
            onClick={() => void api.cancelJob(job.id).then(detail.reload)}
          >
            Cancel
          </button>
        )}
        {job.stage === 'queued' && (
          <button
            className="btn sm primary"
            onClick={() => void api.startJob(job.id).then(detail.reload)}
          >
            Start
          </button>
        )}
        {job.stage === 'awaiting_user' && detail.data.acceptanceEligible && (
          <button
            className="btn sm primary"
            onClick={() => void api.acceptJob(job.id).then(detail.reload)}
          >
            Accept candidate
          </button>
        )}
      </div>

      {job.error && (
        <Card title="Failure">
          <div style={{ color: 'var(--err)' }}>{job.error}</div>
        </Card>
      )}
      {job.stage === 'awaiting_user' && detail.data.acceptanceError && (
        <div className="alert error">
          This stored candidate cannot be accepted: {detail.data.acceptanceError}
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div>
          <Card title="Pipeline">
            <Pipeline
              stage={job.stage}
              status={job.status}
              skipped={[...skipped]}
              events={events}
            />
            <div className="mem-meta" style={{ marginTop: 12 }}>
              {job.branch && (
                <span>
                  branch <code>{job.branch}</code>
                </span>
              )}
              {job.baseRef && <span>base {job.baseRef.slice(0, 8)}</span>}
              {job.headRef && <span>head {job.headRef.slice(0, 8)}</span>}
              {job.fixCycles > 0 && <span>{job.fixCycles} fix cycle(s)</span>}
            </div>
            {job.worktreePath && (
              <div className="tiny faint mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                {job.worktreePath}
              </div>
            )}
          </Card>

          <Card title="Request">
            <div style={{ whiteSpace: 'pre-wrap' }}>{job.request}</div>
            {job.acceptance.length > 0 && (
              <ul className="small dim" style={{ marginBottom: 0 }}>
                {job.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Implementation summary">
            {implementationRun?.result ? (
              <div style={{ whiteSpace: 'pre-wrap' }}>{implementationRun.result}</div>
            ) : (
              <Empty>No implementation summary recorded.</Empty>
            )}
          </Card>

          <Card title={`Candidate changes (${candidate?.files.length ?? 0} files)`}>
            {!candidate ? (
              <Empty>
                Candidate diff is unavailable while the worker is running or its worktree is
                missing.
              </Empty>
            ) : candidate.files.length === 0 ? (
              <Empty>No changed files.</Empty>
            ) : (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th style={{ width: 70 }}>Added</th>
                      <th style={{ width: 70 }}>Removed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidate.files.map((file) => (
                      <tr key={file.path}>
                        <td className="mono tiny">{file.path}</td>
                        <td className="tiny diff-add">+{file.added}</td>
                        <td className="tiny diff-del">−{file.removed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <details style={{ marginTop: 10 }}>
                  <summary className="small dim" style={{ cursor: 'pointer' }}>
                    Git diff{candidate.diffTruncated ? ' (truncated)' : ''}
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <Diff text={candidate.diff || '(empty diff)'} />
                  </div>
                </details>
              </>
            )}
          </Card>

          <Card title={`Verification (${verifications.length})`}>
            {verifications.length === 0 ? (
              <Empty>No verification commands configured for this project.</Empty>
            ) : (
              <table>
                <tbody>
                  {verifications.map((v) => (
                    <tr key={v.id}>
                      <td style={{ width: 90 }}>
                        <Badge
                          tone={
                            v.status === 'passed' ? 'ok' : v.status === 'failed' ? 'err' : 'warn'
                          }
                        >
                          {v.status}
                        </Badge>
                      </td>
                      <td>
                        <div className="mono tiny">{v.command}</div>
                        {v.status !== 'passed' && v.output && (
                          <details>
                            <summary className="tiny dim" style={{ cursor: 'pointer' }}>
                              output
                            </summary>
                            <pre style={{ maxHeight: 240 }}>{v.output}</pre>
                          </details>
                        )}
                      </td>
                      <td className="tiny faint nowrap" style={{ width: 70 }}>
                        {(v.durationMs / 1000).toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Review">
            {!review ? (
              <Empty>Not reviewed yet.</Empty>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <Badge
                    tone={
                      review.verdict === 'approve'
                        ? 'ok'
                        : review.verdict === 'error'
                          ? 'err'
                          : 'warn'
                    }
                  >
                    {review.verdict.replace('_', ' ')}
                  </Badge>
                  <span className="tiny dim">by {review.provider} (independent run)</span>
                </div>
                {review.summary && (
                  <div className="small" style={{ marginBottom: 10 }}>
                    {review.summary}
                  </div>
                )}
                {review.findings.length === 0 ? (
                  <div className="small faint">No findings.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {review.findings.map((f, i) => (
                      <div key={i} className="mem-item">
                        <div className="mem-head">
                          <Badge
                            tone={
                              f.severity === 'critical' || f.severity === 'high'
                                ? 'err'
                                : f.severity === 'medium'
                                  ? 'warn'
                                  : undefined
                            }
                          >
                            {f.severity}
                          </Badge>
                          <Badge>{f.category}</Badge>
                          {f.file && (
                            <code className="tiny dim">
                              {f.file}
                              {f.line ? `:${f.line}` : ''}
                            </code>
                          )}
                        </div>
                        <div className="small">{f.description}</div>
                        {f.recommendation && (
                          <div className="small dim" style={{ marginTop: 4 }}>
                            → {f.recommendation}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        <div>
          <Card title={`Agent runs (${runs.length})`}>
            {runs.length === 0 ? (
              <Empty>No agent has run yet.</Empty>
            ) : (
              <table>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td style={{ width: 100 }}>
                        <div>
                          <Badge tone="accent">{r.provider}</Badge>
                        </div>
                        <div className="tiny faint">{r.role}</div>
                      </td>
                      <td>
                        <Badge
                          tone={
                            r.status === 'completed' ? 'ok' : r.status === 'running' ? 'run' : 'err'
                          }
                        >
                          {r.status}
                        </Badge>
                        {r.externalSessionId && (
                          <div
                            className="tiny faint mono"
                            title="provider session id — the run is resumable"
                          >
                            {r.externalSessionId.slice(0, 18)}…
                          </div>
                        )}
                        {r.error && (
                          <div className="tiny" style={{ color: 'var(--err)' }}>
                            {r.error}
                          </div>
                        )}
                      </td>
                      <td style={{ width: 90 }}>
                        {r.contextPackId && (
                          <button
                            className="btn sm"
                            onClick={() =>
                              r.contextPackId && void api.contextPack(r.contextPackId).then(setPack)
                            }
                          >
                            Context
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {pack && (
            <Card
              title={`Context pack — ${pack.usedTokens}/${pack.budgetTokens} tokens`}
              actions={
                <button className="btn sm" onClick={() => setPack(null)}>
                  Close
                </button>
              }
            >
              <div className="small dim" style={{ marginBottom: 10 }}>
                Exactly what was injected, and why each memory was selected.
              </div>
              {pack.selections.length === 0 ? (
                <div className="small faint">No durable memory was injected for this run.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th>Memory</th>
                      <th style={{ width: 60 }}>Score</th>
                      <th style={{ width: 50 }}>Tok</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pack.selections.map((s) => (
                      <tr key={s.memoryId}>
                        <td className="tiny dim">{s.section}</td>
                        <td>
                          <div className="small">
                            {s.memory?.content.slice(0, 160) ?? s.memoryId}
                          </div>
                          <div className="tiny faint">{s.reason}</div>
                        </td>
                        <td className="tiny mono">{s.score.toFixed(3)}</td>
                        <td className="tiny mono">{s.tokens}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <details style={{ marginTop: 10 }}>
                <summary className="tiny dim" style={{ cursor: 'pointer' }}>
                  rendered prompt section
                </summary>
                <pre>{pack.rendered || '(empty)'}</pre>
              </details>
            </Card>
          )}

          {contextPacks.length > 0 && !pack && (
            <Card title="Memory injected">
              {contextPacks.map((p) => (
                <div key={p.id} className="spread small" style={{ padding: '4px 0' }}>
                  <span className="dim">{p.role}</span>
                  <span className="mono tiny">
                    {p.usedTokens}/{p.budgetTokens} tokens · {p.selections.length} memories
                  </span>
                  <button
                    className="btn sm"
                    onClick={() => void api.contextPack(p.id).then(setPack)}
                  >
                    Inspect
                  </button>
                </div>
              ))}
            </Card>
          )}

          <Card title="Visual QA evidence">
            {visualQa.length === 0 ? (
              <Empty>
                {project?.commands.dev && project.devUrl
                  ? 'No screenshots captured.'
                  : 'Skipped — project has no dev command + dev URL configured.'}
              </Empty>
            ) : (
              <div className="shots">
                {visualQa.map((s) => (
                  <div key={s.id} className="shot">
                    {s.screenshotPath ? (
                      <img
                        src={artifactUrl(s.screenshotPath, artifactsDir)}
                        alt={`${s.route} ${s.viewport}`}
                        loading="lazy"
                      />
                    ) : (
                      <div className="empty small">{s.error ?? 'capture failed'}</div>
                    )}
                    <div className="shot-meta">
                      <div className="row">
                        <code className="tiny">{s.route}</code>
                        <Badge>{s.viewport}</Badge>
                      </div>
                      {s.consoleErrors.length > 0 && (
                        <div className="tiny" style={{ color: 'var(--err)' }}>
                          {s.consoleErrors.length} console error(s)
                        </div>
                      )}
                      {s.networkFailures.length > 0 && (
                        <div className="tiny" style={{ color: 'var(--warn)' }}>
                          {s.networkFailures.length} network issue(s)
                        </div>
                      )}
                      <div className="tiny faint">
                        {s.reviewedBy
                          ? `reviewed by ${s.reviewedBy}`
                          : 'evidence only — not AI-reviewed'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Episode written to memory">
            {episode ? (
              <MemoryCard memory={episode} />
            ) : (
              <Empty>No episode yet — written at job completion.</Empty>
            )}
          </Card>

          <Card title={`Events (${events.length})`}>
            <div className="events">
              {events
                .slice(-200)
                .reverse()
                .map((e) => (
                  <div key={e.id} className="event">
                    <span className="event-time">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : ''}
                    </span>
                    <span className="event-type">{e.type}</span>
                    <span className="event-body">{summarise(e)}</span>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function summarise(event: JarvisEvent): string {
  const p = event.payload ?? {};
  if (typeof p.text === 'string') return p.text.slice(0, 220);
  if (typeof p.tool === 'string') return `${p.tool}${p.isError ? ' (error)' : ''}`;
  if (typeof p.note === 'string') return p.note;
  if (p.from && p.to) return `${String(p.from)} → ${String(p.to)}`;
  if (typeof p.name === 'string') return `${p.name}: ${String(p.status ?? '')}`;
  const json = JSON.stringify(p);
  return json === '{}' ? '' : json.slice(0, 220);
}
