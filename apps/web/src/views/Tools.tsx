import { useEffect, useState } from 'react';
import {
  api,
  type JarvisEvent,
  type PolicyDecision,
  type Project,
  type RiskLevel,
  type ToolExecution,
  type ToolExecutionStatus,
  type ToolCapabilities,
  type ToolGrant,
  type ToolSummary,
} from '../api.ts';
import { useAsync } from '../hooks.ts';
import { Badge, Card, Empty } from '../components.tsx';

const RISK_TONE: Record<RiskLevel, 'ok' | 'warn' | 'err' | 'accent' | undefined> = {
  observe: undefined,
  safe_action: undefined,
  reversible_modification: 'accent',
  sensitive: 'warn',
  destructive: 'err',
};

const STATUS_TONE: Record<ToolExecutionStatus, 'ok' | 'warn' | 'err' | 'run' | undefined> = {
  pending_approval: 'warn',
  running: 'run',
  succeeded: 'ok',
  failed: 'err',
  denied: 'err',
  expired: undefined,
  interrupted: 'warn',
  timed_out: 'warn',
};

const DECISION_LABEL: Record<PolicyDecision, string> = {
  allow: 'runs immediately',
  confirm: 'asks you first',
  deny: 'refused',
};

function preview(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const json = JSON.stringify(value, null, 2);
  return json.length > 600 ? `${json.slice(0, 600)}…` : json;
}

function projectLabel(projects: Project[], id: string | null): string {
  if (!id) return 'any project';
  const match = projects.find((project) => project.id === id);
  return match ? match.name : id;
}

/**
 * Everything the permission layer decided, and everything still waiting on the
 * user. Refused and interrupted actions are shown as prominently as successful
 * ones — a permission system the user cannot audit is not one they can trust.
 */
