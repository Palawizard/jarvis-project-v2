import { useEffect, useState } from 'react';
import { api, artifactUrl, type ContextPack, type JarvisEvent, type Job } from '../api.ts';
import { useAsync } from '../hooks.ts';
import {
  Badge,
  Card,
  ConfirmDialog,
  Diff,
  Empty,
  MemoryCard,
  Pipeline,
  StageBadge,
} from '../components.tsx';
import { approvePending } from './Chat.tsx';

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
  onOpenJob,
}: {
  jobId: string;
  lastEvent: JarvisEvent | null;
  artifactsDir: string;
  onBack: () => void;
  onOpenJob: (id: string) => void;
}) {
  const detail = useAsync(() => api.job(jobId), [jobId]);
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const setActionErrorFrom = (reason: unknown) =>
    setActionError(reason instanceof Error ? reason.message : String(reason));
  const [destructive, setDestructive] = useState<'cancel' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

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
    application,
    routingDecisions,
    upgrade,
    staleness,
    deletionPlan,
  } = detail.data;
  const review = reviews[reviews.length - 1];
  const implementationRun = runs.findLast(
    (run) => (run.role === 'implementer' || run.role === 'fixer') && !!run.result,
  );
  // Only a recorded skip is a skip. "The project has a visual runtime" says
  // nothing about whether this candidate changed any UI.
  const skipped =
    job.visualQaStatus === 'skipped' || !project?.config.visualQa ? (['visual_qa'] as const) : [];

  return (
    <div className="page wide" data-testid="job-detail-view">
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
            onClick={() => {
              setActionError(null);
              setDestructive('cancel');
            }}
          >
            Cancel
          </button>
        )}
        {job.stage === 'queued' && (
          <button
            className="btn sm primary"
            onClick={() => void api.startJob(job.id).then(detail.reload, setActionErrorFrom)}
          >
            Start
          </button>
        )}
        {job.stage === 'paused' && (
          <span
            className="small dim nowrap"
            style={{ maxWidth: 340 }}
            title={job.pauseReason ?? job.error ?? undefined}
            data-testid="pause-hint"
          >
            Paused: {firstLine(job.pauseReason ?? job.error) ?? 'reason not recorded'}
          </span>
        )}
        {['failed', 'completed', 'cancelled', 'paused', 'awaiting_user'].includes(job.stage) && (
          <button
            className="btn sm"
            onClick={() =>
              // Say why when it refuses: "Restart as new Job" on a
              // validation-only Job is refused, and used to do nothing at all.
              void api.retryJob(job.id).then((outcome) => {
                if (outcome.status !== 'succeeded') {
                  const detailText =
                    'error' in outcome && outcome.error ? `: ${outcome.error}` : '';
                  setActionError(`could not restart this Job (${outcome.status}${detailText})`);
                  return;
                }
                onOpenJob((outcome.result as Job).id);
              }, setActionErrorFrom)
            }
          >
            Restart as new Job
          </button>
        )}
        {['failed', 'completed', 'cancelled', 'paused', 'awaiting_user'].includes(job.stage) && (
          <button
            className="btn sm"
            onClick={() =>
              void api.archiveJob(job.id, !job.archivedAt).then(detail.reload, setActionErrorFrom)
            }
          >
            {job.archivedAt ? 'Unarchive' : 'Archive'}
          </button>
        )}
        {deletionPlan.eligible && (
          <button
            className="btn sm danger"
            onClick={() => {
              setActionError(null);
              setDestructive('delete');
            }}
          >
            Delete
          </button>
        )}
        {job.stage === 'paused' && (
          <button
            data-testid="resume-job"
            className="btn sm primary"
            onClick={() =>
              void api
                .resumeJob(job.id)
                .then(() => {
                  setActionError(null);
                  detail.reload();
                })
                .catch((error: unknown) =>
                  setActionError(error instanceof Error ? error.message : String(error)),
                )
            }
          >
            Resume
          </button>
        )}
        {job.stage === 'awaiting_user' &&
          detail.data.acceptanceEligible &&
          application?.status !== 'approved' &&
          application?.status !== 'applied' && (
            <button
              className="btn sm primary"
              onClick={() =>
                void api
                  .approveJob(job.id)
                  .then(() => {
                    setActionError(null);
                    detail.reload();
                  })
                  .catch((error: unknown) =>
                    setActionError(error instanceof Error ? error.message : String(error)),
                  )
              }
            >
              Approve Candidate
            </button>
          )}
        {application?.status === 'approved' && !project?.isSelf && (
          <button
            className="btn sm primary"
            onClick={() =>
              void api
                .applyJob(job.id)
                .then(() => {
                  setActionError(null);
                  detail.reload();
                })
                .catch((error: unknown) =>
                  setActionError(error instanceof Error ? error.message : String(error)),
                )
            }
          >
            Apply to Project
          </button>
        )}
        {application?.status === 'approved' &&
          project?.isSelf &&
          (!upgrade || ['activation_failed', 'rollback_completed'].includes(upgrade.status)) && (
            <button
              className="btn sm primary"
              onClick={() =>
                void api
                  .prepareUpgrade(job.id)
                  .then(() => {
                    setActionError(null);
                    detail.reload();
                  })
                  .catch((error: unknown) =>
                    setActionError(error instanceof Error ? error.message : String(error)),
                  )
              }
            >
              Prepare Self-Upgrade
            </button>
          )}
        {upgrade?.status === 'preflight_passed' && (
          <button
            className="btn sm danger"
            onClick={() => {
              if (!confirm('Activate this exact Jarvis candidate through the supervisor?')) return;
              const activationToken = prompt(
                'Paste the supervisor activation token printed when pnpm dev started (not the pairing token):',
              );
              if (!activationToken) return;
              void api
                .activateUpgrade(job.id, activationToken)
                .then(() => {
                  setActionError(null);
                  detail.reload();
                })
                .catch((error: unknown) =>
                  setActionError(error instanceof Error ? error.message : String(error)),
                );
            }}
          >
            Activate Self-Upgrade
          </button>
        )}
      </div>

      {job.error && (
        <Card title="Failure">
          <div style={{ color: 'var(--err)' }}>{job.error}</div>
        </Card>
      )}
      {actionError && <div className="alert error">{actionError}</div>}
      {job.stage === 'paused' && (
        <div className="alert error" role="status" data-testid="pause-explanation">
          Paused at {job.resumeStage ?? 'unknown stage'}: {job.pauseReason ?? job.error}
        </div>
      )}
      {staleness?.stale && (
        <div className="alert error" role="status" data-testid="stale-job">
          <strong>This paused Job is stale.</strong> {staleness.detail} Resume is blocked; restart
          as a new Job against the current target, inspect this candidate, or archive it.
        </div>
      )}
      <div className="small dim" style={{ marginBottom: 10 }}>
        repair cycles — verification {job.fixCycles}, code review {job.reviewFixCycles}, visual{' '}
        {job.visualFixCycles}
        {job.validationOnly && job.candidateSourceSha
          ? ` · validation-only source ${job.candidateSourceSha}`
          : ''}
      </div>
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
              resumeStage={job.resumeStage}
            />
            {job.stage === 'visual_qa' && <VisualQaActivity events={events} />}
            {job.visualQaStatus && <VisualQaOutcome status={job.visualQaStatus} />}
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

          <Card title={project?.isSelf ? 'Self-upgrade application' : 'Candidate application'}>
            {!application ? (
              <Empty>Not approved. Approval records intent but does not modify Git.</Empty>
            ) : (
              <div className="grid" style={{ gap: 7 }}>
                <div className="row">
                  <Badge
                    tone={
                      application.status === 'applied'
                        ? 'ok'
                        : application.status === 'failed' ||
                            application.status === 'inspection_required'
                          ? 'err'
                          : 'warn'
                    }
                  >
                    {application.status.replace('_', ' ')}
                  </Badge>
                  <span className="small dim">{application.method}</span>
                </div>
                <div className="mono tiny">
                  {application.candidateBase.slice(0, 8)} → {application.candidateHead.slice(0, 8)}
                </div>
                {application.targetBranch && (
                  <div className="small dim">target branch: {application.targetBranch}</div>
                )}
                {application.failure && (
                  <div className="small" style={{ color: 'var(--err)' }}>
                    {application.failure}
                  </div>
                )}
                {project?.isSelf && application.status === 'approved' && (
                  <div className="small dim">
                    This is a self-upgrade. Activation requires the external supervisor and a
                    separate explicit confirmation.
                  </div>
                )}
                {upgrade && (
                  <div className="grid" style={{ gap: 5 }}>
                    <div className="small">
                      upgrade: <Badge>{upgrade.status.replaceAll('_', ' ')}</Badge>
                    </div>
                    <div className="mono tiny">current {upgrade.previousSha}</div>
                    <div className="mono tiny">candidate {upgrade.candidateSha}</div>
                    <div className="mono tiny">rollback {upgrade.rollbackRef ?? 'not created'}</div>
                    {upgrade.healthcheckResult && (
                      <pre>{JSON.stringify(upgrade.healthcheckResult, null, 2)}</pre>
                    )}
                    {upgrade.failure && (
                      <div className="small" style={{ color: 'var(--err)' }}>
                        {upgrade.failure}
                      </div>
                    )}
                  </div>
                )}
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

          {job.compiledBrief && <CompiledBrief brief={job.compiledBrief} />}

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
                        <div className="mono tiny">
                          {v.command} · {v.kind}
                          {!v.required ? ' · advisory' : ''}
                        </div>
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
                  <span className="tiny dim">head {review.headRef.slice(0, 12)}</span>
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
                          <Badge>
                            {f.severity === 'critical' || f.severity === 'high'
                              ? 'blocking'
                              : 'advisory'}
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
                        {r.model && <div className="tiny faint mono">{r.model}</div>}
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
                              r.contextPackId &&
                              void api
                                .contextPack(r.contextPackId)
                                .then(setPack, setActionErrorFrom)
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

          {routingDecisions.length > 0 && (
            <Card title="Routing decisions">
              <div className="grid" style={{ gap: 7 }}>
                {routingDecisions.map((decision) => (
                  <div key={decision.id} className="mem-item">
                    <div className="row">
                      <Badge>{decision.role}</Badge>
                      <span className="small">
                        {decision.provider ?? 'none'}
                        {decision.model ? ` / ${decision.model}` : ''}
                      </span>
                    </div>
                    <div className="tiny dim">{decision.reason}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

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
                    onClick={() => void api.contextPack(p.id).then(setPack, setActionErrorFrom)}
                  >
                    Inspect
                  </button>
                </div>
              ))}
            </Card>
          )}

          <Card title="Visual QA evidence">
            {job.visualQaStatus && (
              <div style={{ marginBottom: 10 }}>
                <VisualQaOutcome status={job.visualQaStatus} />
              </div>
            )}
            {job.visualQaPlan && (
              <div className="small dim" style={{ marginBottom: 10 }}>
                <div>
                  {job.visualQaPlan.mode === 'interactive'
                    ? 'Evidence the QA agent captured:'
                    : `Visual QA plan (${job.visualQaPlan.source.replace(/_/g, ' ')}):`}
                </div>
                {job.visualQaPlan.scenarios.map((scenario) => (
                  <div key={scenario.name} className="tiny">
                    {scenario.name} · {(scenario.viewports ?? ['desktop', 'mobile']).join(' · ')}
                  </div>
                ))}
                {job.visualQaPlan.reasons.map((reason) => (
                  <div key={reason} className="tiny faint">
                    {reason}
                  </div>
                ))}
              </div>
            )}
            {visualQa.length === 0 ? (
              <Empty>
                {!project?.config.visualQa
                  ? 'Skipped — project has no isolated visual-QA runtime configured.'
                  : job.visualQaStatus === 'skipped'
                    ? 'Skipped — this candidate changed no rendered UI.'
                    : 'No evidence captured.'}
              </Empty>
            ) : (
              <div className="shots">
                {visualQa.map((s) => (
                  <div key={s.id} className="shot">
                    {s.screenshotPath ? (
                      <AuthenticatedArtifact
                        path={s.screenshotPath}
                        artifactsDir={artifactsDir}
                        alt={`${s.scenarioName} ${s.route} ${s.viewport}`}
                      />
                    ) : (
                      <div className="empty small">{s.error ?? 'capture failed'}</div>
                    )}
                    <div className="shot-meta">
                      <div className="row">
                        <Badge>{s.scenarioName}</Badge>
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
                      {s.reviewVerdict && (
                        <Badge tone={s.reviewVerdict === 'pass' ? 'ok' : 'err'}>
                          visual {s.reviewVerdict.replace('_', ' ')}
                        </Badge>
                      )}
                      {s.reviewFindings
                        .filter(
                          (finding) =>
                            finding.scenarioName === s.scenarioName &&
                            finding.route === s.route &&
                            finding.viewport === s.viewport,
                        )
                        .map((finding, index) => (
                          <div key={index} className="tiny" style={{ marginTop: 4 }}>
                            <Badge
                              tone={
                                finding.severity === 'high' || finding.severity === 'medium'
                                  ? 'err'
                                  : undefined
                              }
                            >
                              {finding.severity}
                            </Badge>{' '}
                            <Badge>
                              {finding.severity === 'high' || finding.severity === 'medium'
                                ? 'blocking'
                                : 'advisory'}
                            </Badge>{' '}
                            {finding.description}
                            {finding.recommendation ? ` — ${finding.recommendation}` : ''}
                          </div>
                        ))}
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
      {destructive !== null && (
        <ConfirmDialog
          open
          title={destructive === 'cancel' ? `Cancel “${job.goal}”?` : `Delete “${job.goal}”?`}
          description={
            destructive === 'cancel'
              ? 'The active process will stop; partial work stays contained.'
              : deletionPlan.reason
          }
          removes={destructive === 'cancel' ? ['the active agent process'] : deletionPlan.removes}
          preserves={
            destructive === 'cancel'
              ? ['the Job, worktree, edits, and audit history']
              : deletionPlan.preserves
          }
          confirmLabel={destructive === 'cancel' ? 'Cancel Job' : 'Delete Job'}
          busy={busy}
          error={actionError}
          onCancel={() => setDestructive(null)}
          onConfirm={() => {
            setBusy(true);
            const action =
              destructive === 'cancel'
                ? api.cancelJob(job.id).then((outcome) => approvePending(outcome))
                : api.deleteJob(job.id).then((outcome) => approvePending(outcome));
            void action
              .then(() => {
                setDestructive(null);
                if (destructive === 'delete') onBack();
                else detail.reload();
              })
              .catch((error: unknown) =>
                setActionError(error instanceof Error ? error.message : String(error)),
              )
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}

function AuthenticatedArtifact({
  path,
  artifactsDir,
  alt,
}: {
  path: string;
  artifactsDir: string;
  alt: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void api
      .artifact(artifactUrl(path, artifactsDir))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => setSource(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, artifactsDir]);
  return source ? (
    <img src={source} alt={alt} loading="lazy" />
  ) : (
    <div className="empty small">Loading evidence…</div>
  );
}

/**
 * What the QA agent is doing right now.
 *
 * The agent batches its browser actions, so this is one line per model turn
 * rather than one per click -- enough to follow along, not a DOM firehose.
 */
function VisualQaActivity({ events }: { events: JarvisEvent[] }) {
  const latest = events.findLast((event) => event.type === 'visual_qa.activity');
  if (!latest) return null;
  const turn = latest.payload?.turn;
  // The ceiling travels in the event, so the UI never restates a budget that
  // lives in VISUAL_QA_BUDGET and can change without it.
  const of = latest.payload?.of;
  const viewport = latest.payload?.viewport;
  return (
    <div className="small dim" style={{ marginTop: 10 }} data-testid="visual-qa-activity">
      Visual QA
      {typeof turn === 'number' ? ` ${turn}${typeof of === 'number' ? `/${of}` : ''}` : ''}:{' '}
      {String(latest.payload?.activity ?? '')}
      {viewport ? ` (${String(viewport)})` : ''}
    </div>
  );
}

/**
 * What Visual QA actually concluded.
 *
 * The pipeline checkmark says a stage ran; this says what it found. They are
 * different questions, and conflating them is what made "screenshots captured"
 * read as "the UI is fine" while the Job paused.
 */
function VisualQaOutcome({ status }: { status: NonNullable<Job['visualQaStatus']> }) {
  const label = {
    skipped: 'Visual QA skipped — no rendered UI changed',
    passed: 'Visual QA passed',
    product_defect: 'Visual QA found a product defect',
    inconclusive: 'Visual QA inconclusive — the changed surface could not be judged',
    infrastructure_error: 'Visual QA infrastructure error — the browser or runtime failed',
  }[status];
  const tone = status === 'passed' ? 'ok' : status === 'skipped' ? undefined : 'err';
  return (
    <div className="row" style={{ marginTop: 10 }} data-testid={`visual-qa-${status}`}>
      <Badge tone={tone}>{label}</Badge>
    </div>
  );
}

/**
 * The compiled brief, shown UNDER the request and labelled as derived.
 *
 * Deliberately a second card rather than a prettier rendering of the request:
 * the request is what the human asked for and the brief is a model's reading of
 * it, and someone auditing a candidate has to be able to tell which is which.
 */
function CompiledBrief({ brief }: { brief: NonNullable<Job['compiledBrief']> }) {
  const list = (label: string, items: string[]) =>
    items.length > 0 ? (
      <div style={{ marginTop: 10 }}>
        <div className="small dim">{label}</div>
        <ul className="small" style={{ marginBottom: 0 }}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Card title="Compiled brief">
      <div className="small dim">
        Derived context for the coding agent, compiled from the request above. Not authoritative
        {brief.model ? ` — ${brief.provider ?? 'provider'} / ${brief.model}` : ''}.
      </div>
      <div style={{ marginTop: 10, fontWeight: 600 }}>{brief.title}</div>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
        {brief.goal}
      </div>
      {list('Requirements', brief.requirements)}
      {list('Acceptance criteria', brief.acceptanceCriteria)}
      {list('Relevant project context', brief.relevantProjectContext)}
      {list('Constraints', brief.constraints)}
      {list('Assumptions (unverified)', brief.assumptions)}
    </Card>
  );
}

/** First non-empty line of a recorded reason; `.nowrap` handles the visual truncation. */
function firstLine(text: string | null | undefined): string | null {
  const line = text?.split('\n').find((candidate) => candidate.trim().length > 0);
  return line ? line.trim() : null;
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
