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

Deterministic commands (`remember`, `forget`, `update`) are handled locally. Explicit remember classification recognizes English/French preference, constraint, and decision markers; unmarked project statements become project knowledge and unmarked user statements facts. It never calls an agent.

Detection is deliberately conservative, because a false positive here writes to durable memory and swallows the turn:

- A message ending in `?` is never a command. "Remember the meeting?" and "Tu te souviens de la réunion ?" ask about memory; they are answered.
- `oublie pas que …` is a remember, not a forget. Spoken French drops the `n'`, and only the negation-free `oublie …` deletes anything.
- The correction markers `actually`, `en fait` and `correction` are *tentative*. They act as an update only when the sentence states a fact — no question, no request to act — **and** retrieval returns a memory whose topical relevance (`signals.relevance`, which excludes the pinning, importance and scope priors folded into `score`) reaches `memory.correctionRelevance`. Otherwise the message is ordinary conversation and is routed and answered normally. "Actually, fix the bug in Jarvis" and "En fait, peux-tu m'expliquer X ?" write nothing.
- A tentative correction never overwrites a **pinned** memory. Jarvis says which one it would have replaced and leaves it alone; `update what you remember about …` is how to mean it on purpose.

An explicit remember is scoped by its content, not by the conversation. A project-linked conversation does not make "retiens que je préfère pnpm" project knowledge — that is a fact about the user, and filing it under one repository hides it everywhere else. Project scope requires the content to name the project, one of its registered aliases, or "this project"/"ce projet".

Forget auto-deletes only an explicit in-scope memory ID or a unique exact normalized subject/content. Fuzzy or duplicate matches return auditable candidates for user choice and delete nothing.

Automatic writes are thresholded, normalized, exact/near deduplicated, scope-checked, and secret-scanned. Explicit requests bypass importance thresholds but never the secret gate. Routine transcripts, command logs, source files, and credentials do not become memories.

## Retrieval and budgets

Retrieval filters scopes before ranking, then combines FTS5/BM25, optional local semantic similarity, structured subject matches, scope priority, importance, confidence, and pinning. It removes near-duplicate results and ignores expired/superseded/deleted rows.

The default embedding model is lazy-loaded `Xenova/multilingual-e5-small`; model ID, dimension, text hash, and vector are stored so unchanged text is not re-embedded and model changes can be reindexed. A corrupt/unavailable embedding path disables semantic search for the process and keeps lexical retrieval operational.

`ContextPackBuilder` is the only provider-facing memory injector. It divides a hard token budget among core user memory, project snapshot, atomic memory, episodes, and session state. Each persisted pack records selected memory IDs, scores, deterministic inclusion reasons, role, query, and approximate tokens.

This avoids quota waste: no cloud call performs retrieval, no per-turn summarizer runs, providers receive only a small relevant pack, and job consolidation is assembled from structured evidence rather than replaying a transcript.

## Control and privacy

The Memory view supports inspection, search/filtering, provenance, explicit addition/correction, pinning, soft forget, and active/superseded visibility. Project memory can be purged separately. Runtime data is local and Git-ignored; filesystem permissions are restricted where the OS supports them.
