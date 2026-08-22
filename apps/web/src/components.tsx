import type { ReactNode } from 'react';
import type { JobStage, Memory } from './api.ts';

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'err' | 'run' | 'accent'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || actions) && (
        <div className="spread" style={{ marginBottom: 12 }}>
          {title && <h3 style={{ margin: 0 }}>{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const STAGE_LABELS: Record<string, string> = {
  planning: 'Planning',
  implementing: 'Implementation',
  verifying: 'Verification',
  reviewing: 'Review',
  visual_qa: 'Visual QA',
};

const ORDER: JobStage[] = ['planning', 'implementing', 'verifying', 'reviewing', 'visual_qa'];

/**
 * Pipeline progress derived strictly from the job's real stage and recorded
 * artifacts. Nothing here is optimistic: a stage is only "done" if the job
 * actually moved past it.
 */
export function Pipeline({
  stage,
  status,
  skipped = [],
}: {
  stage: JobStage;
  status: string;
  skipped?: JobStage[];
}) {
  const terminal = ['completed', 'failed', 'cancelled', 'awaiting_user'].includes(stage);
  // `fixing` belongs to the verify loop; show verification as the active step.
  const effective = stage === 'fixing' ? 'verifying' : stage;
  const currentIndex = ORDER.indexOf(effective as JobStage);

  return (
    <div className="pipeline">
      {ORDER.map((s, i) => {
        const isSkipped = skipped.includes(s);
        let state: string;
        let icon: string;
        if (isSkipped) {
          state = 'skipped';
          icon = '–';
        } else if (stage === 'failed' && i === currentIndex) {
          state = 'failed';
          icon = '✕';
        } else if (terminal || (currentIndex >= 0 && i < currentIndex)) {
          const reached = terminal ? true : i < currentIndex;
          state = reached ? 'done' : 'pending';
          icon = reached ? '✓' : '○';
        } else if (i === currentIndex) {
          state = 'current';
          icon = '●';
        } else {
          state = 'pending';
          icon = '○';
        }
        return (
          <div key={s} className={`stage ${state}`}>
            <span className={`stage-icon ${state === 'current' ? 'pulse' : ''}`}>{icon}</span>
            <span className="stage-name">{STAGE_LABELS[s] ?? s}</span>
            {state === 'current' && <span className="tiny dim">{status}</span>}
            {isSkipped && <span className="tiny faint">not applicable</span>}
          </div>
        );
      })}
      {stage === 'fixing' && <div className="tiny dim" style={{ paddingLeft: 34 }}>fix cycle in progress</div>}
    </div>
  );
}

export function StageBadge({ stage }: { stage: JobStage }) {
  const tone =
    stage === 'completed' ? 'ok'
    : stage === 'failed' ? 'err'
    : stage === 'cancelled' ? undefined
    : stage === 'awaiting_user' ? 'warn'
    : stage === 'queued' ? undefined
    : 'run';
  return <Badge tone={tone}>{stage.replace('_', ' ')}</Badge>;
}

export function MemoryCard({
  memory,
  onPin,
  onForget,
  onInspect,
}: {
  memory: Memory;
  onPin?: (m: Memory) => void;
  onForget?: (m: Memory) => void;
  onInspect?: (m: Memory) => void;
}) {
  return (
    <div className={`mem-item ${memory.status !== 'active' ? 'superseded' : ''}`}>
      <div className="mem-head">
        <Badge tone="accent">{memory.scope}</Badge>
        <Badge>{memory.kind}</Badge>
        {memory.subject && <code className="tiny dim">{memory.subject}</code>}
        {memory.pinned && <Badge tone="warn">pinned</Badge>}
        {memory.status !== 'active' && <Badge tone="err">{memory.status}</Badge>}
        <span style={{ flex: 1 }} />
        {onPin && (
          <button className="btn sm" onClick={() => onPin(memory)}>
            {memory.pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        {onInspect && (
          <button className="btn sm" onClick={() => onInspect(memory)}>
            Provenance
          </button>
        )}
        {onForget && memory.status === 'active' && (
          <button className="btn sm danger" onClick={() => onForget(memory)}>
            Forget
          </button>
        )}
      </div>
      <div className="mem-content" style={{ whiteSpace: 'pre-wrap' }}>
        {memory.content}
      </div>
      <div className="mem-meta">
        <span>importance {memory.importance.toFixed(2)}</span>
        <span>confidence {memory.confidence.toFixed(2)}</span>
        <span>source {memory.sourceType}</span>
        {memory.sourceRef?.jobId && <span>job {memory.sourceRef.jobId.slice(-6)}</span>}
        <span>used {memory.accessCount}×</span>
        <span>{new Date(memory.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}

/** Minimal diff colouring. A full syntax highlighter is not worth the payload. */
export function Diff({ text }: { text: string }) {
  return (
    <pre>
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