export function ToolsView({
  projects,
  projectId,
  lastEvent,
}: {
  projects: Project[];
  projectId: string | null;
  lastEvent: JarvisEvent | null;
}) {
  const catalog = useAsync<ToolSummary[]>(() => api.tools(), []);
  const capabilities = useAsync<ToolCapabilities>(() => api.toolCapabilities(), []);
  const history = useAsync<{ pending: ToolExecution[]; executions: ToolExecution[] }>(
    () => api.toolExecutions(),
    [],
  );
  const grants = useAsync<ToolGrant[]>(() => api.toolGrants(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (lastEvent?.type.startsWith('tool.')) {
      history.reload();
      if (lastEvent.type.startsWith('tool.permission.')) grants.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  /**
   * A refused or failed action comes back as a normal 200 with an outcome, not
   * as an HTTP error, so reporting success on "the request worked" would hide
   * exactly the cases the user needs to see.
   */
  const act = async (id: string, run: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setActionError(null);
    setNotice(null);
    try {
      const outcome = (await run()) as { status?: string; error?: string } | null;
      const status = outcome?.status;
      if (status === 'denied' || status === 'failed' || status === 'timed_out') {
        setActionError(outcome?.error ?? `The action was ${status}.`);
      } else {
        setNotice(done);
      }
      history.reload();
      grants.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const pending = history.data?.pending ?? [];
  const executions = history.data?.executions ?? [];
  const loadErrors = [catalog.error, capabilities.error, history.error, grants.error].filter(
    (error): error is string => !!error,
  );

  return (
    <div className="page wide" data-testid="tools-view">
      {loadErrors.length > 0 && (
        <div className="api-error" role="alert">
          {[...new Set(loadErrors)].join(' · ')}
        </div>
      )}
      {actionError && (
        <div className="api-error" role="alert">
          {actionError}
        </div>
      )}
      {notice && <div className="tiny dim">{notice}</div>}
      {capabilities.data && !capabilities.data.sensitiveAgentTools.active && (
        <div className="alert" role="status">
          Sensitive agent tools are disabled: {capabilities.data.sensitiveAgentTools.reason}
        </div>
      )}

      <Card title={`Waiting for you (${pending.length})`}>
        {pending.length === 0 ? (
          <Empty>Nothing is waiting for a permission decision.</Empty>
        ) : (
          pending.map((execution) => (
            <div key={execution.id} className="mem-item">
              <div className="mem-head">
                <Badge tone={RISK_TONE[execution.risk]}>{execution.risk.replace(/_/g, ' ')}</Badge>
                <code className="mono">{execution.toolName}</code>
                <Badge>{execution.actor}</Badge>
                <span style={{ flex: 1 }} />
                <button
                  className="btn sm"
                  disabled={busy === execution.id}
                  onClick={() =>
                    void act(
                      execution.id,
                      () => api.approveTool(execution.id, false, null),
                      `Ran ${execution.toolName}.`,
                    )
                  }
                >
                  Allow once
                </button>
                {execution.actor === 'user' && execution.risk !== 'destructive' && (
                  <button
                    className="btn sm"
                    disabled={busy === execution.id}
                    title={
                      execution.projectId
                        ? 'Always allow this tool for this project'
                        : 'Always allow this tool everywhere'
                    }
                    onClick={() =>
                      void act(
                        execution.id,
                        () => api.approveTool(execution.id, true, execution.projectId),
                        `Ran ${execution.toolName} and remembered the permission.`,
                      )
                    }
                  >
                    Always allow
                  </button>
                )}
                <button
                  className="btn sm danger"
                  disabled={busy === execution.id}
                  onClick={() =>
                    void act(
                      execution.id,
                      // Refusing is the outcome, not a failure to report back.
                      () => api.denyTool(execution.id).then(() => undefined),
                      `Refused ${execution.toolName}.`,
                    )
                  }
                >
                  Refuse
                </button>
              </div>
              <div className="tiny dim">{execution.reason}</div>
              <pre className="mem-content">{preview(execution.input)}</pre>
              <div className="mem-meta">
                <span>asked {new Date(execution.requestedAt).toLocaleString()}</span>
                {execution.projectId && (
                  <span>project {projectLabel(projects, execution.projectId)}</span>
                )}
                {execution.jobId && <span>job {execution.jobId.slice(-6)}</span>}
              </div>
            </div>
          ))
        )}
      </Card>

      <Card title={`Standing permissions (${grants.data?.length ?? 0})`}>
        <p className="tiny dim">
          An "always allow" turns a confirmation into an immediate run for one tool in one context.
          It can never authorise a destructive action, and it can never give an agent something the
          policy refuses.
        </p>
        {(grants.data ?? []).length === 0 ? (
          <Empty>No standing permissions. Every confirmation is asked each time.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>For</th>
                  <th>Scope</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(grants.data ?? []).map((grant) => (
                  <tr key={grant.id}>
                    <td>
                      <code className="mono">{grant.toolName}</code>
                    </td>
                    <td>{grant.actor}</td>
                    <td className="tiny dim">{projectLabel(projects, grant.projectId)}</td>
                    <td className="tiny dim">
                      {grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : 'never'}
                    </td>
                    <td>
                      <button
                        className="btn sm danger"
                        disabled={busy === grant.id}
                        onClick={() =>
                          void act(
                            grant.id,
                            () => api.revokeToolGrant(grant.id),
                            `Revoked the standing permission for ${grant.toolName}.`,
                          )
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="History">
        {executions.length === 0 ? (
          <Empty>No tool has been run yet.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Risk</th>
                  <th>Asked by</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {executions.map((execution) => (
                  <tr key={execution.id}>
                    <td>
                      <code className="mono">{execution.toolName}</code>
                    </td>
                    <td className="tiny dim">{execution.risk.replace(/_/g, ' ')}</td>
                    <td className="tiny dim">{execution.actor}</td>
                    <td>
                      <Badge tone={STATUS_TONE[execution.status]}>
                        {execution.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="tiny dim">{execution.error ?? execution.reason}</td>
                    <td className="tiny dim nowrap">
                      {new Date(execution.requestedAt).toLocaleString()}
                      {execution.durationMs !== null && ` · ${execution.durationMs}ms`}
                    </td>
                    <td>
                      {(execution.status === 'interrupted' ||
                        execution.status === 'timed_out' ||
                        execution.status === 'expired' ||
                        execution.status === 'failed') &&
                        execution.inputValidated && (
                          <button
                            className="btn sm"
                            disabled={busy === execution.id}
                            title={
                              execution.effectUnknown
                                ? 'Jarvis cannot tell whether this action already took effect. ' +
                                  'Re-issuing it may do it twice.'
                                : 'Re-issue this action. It goes through the policy again.'
                            }
                            onClick={() =>
                              void act(
                                execution.id,
                                () => api.retryTool(execution.id),
                                `Re-issued ${execution.toolName}.`,
                              )
                            }
                          >
                            {execution.effectUnknown ? 'Re-issue anyway' : 'Re-issue'}
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What Jarvis can do">
        <p className="tiny dim">
          Every tool is classified by risk, and the classification is what decides whether it runs,
          asks, or is refused. Shown for you, in {projectId ? 'the selected project' : 'no project'}
          .
        </p>
        {(catalog.data ?? []).length === 0 ? (
          <Empty>No tools are registered.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Risk</th>
                  <th>For you</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {(catalog.data ?? []).map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <code className="mono">{tool.name}</code>
                    </td>
                    <td>
                      <Badge tone={RISK_TONE[tool.risk]}>{tool.risk.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="tiny dim">{DECISION_LABEL[tool.decision]}</td>
                    <td className="tiny dim">{tool.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
