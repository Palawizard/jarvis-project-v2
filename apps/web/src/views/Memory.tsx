import { useEffect, useState } from 'react';
import { api, type JarvisEvent, type Memory, type Project } from '../api.ts';
import { useAsync } from '../hooks.ts';
import { Badge, Card, Empty, MemoryCard } from '../components.tsx';

const KINDS = [
  'preference',
  'fact',
  'constraint',
  'decision',
  'project_knowledge',
  'episode',
  'procedure',
  'unresolved',
  'correction',
  'other',
];

/**
 * "What does Jarvis currently know?"
 *
 * The point of this view is control and legibility: every memory shows its
 * provenance, whether it superseded something, and how often it has actually
 * been used.
 */
export function MemoryView({
  projects,
  lastEvent,
}: {
  projects: Project[];
  lastEvent: JarvisEvent | null;
}) {
  const [scope, setScope] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [semantic, setSemantic] = useState<Array<{
    memory: Memory;
    score: number;
    reason: string;
  }> | null>(null);
  const [inspect, setInspect] = useState<Memory | null>(null);

  const list = useAsync(
    () =>
      api.memory({
        ...(scope ? { scope } : {}),
        ...(scopeId ? { scopeId } : {}),
        ...(kind ? { kind } : {}),
        status,
        ...(search && !semantic ? { search } : {}),
        limit: '200',
      }),
    [scope, scopeId, kind, status, semantic ? '' : search],
  );

  useEffect(() => {
    if (lastEvent?.type.startsWith('memory.')) list.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  const runSemantic = async () => {
    if (!search.trim()) return setSemantic(null);
    setSemantic(await api.searchMemory(search.trim(), scopeId || null));
  };

  const editMemory = async (memory: Memory) => {
    const content = prompt('Update this memory', memory.content)?.trim();
    if (!content || content === memory.content) return;
    try {
      await api.correctMemory(memory.id, content);
      setSemantic(null);
      list.reload();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  };

  const items = semantic ? semantic.map((s) => s.memory) : (list.data?.items ?? []);
  const reasons = new Map(
    semantic?.map((s) => [s.memory.id, `${s.score.toFixed(3)} — ${s.reason}`]) ?? [],
  );

  return (
    <div className="page">
      <AddMemory
        projects={projects}
        onAdded={() => {
          setSemantic(null);
          list.reload();
        }}
      />

      <div className="filters">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSemantic(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSemantic();
          }}
          placeholder="Search memory…"
          style={{ minWidth: 240 }}
          aria-label="Search memory"
        />
        <button className="btn" onClick={() => void runSemantic()} disabled={!search.trim()}>
          Rank by relevance
        </button>
        {semantic && (
          <button className="btn sm" onClick={() => setSemantic(null)}>
            Clear ranking
          </button>
        )}
        <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope filter">
          <option value="">All scopes</option>
          <option value="user">User</option>
          <option value="project">Project</option>
          <option value="session">Session</option>
          <option value="procedure">Procedure</option>
        </select>
        <select
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
          aria-label="Project filter"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind filter">
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status filter"
        >
          <option value="active">Active</option>
          <option value="superseded">Superseded</option>
          <option value="deleted">Deleted</option>
          <option value="expired">Expired</option>
          <option value="all">All</option>
        </select>
      </div>

      {semantic && (
        <div className="small dim" style={{ marginBottom: 10 }}>
          Showing what retrieval would actually return for this query — the same ranking a job's
          context pack uses. Local only: no model call.
        </div>
      )}

      <Card
        title={`${items.length} ${semantic ? 'ranked' : 'stored'} ${items.length === 1 ? 'memory' : 'memories'}`}
      >
        {items.length === 0 ? (
          <Empty>{list.loading ? 'Loading…' : 'Nothing here.'}</Empty>
        ) : (
          <div className="grid" style={{ gap: 8 }}>
            {items.map((m) => (
              <div key={m.id}>
                {reasons.has(m.id) && (
                  <div className="tiny faint" style={{ marginBottom: 2 }}>
                    {reasons.get(m.id)}
                  </div>
                )}
                <MemoryCard
                  memory={m}
                  onPin={(mem) => void api.pinMemory(mem.id, !mem.pinned).then(() => list.reload())}
                  onEdit={(mem) => void editMemory(mem)}
                  onForget={(mem) => {
                    if (
                      confirm('Forget this memory? It stops being retrievable but stays auditable.')
                    ) {
                      void api.deleteMemory(mem.id).then(() => list.reload());
                    }
                  }}
                  onInspect={setInspect}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      {inspect && <Provenance memory={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

function Provenance({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const detail = useAsync(() => api.memoryOne(memory.id), [memory.id]);
  return (
    <Card
      title="Provenance"
      actions={
        <button className="btn sm" onClick={onClose}>
          Close
        </button>
      }
    >
      <table>
        <tbody>
          <tr>
            <td className="dim small">ID</td>
            <td className="mono tiny">{memory.id}</td>
          </tr>
          <tr>
            <td className="dim small">Scope</td>
            <td>
              {memory.scope}
              {memory.scopeId ? ` / ${memory.scopeId}` : ''}
            </td>
          </tr>
          <tr>
            <td className="dim small">Source</td>
            <td>{memory.sourceType}</td>
          </tr>
          <tr>
            <td className="dim small">Source refs</td>
            <td className="mono tiny">
              {Object.entries(memory.sourceRef ?? {}).map(([k, v]) => (
                <div key={k}>
                  {k}: {String(v)}
                </div>
              ))}
              {Object.keys(memory.sourceRef ?? {}).length === 0 && '—'}
            </td>
          </tr>
          <tr>
            <td className="dim small">Created</td>
            <td className="small">{new Date(memory.createdAt).toLocaleString()}</td>
          </tr>
          <tr>
            <td className="dim small">Updated</td>
            <td className="small">{new Date(memory.updatedAt).toLocaleString()}</td>
          </tr>
          <tr>
            <td className="dim small">Last used</td>
            <td className="small">
              {memory.lastAccessedAt
                ? `${new Date(memory.lastAccessedAt).toLocaleString()} (${memory.accessCount}×)`
                : 'never'}
            </td>
          </tr>
          {memory.validUntil && (
            <tr>
              <td className="dim small">Expires</td>
              <td className="small">{new Date(memory.validUntil).toLocaleString()}</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail.data?.supersedes && (
        <>
          <h3 style={{ marginTop: 16 }}>Replaced</h3>
          <MemoryCard memory={detail.data.supersedes} />
        </>
      )}
      {detail.data?.supersededBy && (
        <>
          <h3 style={{ marginTop: 16 }}>Replaced by</h3>
          <MemoryCard memory={detail.data.supersededBy} />
        </>
      )}
      {Object.keys(memory.metadata ?? {}).length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Metadata</h3>
          <pre>{JSON.stringify(memory.metadata, null, 2)}</pre>
        </>
      )}
    </Card>
  );
}

function AddMemory({ projects, onAdded }: { projects: Project[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [subject, setSubject] = useState('');
  const [scope, setScope] = useState('user');
  const [scopeId, setScopeId] = useState('');
  const [kind, setKind] = useState('preference');
  const [message, setMessage] = useState<string | null>(null);

  if (!open) {
    return (
      <div style={{ marginBottom: 14 }}>
        <button className="btn primary" onClick={() => setOpen(true)}>
          Add a memory
        </button>
      </div>
    );
  }

  const submit = async () => {
    if (!content.trim()) return;
    const result = await api.addMemory({
      content: content.trim(),
      scope,
      scopeId: scope === 'project' ? scopeId || null : null,
      kind,
      subject: subject.trim() || null,
    } as never);
    if (result.status === 'stored') {
      setContent('');
      setSubject('');
      setMessage('Stored.');
      onAdded();
    } else if (result.status === 'duplicate') {
      setMessage('Already known — no duplicate created.');
    } else {
      setMessage(`Rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
    }
  };

  return (
    <Card
      title="Add a memory"
      actions={
        <button className="btn sm" onClick={() => setOpen(false)}>
          Close
        </button>
      }
    >
      <div className="grid" style={{ gap: 10 }}>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="A durable fact, preference or constraint…"
          aria-label="Memory content"
        />
        <div className="row wrap">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ width: 130 }}
            aria-label="Scope"
          >
            <option value="user">User</option>
            <option value="project">Project</option>
          </select>
          {scope === 'project' && (
            <select
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              style={{ width: 180 }}
              aria-label="Project"
            >
              <option value="">Pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            style={{ width: 170 }}
            aria-label="Kind"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="subject key (optional, e.g. preference.editor)"
            style={{ flex: 1, minWidth: 200 }}
            aria-label="Subject key"
          />
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={!content.trim() || (scope === 'project' && !scopeId)}
          >
            Store
          </button>
        </div>
        {message && (
          <div className="small">
            <Badge>{message}</Badge>
          </div>
        )}
        <div className="tiny faint">
          A subject key makes later corrections supersede this one automatically. Credential-like
          content is rejected outright.
        </div>
      </div>
    </Card>
  );
}
