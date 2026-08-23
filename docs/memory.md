# Memory architecture

Jarvis owns its memory database independently of Claude/Codex sessions.

## Layers

1. Session working memory is bounded structured state (goal, constraints, decisions, unresolved items, entities, artifacts, active jobs). Messages remain archive rows.
2. Core user memory is a deliberately capped set of durable cross-project preferences/facts.
3. Project memory contains only knowledge for one registered project.
4. Episodes compact meaningful outcomes such as completed coding jobs.
5. Procedures use the durable memory model today; structured learning/capture remains planned.
6. Raw messages/events support audit and recovery and are never retrieved by default.

Durable records include scope, kind, optional structured subject, content, importance/confidence, provenance, validity, status, pinning, sensitivity, metadata, access accounting, and explicit supersession links. Corrections preserve the old row as `superseded`; normal retrieval uses only active, currently valid rows.

## Write policy

Deterministic commands (`remember`, `forget`, `update`) are handled locally. Structured job completion always creates one episode. Agent `memoryProposals` piggyback on a task call that was already required, but still pass Memory Service validation.

Automatic writes are thresholded, normalized, exact/near deduplicated, scope-checked, and secret-scanned. Explicit requests bypass importance thresholds but never the secret gate. Routine transcripts, command logs, source files, and credentials do not become memories.

## Retrieval and budgets

Retrieval filters scopes before ranking, then combines FTS5/BM25, optional local semantic similarity, structured subject matches, scope priority, importance, confidence, and pinning. It removes near-duplicate results and ignores expired/superseded/deleted rows.

The default embedding model is lazy-loaded `Xenova/multilingual-e5-small`; model ID, dimension, text hash, and vector are stored so unchanged text is not re-embedded and model changes can be reindexed. A corrupt/unavailable embedding path disables semantic search for the process and keeps lexical retrieval operational.

`ContextPackBuilder` is the only provider-facing memory injector. It divides a hard token budget among core user memory, project snapshot, atomic memory, episodes, and session state. Each persisted pack records selected memory IDs, scores, deterministic inclusion reasons, role, query, and approximate tokens.

This avoids quota waste: no cloud call performs retrieval, no per-turn summarizer runs, providers receive only a small relevant pack, and job consolidation is assembled from structured evidence rather than replaying a transcript.

## Control and privacy

The Memory view supports inspection, search/filtering, provenance, explicit addition/correction, pinning, soft forget, and active/superseded visibility. Project memory can be purged separately. Runtime data is local and Git-ignored; filesystem permissions are restricted where the OS supports them.

