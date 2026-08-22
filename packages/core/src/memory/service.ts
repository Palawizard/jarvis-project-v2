import type { Db } from '../db/index.js';
import { parseJson, transaction } from '../db/index.js';
import { getConfig, type JarvisConfig } from '../config.js';
import { newId, nowIso, sha256 } from '../ids.js';
import { createLogger } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import { scanForSecrets } from './secrets.js';
import { jaccard, normaliseForHash, scoreCandidate } from './policy.js';
import {
  blobToVector,
  cosine,
  getEmbeddingProvider,
  vectorToBlob,
  NULL_ANCHORS,
  type EmbeddingProvider,
} from './embeddings.js';
import type {
  Memory,
  MemoryInput,
  MemoryKind,
  MemoryScope,
  RememberOutcome,
  RetrievedMemory,
  RetrieveOptions,
  ScopeSelector,
} from './types.js';

const log = createLogger('memory');

type Row = Record<string, unknown>;

function rowToMemory(row: Row): Memory {
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scopeId: (row.scope_id as string) ?? null,
    kind: row.kind as MemoryKind,
    subject: (row.subject as string) ?? null,
    content: row.content as string,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    sourceType: row.source_type as Memory['sourceType'],
    sourceRef: parseJson(row.source_ref as string, {}),
    status: row.status as Memory['status'],
    supersedes: (row.supersedes as string) ?? null,
    supersededBy: (row.superseded_by as string) ?? null,
    pinned: Number(row.pinned) === 1,
    sensitivity: row.sensitivity as Memory['sensitivity'],
    contentHash: row.content_hash as string,
    metadata: parseJson(row.metadata as string, {}),
    validFrom: (row.valid_from as string) ?? null,
    validUntil: (row.valid_until as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastAccessedAt: (row.last_accessed_at as string) ?? null,
    accessCount: Number(row.access_count ?? 0),
  };
}

const SELECT_MEMORY = `SELECT id, scope, scope_id, kind, subject, content, importance, confidence,
  source_type, source_ref, status, supersedes, superseded_by, pinned, sensitivity, content_hash,
  metadata, valid_from, valid_until, created_at, updated_at, last_accessed_at, access_count
  FROM memories`;

/** Scope ranking used when fusing results from several scopes. */
const SCOPE_PRIORITY: Record<MemoryScope, number> = {
  session: 1.0,
  project: 0.95,
  user: 0.9,
  procedure: 0.8,
  agent: 0.6,
};

export interface MemoryServiceDeps {
  db: Db;
  bus?: EventBus;
  config?: JarvisConfig;
  embeddings?: EmbeddingProvider;
}

