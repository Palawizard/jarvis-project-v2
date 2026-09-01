import React, { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { JarvisEvent, JobStage, Memory } from './api.ts';

export function Badge({
  tone,
  children,
}: {
  tone?: 'ok' | 'warn' | 'err' | 'run' | 'accent';
  children: ReactNode;
}) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
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

/**
 * Native modal semantics for a <dialog>: backdrop, focus trap and Escape all
 * come from showModal(), which a bare `<dialog open>` does not give you.
 * Closing on unmount keeps the top layer from outliving the component.
 */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);
  return ref;
}

/**
 * Keyboard equivalence for a table row that behaves as a link.
 *
 * A `<tr onClick>` alone is reachable by mouse only: a keyboard or
 * screen-reader user can tab to the controls inside the row but has no way to
 * open the row itself.
 */
export function rowActivation(label: string, open: () => void) {
  return {
    role: 'link',
    tabIndex: 0,
    'aria-label': label,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      open();
    },
  } as const;
}

export function ConfirmDialog({
  open,
  title,
  description,
  removes = [],
  preserves = [],
  confirmLabel = 'Confirm',
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  removes?: string[];
  preserves?: string[];
  confirmLabel?: string;
  busy?: boolean;
  /** Rendered INSIDE the dialog: showModal() makes everything else inert. */
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useModalDialog(open);
  return (
    <dialog ref={ref} className="confirm-dialog" data-testid="confirm-dialog" onCancel={onCancel}>
      <h2>{title}</h2>
      <p>{description}</p>
      {removes.length > 0 && (
        <section>
          <strong>Will remove</strong>
          <ul>
            {removes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {preserves.length > 0 && (
        <section>
          <strong>Will preserve</strong>
          <ul>
            {preserves.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="tiny faint">This action is irreversible.</p>
      {error && (
        <div className="api-error" role="alert">
          {error}
        </div>
      )}
      <div className="row dialog-actions">
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/**
 * A person's own words, rendered as text and nothing else.
 *
 * Never Markdown, never HTML: React escapes the string, so `&`, `<`, `>`,
 * quotes and any HTML entity the user typed are shown exactly as typed rather
 * than decoded or interpreted. `pre-wrap` (see `.plain-text`) keeps the line
 * breaks of a pasted multi-line request, which a bare `<p>` collapsed into one
 * run-on paragraph — the long feature request that prompted this change was
 * unreadable in the transcript for exactly that reason.
 */
export function PlainText({ children }: { children: string }) {
  return <p className="plain-text">{children}</p>;
}

/** Safe, dependency-free Markdown for assistant prose. Raw HTML is always text. */
export function Markdown({ children }: { children: string }) {
  const blocks = children.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const firstBreak = block.indexOf('\n');
          const language = block.slice(3, firstBreak < 0 ? 3 : firstBreak).trim();
          const code = (firstBreak < 0 ? '' : block.slice(firstBreak + 1, -3)).replace(/\n$/, '');
          return (
            <div className="code-block" key={index}>
              <div className="code-head">
                <span>{language || 'code'}</span>
                <button className="btn sm" onClick={() => void navigator.clipboard.writeText(code)}>
                  Copy
                </button>
              </div>
              <pre>
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return <MarkdownText key={index} text={block} />;
      })}
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let nodeKey = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]?.length ?? 2, 4);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      nodes.push(<Tag key={nodeKey++}>{inline(heading[2] ?? '')}</Tag>);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? ''))
        quoted.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      nodes.push(<blockquote key={nodeKey++}>{inline(quoted.join(' '))}</blockquote>);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && pattern.test(lines[i] ?? ''))
        items.push((lines[i++] ?? '').replace(pattern, ''));
      const List = ordered ? 'ol' : 'ul';
      nodes.push(
        <List key={nodeKey++}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (line.includes('|') && isMarkdownTableDelimiter(lines[i + 1] ?? '', splitRow(line).length)) {
      const rows: string[][] = [];
      rows.push(splitRow(line));
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|'))
        rows.push(splitRow(lines[i++] ?? ''));
      nodes.push(
        <div className="table-scroll" key={nodeKey++}>
          <table>
            <thead>
              <tr>
                {rows[0]?.map((cell, n) => (
                  <th key={n}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, n) => (
                <tr key={n}>
                  {row.map((cell, c) => (
                    <td key={c}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^(#{1,6})\s|^>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+/.test(lines[i] ?? '')
    )
      paragraph.push(lines[i++] ?? '');
    nodes.push(<p key={nodeKey++}>{inline(paragraph.join('\n'))}</p>);
  }
  return <>{nodes}</>;
}

const splitRow = (value: string) =>
  value
    .replace(/^\s*\||\|\s*$/g, '')
    .split('|')
    .map((cell) => cell.trim());

export function isMarkdownTableDelimiter(row: string, expectedCells: number): boolean {
  const cells = splitRow(row);
  return (
    row.includes('|') &&
    cells.length === expectedCells &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      const href = /^(https?:|mailto:)/i.test(link[2] ?? '') ? link[2] : '#';
      return (
        <a key={index} href={href} target={href === '#' ? undefined : '_blank'} rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
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
  events = [],
}: {
  stage: JobStage;
  status: string;
  skipped?: JobStage[];
  events?: JarvisEvent[];
}) {
  // `fixing` belongs to the verify loop; show verification as the active step.
  const effective = stage === 'fixing' ? 'verifying' : stage;
  const currentIndex = ORDER.indexOf(effective as JobStage);
  const transitions = events.filter((event) => event.type === 'job.stage.changed');
  const reached = new Set(
    transitions.map((event) => event.payload?.to).filter((value): value is JobStage => !!value),
  );
  const stoppedAt =
    stage === 'failed' || stage === 'cancelled'
      ? (transitions.findLast((event) => event.payload?.to === stage)?.payload?.from as
          JobStage | undefined)
      : undefined;

  return (
    <div className="pipeline">
      {ORDER.map((s, i) => {
        const isSkipped = skipped.includes(s);
        let state: string;
        let icon: string;
        if (isSkipped) {
          state = 'skipped';
          icon = '–';
        } else if (stoppedAt === s) {
          state = 'failed';
          icon = stage === 'cancelled' ? '■' : '✕';
        } else if (reached.has(s) && s !== effective) {
          state = 'done';
          icon = '✓';
        } else if (currentIndex >= 0 && i < currentIndex) {
          state = 'done';
          icon = '✓';
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
      {stage === 'fixing' && (
        <div className="tiny dim" style={{ paddingLeft: 34 }}>
          fix cycle in progress
        </div>
      )}
    </div>
  );
}

export function StageBadge({ stage }: { stage: JobStage }) {
  const tone =
    stage === 'completed'
      ? 'ok'
      : stage === 'failed'
        ? 'err'
        : stage === 'cancelled'
          ? undefined
          : stage === 'awaiting_user'
            ? 'warn'
            : stage === 'queued'
              ? undefined
              : 'run';
  return <Badge tone={tone}>{stage.replace('_', ' ')}</Badge>;
}

export function MemoryCard({
  memory,
  onPin,
  onEdit,
  onForget,
  onInspect,
}: {
  memory: Memory;
  onPin?: (m: Memory) => void;
  onEdit?: (m: Memory) => void;
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
        {onEdit && memory.status === 'active' && (
          <button className="btn sm" onClick={() => onEdit(memory)}>
            Edit
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
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
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
