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
    |-- tool permission policy / execution audit / recovery
    |-- memory / Context Pack builder
    `-- SQLite + local artifacts/model cache

External Jarvis Supervisor
    `-- activation request -> FF-only apply -> restart -> /health -> rollback if needed
```

`Jarvis` is the composition root used by both the server and integration tests. Domain services contain no HTTP or React concerns. Provider-specific event formats are normalized inside their adapters.

## Persistence and events

SQLite schema version 4 stores routing decisions, candidate-application transactions, self-upgrade transactions, tool execution integrity metadata, resumable job checkpoints, review HEAD identities, and scenario-based visual evidence. `schema.sql` remains the version-1 baseline; ordered transactional migrations preserve v1/v2/v3 records, expire unverifiable legacy pending approvals, and reject unknown/newer versions.

The event log supports live UI updates and post-restart inspection. Startup marks agent runs interrupted and their running jobs paused. An explicit resume validates the existing worktree and checkpoint; it never creates a duplicate recovery job.

## Resilient development pipeline

```text
implement -> verify -> independent code review
                    | blockers (critical/high)
                    v
               code fixer --commit--> verify --fresh review (max 2)
                    |
                    v pass
visual scenarios -> independent image review
                    | blockers (high/medium)
                    v
              visual fixer --commit--> verify -> fresh code review -> recapture (max 2)
                    |
                    v pass
               awaiting_user
```

Provider infrastructure failures reroute the same logical stage within a bounded attempt budget and never invoke a source fixer. Exhaustion and repair-budget exhaustion pause the job with exact evidence and the worktree intact. `failed` is reserved for non-recoverable setup/corruption.

## Tool execution

Every privileged action goes through one boundary that classifies it by risk,
decides allow/confirm/deny from the caller's actor, records the attempt before
it runs, and reconciles what was in flight after a restart. Privilege is never
taken from a request payload. See `docs/tool-permissions.md`, including its
analysis of what this does and does not defend against.

## Boundaries

- `packages/core`: product domain and infrastructure adapters.
- `apps/orchestrator`: thin validation/API/SSE layer and static production UI serving.
- `apps/web`: user-facing command, project, job, memory, and tool-permission views.
- `.jarvis` or `JARVIS_HOME`: runtime state, never source control.

PostgreSQL migration is possible at the repository layer. Domain records use portable scalar/JSON fields; FTS5 and embedding BLOB access are deliberately isolated.

## Implemented versus planned

Implemented: text command flow, project registration/detection, durable jobs/events, Claude/Codex CLI adapters, inspectable routing/cooldowns/model profiles, Git worktrees, deterministic checks, independent code and image review, isolated candidate runtime, explicit approval, FF-only application, and supervised self-upgrade foundations.

Planned: voice, wake word, screen understanding, desktop control, Gmail/Calendar, learned procedure capture, richer automation triggers, PostgreSQL deployment, and broader trusted policies.
