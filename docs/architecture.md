# Architecture

## Runtime

Jarvis is one local control plane, not a collection of microservices.

```text
React/Vite UI
    | HTTP + persisted SSE
Hono orchestrator
    |
Core composition root (Jarvis)
    |-- projects / sessions / jobs
    |-- Claude and Codex provider adapters
    |-- Git workspace / verification / review / visual QA
    |-- memory / Context Pack builder
    `-- SQLite + local artifacts/model cache
```

`Jarvis` is the composition root used by both the server and integration tests. Domain services contain no HTTP or React concerns. Provider-specific event formats are normalized inside their adapters.

## Persistence and events

SQLite stores projects, compact session state, archive messages, jobs, agent runs, verification evidence, reviews, visual-QA records, durable memories, embeddings, Context Packs, and an append-only normalized event log. Foreign keys are enabled, WAL is used on disk, and the database fails closed instead of silently falling back to memory.

The event log supports live UI updates and post-restart inspection. Startup marks in-flight work interrupted rather than guessing that an unknown worktree/process is safe to resume.

## Boundaries

- `packages/core`: product domain and infrastructure adapters.
- `apps/orchestrator`: thin validation/API/SSE layer and static production UI serving.
- `apps/web`: user-facing command, project, job, and memory views.
- `.jarvis` or `JARVIS_HOME`: runtime state, never source control.

PostgreSQL migration is possible at the repository layer. Domain records use portable scalar/JSON fields; FTS5 and embedding BLOB access are deliberately isolated.

## Implemented versus planned

Implemented: text command flow, project registration/detection, durable jobs/events, Claude/Codex CLI adapters, Git worktrees, deterministic checks, independent review, Playwright evidence, memory retrieval/context packs, and manual candidate acceptance.

Planned: voice, wake word, screen understanding, desktop control, Gmail/Calendar, learned procedure capture, richer automation triggers, PostgreSQL deployment, and trusted merge policies.