export class MemoryService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly config: JarvisConfig;
  private readonly embeddings: EmbeddingProvider;
  /** Set once we learn embeddings are unusable, so we stop retrying per query. */
  private semanticDisabled = false;
  /** Null-baseline anchor vectors, embedded lazily once per process. */
  private anchorVectors: Float32Array[] | undefined;

  constructor(deps: MemoryServiceDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.config = deps.config ?? getConfig();
    this.embeddings = deps.embeddings ?? getEmbeddingProvider(this.config);
  }

  // ------------------------------------------------------------------ write --

  /**
   * The single durable-write path. Runs the full pipeline:
   *   secret screen -> score -> dedupe -> supersede -> persist -> index.
   *
   * Never calls an LLM. Callers that need semantic extraction do it upstream,
   * piggybacked on a model call the task already required.
   */
  async remember(input: MemoryInput): Promise<RememberOutcome> {
    const content = input.content.trim();
    if (!content) return { status: 'rejected', reason: 'empty content' };

    // --- Stage: secret screening (hard gate, applies even to explicit requests) --
    const scan = scanForSecrets(content);
    if (!scan.clean) {
      this.bus?.emit({
        type: 'memory.rejected',
        payload: { reason: 'secret_detected', patterns: scan.matches },
      });
      log.warn('memory rejected: credential-like content', { patterns: scan.matches });
      return {
        status: 'rejected',
        reason: 'secret_detected',
        detail: `matched ${scan.matches.join(', ')}`,
      };
    }

    if (content.length > this.config.memory.maxContentChars) {
      return {
        status: 'rejected',
        reason: 'too_large',
        detail: `content exceeds ${this.config.memory.maxContentChars} characters; summarise before storing`,
      };
    }

    // --- Stage B: candidate scoring -------------------------------------------
    const scored = scoreCandidate(input, { minImportance: this.config.memory.minImportance });
    this.bus?.emit({
      type: 'memory.candidate',
      payload: { kind: input.kind, scope: input.scope, accepted: scored.accept, reason: scored.reason },
    });
    if (!scored.accept) {
      return { status: 'rejected', reason: 'below_importance_threshold', detail: scored.reason };
    }

    const scopeId = input.scopeId ?? null;
    const contentHash = sha256(`${input.scope}|${scopeId ?? ''}|${normaliseForHash(content)}`);

    // --- Stage C: deduplication ------------------------------------------------
    const exact = this.db
      .prepare(`${SELECT_MEMORY} WHERE content_hash = ? AND status = 'active' LIMIT 1`)
      .get(contentHash) as Row | undefined;
    if (exact) {
      const memory = rowToMemory(exact);
      // Re-asserting a known fact is evidence of importance, not a reason to duplicate.
      this.db
        .prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?')
        .run(Math.min(1, memory.importance + 0.02), nowIso(), memory.id);
      return { status: 'duplicate', memory, reason: 'exact_hash' };
    }

    const nearDuplicate = await this.findNearDuplicate(
      input.scope,
      scopeId,
      input.kind,
      content,
      input.subject ?? null,
    );
    if (nearDuplicate?.match) {
      this.db
        .prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?')
        .run(Math.min(1, nearDuplicate.match.memory.importance + 0.02), nowIso(), nearDuplicate.match.memory.id);
      return { status: 'duplicate', memory: nearDuplicate.match.memory, reason: nearDuplicate.match.reason };
    }

    // --- Supersession: a new value for a known structured key replaces the old --
    let supersededId: string | undefined;
    if (input.subject) {
      const prior = this.db
        .prepare(
          `${SELECT_MEMORY} WHERE scope = ? AND ${scopeId === null ? 'scope_id IS NULL' : 'scope_id = ?'}
           AND subject = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...(scopeId === null ? [input.scope, input.subject] : [input.scope, scopeId, input.subject])) as
        | Row
        | undefined;
      if (prior) supersededId = (prior as Row).id as string;
    }

    // --- Stage E: persist ------------------------------------------------------
    const now = nowIso();
    const id = newId('mem');
    const memory: Memory = {
      id,
      scope: input.scope,
      scopeId,
      kind: input.kind,
      subject: input.subject ?? null,
      content,
      importance: scored.importance,
      confidence: input.confidence ?? 0.8,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef ?? {},
      status: 'active',
      supersedes: supersededId ?? null,
      supersededBy: null,
      pinned: input.pinned ?? false,
      sensitivity: 'normal',
      contentHash,
      metadata: input.metadata ?? {},
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };

    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO memories (id, scope, scope_id, kind, subject, content, importance, confidence,
            source_type, source_ref, status, supersedes, superseded_by, pinned, sensitivity,
            content_hash, metadata, valid_from, valid_until, created_at, updated_at, access_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          memory.id,
          memory.scope,
          memory.scopeId,
          memory.kind,
          memory.subject,
          memory.content,
          memory.importance,
          memory.confidence,
          memory.sourceType,
          JSON.stringify(memory.sourceRef),
          memory.status,
          memory.supersedes,
          null,
          memory.pinned ? 1 : 0,
          memory.sensitivity,
          memory.contentHash,
          JSON.stringify(memory.metadata),
          memory.validFrom,
          memory.validUntil,
          memory.createdAt,
          memory.updatedAt,
        );

      if (supersededId) {
        // History is preserved: the old row stays inspectable, just not retrievable.
        this.db
          .prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`)
          .run(memory.id, now, supersededId);
      }
    });

    if (supersededId) {
      this.bus?.emit({
        type: 'memory.superseded',
        payload: { memoryId: supersededId, supersededBy: memory.id, subject: memory.subject },
      });
    }
    this.bus?.emit({
      type: 'memory.stored',
      payload: { memoryId: memory.id, scope: memory.scope, kind: memory.kind, subject: memory.subject },
    });

    // Reuse the vector the dedupe probe already computed for this exact text.
    // If embeddings are off or failed, the memory is simply lexical-only.
    if (nearDuplicate.vector) this.storeVector(memory, nearDuplicate.vector);

    return supersededId ? { status: 'stored', memory, supersededId } : { status: 'stored', memory };
  }

  /** Store several memories, embedding them in one batch. */
  async rememberMany(inputs: MemoryInput[]): Promise<RememberOutcome[]> {
    const outcomes: RememberOutcome[] = [];
    for (const input of inputs) outcomes.push(await this.remember(input));
    const stored = outcomes.filter((o) => o.status === 'stored').map((o) => o.memory);
    if (stored.length > 1) await this.indexEmbeddings(stored).catch(() => undefined);
    return outcomes;
  }

  /**
   * Stage C. Returns the duplicate if there is one, plus the vector computed for
   * the candidate text so the caller can reuse it when indexing — embedding the
   * same string twice per write would double the only expensive step in the path.
   */
  private async findNearDuplicate(
    scope: MemoryScope,
    scopeId: string | null,
    kind: MemoryKind,
    content: string,
    subject: string | null,
  ): Promise<{ match: { memory: Memory; reason: string } | null; vector: Float32Array | null }> {
    // Only ever compares within the same scope+kind: a project fact can never be
    // deduped against an unrelated project's fact.
    const rows = this.db
      .prepare(
        `${SELECT_MEMORY} WHERE scope = ? AND ${scopeId === null ? 'scope_id IS NULL' : 'scope_id = ?'}
         AND kind = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(...(scopeId === null ? [scope, kind] : [scope, scopeId, kind])) as Row[];

    // Two different structured keys are two different facts, however similar the
    // wording. Supersession — not dedupe — is what resolves a same-key conflict.
    const candidates = rows
      .map(rowToMemory)
      .filter((c) => !(subject && c.subject && c.subject !== subject));

    // Cheap lexical pass first: a hit here skips the model entirely.
    for (const candidate of candidates) {
      const lex = jaccard(content, candidate.content);
      if (lex >= this.config.memory.dedupeLexical) {
        return { match: { memory: candidate, reason: `lexical_similarity ${lex.toFixed(2)}` }, vector: null };
      }
    }

    if (this.semanticDisabled || !this.config.memory.embeddingsEnabled) return { match: null, vector: null };
    try {
      // Always embed, even with no candidates: this single vector serves both the
      // duplicate check and the index write, so a write costs exactly one
      // embedding and needs no unawaited background task.
      const [vector] = await this.embeddings.embedPassages([
        subject ? `${subject}: ${content}` : content,
      ]);
      if (!vector) return { match: null, vector: null };
      for (const candidate of candidates) {
        const vec = this.loadVector(candidate.id);
        if (!vec || vec.length !== vector.length) continue;
        const sim = cosine(vector, vec);
        if (sim >= this.config.memory.dedupeSimilarity) {
          return { match: { memory: candidate, reason: `semantic_similarity ${sim.toFixed(2)}` }, vector };
        }
      }
      return { match: null, vector };
    } catch {
      this.semanticDisabled = true;
      return { match: null, vector: null };
    }
  }

  // ------------------------------------------------------------- embeddings --

  private embeddingText(memory: Memory): string {
    return memory.subject ? `${memory.subject}: ${memory.content}` : memory.content;
  }

  private loadVector(memoryId: string): Float32Array | null {
    const row = this.db
      .prepare('SELECT vector, model FROM memory_embeddings WHERE memory_id = ? AND model = ?')
      .get(memoryId, this.embeddings.id) as { vector: Uint8Array; model: string } | undefined;
    if (!row) return null;
    try {
      return blobToVector(row.vector);
    } catch {
      // Corrupted cache entry: drop it so it gets rebuilt rather than poisoning ranking.
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
      return null;
    }
  }

  private storeVector(memory: Memory, vector: Float32Array): void {
    const text = this.embeddingText(memory);
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, model, dim, text_hash, vector, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(memory_id) DO UPDATE SET
           model=excluded.model, dim=excluded.dim, text_hash=excluded.text_hash,
           vector=excluded.vector, created_at=excluded.created_at`,
      )
      .run(memory.id, this.embeddings.id, vector.length, sha256(text), vectorToBlob(vector), nowIso());
  }

  async indexEmbedding(memory: Memory): Promise<void> {
    await this.indexEmbeddings([memory]);
  }

  /** Batch-embed, skipping rows whose text hash already matches. */
  async indexEmbeddings(memories: Memory[]): Promise<void> {
    if (this.semanticDisabled || !this.config.memory.embeddingsEnabled || memories.length === 0) return;

    const pending: { memory: Memory; text: string; hash: string }[] = [];
    for (const memory of memories) {
      const text = this.embeddingText(memory);
      const hash = sha256(text);
      const existing = this.db
        .prepare('SELECT text_hash FROM memory_embeddings WHERE memory_id = ? AND model = ?')
        .get(memory.id, this.embeddings.id) as { text_hash: string } | undefined;
      if (existing?.text_hash === hash) continue; // unchanged text keeps its vector
      pending.push({ memory, text, hash });
    }
    if (pending.length === 0) return;

    try {
      const vectors = await this.embeddings.embedPassages(pending.map((p) => p.text));
      const now = nowIso();
      const stmt = this.db.prepare(
        `INSERT INTO memory_embeddings (memory_id, model, dim, text_hash, vector, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(memory_id) DO UPDATE SET
           model=excluded.model, dim=excluded.dim, text_hash=excluded.text_hash,
           vector=excluded.vector, created_at=excluded.created_at`,
      );
      transaction(this.db, () => {
        pending.forEach((p, i) => {
          const vec = vectors[i];
          if (!vec) return;
          stmt.run(p.memory.id, this.embeddings.id, vec.length, p.hash, vectorToBlob(vec), now);
        });
      });
    } catch (error) {
      this.semanticDisabled = true;
      log.warn('embedding indexing failed; semantic retrieval disabled for this process', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Embed every active memory that lacks a current vector. Safe to re-run. */
  async reindexAll(): Promise<{ indexed: number; skipped: number }> {
    const rows = this.db.prepare(`${SELECT_MEMORY} WHERE status = 'active'`).all() as Row[];
    const memories = rows.map(rowToMemory);
    const before = this.countEmbeddings();
    await this.indexEmbeddings(memories);
    const after = this.countEmbeddings();
    return { indexed: after - before, skipped: memories.length - (after - before) };
  }

  private countEmbeddings(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE model = ?')
      .get(this.embeddings.id) as { n: number };
    return Number(row.n);
  }

  // ------------------------------------------------------------------ read ---

  get(id: string): Memory | null {
    const row = this.db.prepare(`${SELECT_MEMORY} WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToMemory(row) : null;
  }

  /**
   * Scope-filtered, budget-free retrieval with fused lexical + semantic ranking.
   *
   * Step 1 scope filter, Step 2 BM25, Step 3 semantic, Step 4 fusion — see
   * docs/memory-retrieval.md. Never performs a network or LLM call.
   */
  async retrieve(options: RetrieveOptions): Promise<RetrievedMemory[]> {
    const at = options.at ?? nowIso();
    const limit = options.limit ?? 12;
    if (options.scopes.length === 0) return [];

    // ---- Step 1: scope filter (runs BEFORE ranking) --------------------------
    const candidates = this.candidatesForScopes(options.scopes, {
      kinds: options.kinds,
      includeInactive: options.includeInactive ?? false,
      at,
    });
    if (candidates.length === 0) return [];
    const byId = new Map(candidates.map((m) => [m.id, m]));

    // ---- Step 2: lexical (BM25) ----------------------------------------------
    const lexical = this.lexicalScores(options.query, byId);

    // ---- Step 3: semantic ----------------------------------------------------
    const semantic = options.lexicalOnly ? new Map<string, number>() : await this.semanticScores(options.query, candidates);

    // ---- Step 4: fusion ------------------------------------------------------
    const ranked = this.fuse(candidates, lexical, semantic, options.query, at);

    // ---- Step 5: diversity, then cut ----------------------------------------
    const selected = diversify(ranked, limit);

    this.touch(selected.map((r) => r.memory.id), at);
    this.bus?.emit({
      type: 'memory.retrieved',
      payload: {
        query: options.query,
        scopes: options.scopes,
        returned: selected.map((r) => ({ id: r.memory.id, score: Number(r.score.toFixed(4)), reason: r.reason })),
      },
    });
    return selected;
  }

  private candidatesForScopes(
    scopes: ScopeSelector[],
    opts: { kinds?: MemoryKind[]; includeInactive: boolean; at: string },
  ): Memory[] {
    const out: Memory[] = [];
    const seen = new Set<string>();
    for (const selector of scopes) {
      const params: (string | null)[] = [selector.scope];
      let sql = `${SELECT_MEMORY} WHERE scope = ?`;
      // A project scope with an id must never match another project's rows.
      if (selector.scopeId === undefined) {
        // caller did not constrain — allowed only for scopes that have no id
        sql += ' AND scope_id IS NULL';
      } else if (selector.scopeId === null) {
        sql += ' AND scope_id IS NULL';
      } else {
        sql += ' AND scope_id = ?';
        params.push(selector.scopeId);
      }
      if (!opts.includeInactive) {
        sql += ` AND status = 'active'`;
        // Temporal validity: expired or not-yet-valid memories never rank.
        sql += ' AND (valid_from IS NULL OR valid_from <= ?)';
        params.push(opts.at);
        sql += ' AND (valid_until IS NULL OR valid_until > ?)';
        params.push(opts.at);
      }
      if (opts.kinds?.length) {
        sql += ` AND kind IN (${opts.kinds.map(() => '?').join(',')})`;
        params.push(...opts.kinds);
      }
      sql += ' ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 500';
      for (const row of this.db.prepare(sql).all(...params) as Row[]) {
        const memory = rowToMemory(row);
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        out.push(memory);
      }
    }
    return out;
  }

  private lexicalScores(query: string, byId: Map<string, Memory>): Map<string, number> {
    const scores = new Map<string, number>();
    const match = toFtsQuery(query);
    if (!match) return scores;
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id AS id, bm25(memories_fts) AS rank
           FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200`,
        )
        .all(match) as Array<{ id: string; rank: number }>;
      // bm25() is negative, more negative = better. Map to (0,1].
      for (const row of rows) {
        if (!byId.has(row.id)) continue;
        scores.set(row.id, 1 / (1 + Math.exp(Number(row.rank))));
      }
    } catch (error) {
      log.debug('fts query failed', { query: match, error: String(error) });
    }
    return scores;
  }

  private async semanticScores(query: string, candidates: Memory[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    if (this.semanticDisabled || !this.config.memory.embeddingsEnabled) return scores;
    try {
      const queryVec = await this.embeddings.embedQuery(query);
      // ponytail: brute-force cosine over the scope-filtered candidate set.
      // Fine to five figures of memories; swap for sqlite-vec/HNSW past that.
      const raw: Array<{ id: string; sim: number }> = [];
      for (const memory of candidates) {
        const vec = this.loadVector(memory.id);
        if (!vec || vec.length !== queryVec.length) continue;
        raw.push({ id: memory.id, sim: cosine(queryVec, vec) });
      }
      const nullBaseline = await this.nullBaseline(queryVec);
      const calibrated = calibrateSemantic(raw, {
        absoluteFloor: this.config.memory.semanticFloor,
        margin: this.config.memory.semanticMargin,
        ...(nullBaseline ? { nullBaseline } : {}),
      });
      for (const [id, score] of calibrated) scores.set(id, score);
    } catch (error) {
      this.semanticDisabled = true;
      log.warn('semantic retrieval unavailable, using lexical only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return scores;
  }

  /**
   * Similarity statistics for this query against topically neutral text.
   * Embedded once per process; the cost is six short passages.
   */
  private async nullBaseline(queryVec: Float32Array): Promise<{ mean: number; stdev: number } | null> {
    try {
      this.anchorVectors ??= await this.embeddings.embedPassages([...NULL_ANCHORS]);
      const sims = this.anchorVectors
        .filter((v) => v.length === queryVec.length)
        .map((v) => cosine(queryVec, v));
      if (sims.length < 3) return null;
      const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
      const stdev = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
      return { mean, stdev };
    } catch {
      return null;
    }
  }

  private fuse(
    candidates: Memory[],
    lexical: Map<string, number>,
    semantic: Map<string, number>,
    query: string,
    at: string,
  ): RetrievedMemory[] {
    const queryFolded = normaliseForHash(query);
    const hasSemantic = semantic.size > 0;
    const nowMs = Date.parse(at);

    const results = candidates.map((memory) => {
      const lex = lexical.get(memory.id);
      const sem = semantic.get(memory.id);
      const subjectMatch = Boolean(
        memory.subject && queryFolded.includes(normaliseForHash(memory.subject)),
      );

      // Relevance: weight the two legs, or use whichever exists.
      let relevance: number;
      if (lex !== undefined && sem !== undefined) relevance = 0.45 * lex + 0.55 * sem;
      else if (sem !== undefined) relevance = hasSemantic ? 0.75 * sem : 0;
      else if (lex !== undefined) relevance = 0.7 * lex;
      else relevance = 0;

      if (subjectMatch) relevance += 0.35;

      // Quality priors. Deliberately smaller than relevance so an important but
      // irrelevant memory cannot outrank a relevant one.
      const scopePriority = SCOPE_PRIORITY[memory.scope];
      let score = relevance * scopePriority;
      score += 0.12 * memory.importance;
      score += 0.05 * memory.confidence;
      if (memory.pinned) score += 0.3;

      // Freshness only for time-bound kinds. Stable preferences must not decay.
      let recency: number | undefined;
      if (memory.kind === 'episode' || memory.kind === 'unresolved') {
        const ageDays = Math.max(0, (nowMs - Date.parse(memory.updatedAt)) / 86_400_000);
        recency = Math.exp(-ageDays / 45);
        score += 0.1 * recency;
      }

      const reason = [
        subjectMatch ? 'subject key match' : null,
        sem !== undefined ? `semantic ${sem.toFixed(2)}` : null,
        lex !== undefined ? `lexical ${lex.toFixed(2)}` : null,
        memory.pinned ? 'pinned' : null,
        `importance ${memory.importance.toFixed(2)}`,
        `scope ${memory.scope}`,
      ]
        .filter(Boolean)
        .join(', ');

      return {
        memory,
        score,
        signals: {
          ...(lex !== undefined ? { lexical: lex } : {}),
          ...(sem !== undefined ? { semantic: sem } : {}),
          subjectMatch,
          scopePriority,
          importance: memory.importance,
          confidence: memory.confidence,
          pinned: memory.pinned,
          ...(recency !== undefined ? { recency } : {}),
        },
        reason,
      } satisfies RetrievedMemory;
    });

    // Drop memories with no relevance signal at all — otherwise an empty query
    // would return the whole scope ordered by importance, which is exactly the
    // "dump everything" behaviour the design forbids.
    return results
      .filter((r) => r.signals.lexical !== undefined || r.signals.semantic !== undefined || r.signals.subjectMatch || r.memory.pinned)
      .sort((a, b) => b.score - a.score);
  }

  private touch(ids: string[], at: string): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    );
    transaction(this.db, () => {
      for (const id of ids) stmt.run(at, id);
    });
  }

  // ---------------------------------------------------------- user commands --

  list(filter: {
    scope?: MemoryScope;
    scopeId?: string | null;
    kind?: MemoryKind;
    status?: Memory['status'] | 'all';
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): { items: Memory[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.scope) {
      where.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.scopeId !== undefined) {
      if (filter.scopeId === null) where.push('scope_id IS NULL');
      else {
        where.push('scope_id = ?');
        params.push(filter.scopeId);
      }
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (!filter.status || filter.status !== 'all') {
      where.push('status = ?');
      params.push(filter.status ?? 'active');
    }
    if (filter.search) {
      where.push('(content LIKE ? OR subject LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM memories ${clause}`).get(...params) as { n: number }).n,
    );
    const rows = this.db
      .prepare(`${SELECT_MEMORY} ${clause} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as Row[];
    return { items: rows.map(rowToMemory), total };
  }

  /** Explicit correction: mark `id` superseded by a new memory. */
  async correct(id: string, content: string, sourceRef: Memory['sourceRef'] = {}): Promise<RememberOutcome> {
    const prior = this.get(id);
    if (!prior) return { status: 'rejected', reason: 'not_found' };
    const outcome = await this.remember({
      scope: prior.scope,
      scopeId: prior.scopeId,
      kind: prior.kind,
      // Reuse the subject so the supersession path in remember() fires; if the
      // prior had no subject we link explicitly below.
      subject: prior.subject,
      content,
      sourceType: 'user_explicit',
      sourceRef,
      explicit: true,
      confidence: 0.95,
    });
    if (outcome.status === 'stored' && !outcome.supersededId) {
      const now = nowIso();
      transaction(this.db, () => {
        this.db
          .prepare(`UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?`)
          .run(outcome.memory.id, now, id);
        this.db.prepare('UPDATE memories SET supersedes=?, updated_at=? WHERE id=?').run(id, now, outcome.memory.id);
      });
      this.bus?.emit({ type: 'memory.superseded', payload: { memoryId: id, supersededBy: outcome.memory.id } });
      return { status: 'stored', memory: outcome.memory, supersededId: id };
    }
    return outcome;
  }

  /** Soft delete: the row survives for audit, retrieval ignores it. */
  forget(id: string): boolean {
    const info = this.db
      .prepare(`UPDATE memories SET status='deleted', updated_at=? WHERE id=? AND status!='deleted'`)
      .run(nowIso(), id);
    if (Number(info.changes) > 0) {
      this.bus?.emit({ type: 'memory.deleted', payload: { memoryId: id, mode: 'soft' } });
      return true;
    }
    return false;
  }

  /** Irreversible removal, including the embedding. Used by "delete everything for project X". */
  purge(id: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (Number(info.changes) > 0) {
      this.bus?.emit({ type: 'memory.deleted', payload: { memoryId: id, mode: 'hard' } });
      return true;
    }
    return false;
  }

  /** Delete an entire project's Jarvis memory. */
  purgeScope(scope: MemoryScope, scopeId: string): number {
    const info = this.db.prepare('DELETE FROM memories WHERE scope = ? AND scope_id = ?').run(scope, scopeId);
    const n = Number(info.changes);
    if (n > 0) this.bus?.emit({ type: 'memory.deleted', payload: { scope, scopeId, count: n, mode: 'hard' } });
    return n;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const info = this.db
      .prepare('UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, nowIso(), id);
    return Number(info.changes) > 0;
  }

  /** Mark memories whose validity window has closed. Cheap; run on boot. */
  expireStale(at: string = nowIso()): number {
    const info = this.db
      .prepare(`UPDATE memories SET status='expired', updated_at=? WHERE status='active' AND valid_until IS NOT NULL AND valid_until <= ?`)
      .run(at, at);
    return Number(info.changes);
  }

  /**
   * Keep Layer 2 (core user memory) deliberately small: past the cap, the least
   * important unpinned entries are archived rather than silently growing the
   * always-available block.
   */
  trimCoreUserMemory(): number {
    const max = this.config.memory.coreUserMemoryMax;
    const rows = this.db
      .prepare(
        `SELECT id FROM memories WHERE scope='user' AND status='active' AND pinned=0
         ORDER BY importance DESC, access_count DESC, updated_at DESC LIMIT -1 OFFSET ?`,
      )
      .all(max) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`UPDATE memories SET status='expired', updated_at=? WHERE id=?`);
    const now = nowIso();
    transaction(this.db, () => {
      for (const row of rows) stmt.run(now, row.id);
    });
    return rows.length;
  }

  stats(): { active: number; superseded: number; deleted: number; expired: number; embedded: number } {
    const counts = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const get = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    return {
      active: get('active'),
      superseded: get('superseded'),
      deleted: get('deleted'),
      expired: get('expired'),
      embedded: this.countEmbeddings(),
    };
  }

  embeddingStatus() {
    return { ...this.embeddings.status(), disabledForProcess: this.semanticDisabled };
  }
}

/**
 * Function words carry no retrieval signal but match nearly every document.
 * With an OR query they are actively harmful: "what is the capital of Peru"
 * matches any memory containing "the". FTS5's unicode61 tokenizer has no
 * built-in stoplist, so we filter before querying. EN + FR, since Jarvis is used
 * in both.
 */
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'his', 'has', 'had', 'him', 'she', 'its', 'who', 'get', 'why', 'how', 'what', 'when', 'where',
  'which', 'that', 'this', 'with', 'from', 'they', 'them', 'were', 'been', 'have', 'does', 'did',
  'about', 'would', 'could', 'should', 'there', 'their', 'then', 'than', 'into', 'some', 'any',
  'more', 'most', 'much', 'very', 'just', 'also', 'only', 'over', 'such', 'each', 'both', 'does',
  // French
  'les', 'des', 'une', 'que', 'qui', 'pour', 'dans', 'sur', 'pas', 'avec', 'sont', 'est', 'ete',
  'aux', 'par', 'plus', 'mais', 'nous', 'vous', 'ils', 'elle', 'elles', 'son', 'ses', 'leur',
  'comment', 'quand', 'quel', 'quelle', 'quels', 'quelles', 'quoi', 'cette', 'ces', 'cela',
  'faire', 'fait', 'etre', 'avoir', 'tout', 'tous', 'toute', 'toutes', 'donc', 'alors', 'ainsi',
]);

/**
 * Turn free text into a safe FTS5 MATCH expression.
 * Quoting each term avoids FTS syntax errors from user punctuation, and OR keeps
 * partial matches useful (AND would return nothing for most natural questions).
 */
export function toFtsQuery(text: string): string | null {
  const terms = normaliseForHash(text)
    .split(' ')
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 24);
  if (terms.length === 0) return null;
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ');
}

/**
 * Turn raw cosine similarities into a relevance signal.
 *
 * Embedding models differ wildly in how they use the cosine range: e5 scores
 * *everything* around 0.75-0.85, while MiniLM-style models sit near 0.1-0.5. A
 * fixed cosine cutoff is therefore meaningless across models — with e5 it either
 * admits every memory in scope (recreating the "dump everything" failure) or
 * rejects all of them.
 *
 * So the cutoff is derived from the batch itself: a memory counts as a semantic
 * hit only if it stands out from the other candidates for THIS query. Scores are
 * then rescaled onto the gap above the cutoff, so fusion weights mean the same
 * thing regardless of which model produced them.
 */
export interface SemanticCalibration {
  /** Hard minimum cosine, whatever the statistics say. */
  absoluteFloor: number;
  /** How far above the null baseline a memory must score to count as a hit. */
  margin: number;
  /** Similarity of this query to topically neutral text, if measurable. */
  nullBaseline?: { mean: number; stdev: number };
  /** Standard deviations above the candidate mean required (batch-relative gate). */
  z?: number;
}

export function calibrateSemantic(
  raw: Array<{ id: string; sim: number }>,
  options: SemanticCalibration,
): Map<string, number> {
  const out = new Map<string, number>();
  if (raw.length === 0) return out;
  const z = options.z ?? 0.5;

  // Gate 1 — absolute: measured against what "unrelated" looks like for this
  // model and query. This is what stops a query about Peru matching a memory
  // about PDF rendering just because it is the least-bad option available.
  let floor = options.absoluteFloor;
  if (options.nullBaseline) {
    floor = Math.max(floor, options.nullBaseline.mean + Math.max(options.margin, 1.5 * options.nullBaseline.stdev));
  }

  const passing = raw.filter((r) => r.sim >= floor);
  if (passing.length === 0) return out;

  // Gate 2 — batch-relative: among what is left, require standing out from the
  // other candidates. Skipped when there are too few for meaningful statistics.
  let cutoff = floor;
  if (raw.length >= 3) {
    const sims = raw.map((r) => r.sim);
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const stdev = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
    cutoff = Math.max(cutoff, mean + z * stdev);
  }

  const survivors = raw.filter((r) => r.sim >= cutoff);
  if (survivors.length === 0) return out;

  // Rescale onto the gap above the cutoff so the semantic leg means the same
  // thing to the fusion step regardless of the model's native cosine range.
  const max = Math.max(...survivors.map((r) => r.sim));
  const span = max - cutoff;
  for (const { id, sim } of survivors) {
    out.set(id, span <= 1e-6 ? 1 : Math.min(1, (sim - cutoff) / span));
  }
  return out;
}

/**
 * Greedy near-duplicate suppression: prefer covering different information over
 * returning five phrasings of the same fact.
 */
function diversify(ranked: RetrievedMemory[], limit: number): RetrievedMemory[] {
  const selected: RetrievedMemory[] = [];
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const tooSimilar = selected.some((s) => jaccard(s.memory.content, candidate.memory.content) > 0.6);
    if (tooSimilar) continue;
    selected.push(candidate);
  }
  return selected;
}
