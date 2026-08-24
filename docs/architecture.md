# Architecture

## Runtime

Jarvis is one local control plane, not a collection of microservices.

```text
React/Vite UI (origin-scoped control credential)
    | authenticated HTTP + fetch-stream SSE
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

SQLite schema version 5 stores routing decisions, candidate-application transactions, self-upgrade transactions, hashed human-control verification material, tool/grant integrity metadata, exact repair checkpoints, verification failure classification, review HEAD identities, and scenario-based visual evidence. `schema.sql` remains the version-1 baseline; ordered transactional migrations preserve v1-v4 records, expire unverifiable legacy pending approvals, revoke legacy grants lacking risk/revision identity, and reject unknown/newer versions.

The event log supports live UI updates and post-restart inspection. Startup marks agent runs interrupted and their running jobs paused while retaining the exact repair kind/evidence and recording restart separately. An explicit resume validates the existing worktree and exact checkpointed HEAD; before a HEAD checkpoint exists, only the pinned base SHA is accepted. Unexpected descendants and dirty state are preserved for inspection, never adopted or reset.

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

Provider infrastructure failures reroute the same logical stage within a bounded attempt budget and never invoke a source fixer. Verification setup/spawn/missing-executable/timeout failures retry verification within `JARVIS_VERIFICATION_INFRA_RETRIES`; exhaustion pauses with evidence and invokes no fixer. Deterministic check non-zero exits are product failures. Cancellation is separate.

## Human control plane

Loopback, Origin, Host, User-Agent, process ancestry, and port secrecy are not authentication. When no control credential is paired, Jarvis generates a cryptographically random, in-memory, one-use bootstrap at startup and prints it only to the controlling terminal. Pairing returns one random control credential once; the browser stores it in origin-scoped `localStorage`, sends it only in `X-Jarvis-Control`, and the database stores only a hash. Host-scoped authentication cookies are not used because candidate origins on other ports could receive them.

Every `/api/*` route is private except `/api/auth/status`, `/api/auth/pair`, and CORS `OPTIONS` preflight; `/health` stays public for supervisor/candidate identity. Mutations require both authentication and an exact configured Origin. Events use authenticated fetch streaming because native `EventSource` cannot attach the header. Agent/provider/candidate children receive neither bootstrap nor control material. The external supervisor sees only its persisted approved activation request, never browser authority.

## Tool execution

Every privileged action goes through one boundary that classifies it by risk,
decides allow/confirm/deny from the caller's actor, records the attempt before
it runs, and reconciles what was in flight after a restart. Privilege is never
taken from a request payload. HTTP call sites can assert `actor:user` only after
human-control authentication. See `docs/tool-permissions.md`.

## Boundaries

- `packages/core`: product domain and infrastructure adapters.
- `apps/orchestrator`: thin validation/API/SSE layer and static production UI serving.
- `apps/web`: user-facing command, project, job, memory, and tool-permission views.
- `.jarvis` or `JARVIS_HOME`: runtime state, never source control.

PostgreSQL migration is possible at the repository layer. Domain records use portable scalar/JSON fields; FTS5 and embedding BLOB access are deliberately isolated.

## Implemented versus planned

Implemented: text command flow, project registration/detection, durable jobs/events, Claude/Codex CLI adapters, inspectable routing/cooldowns/model profiles, Git worktrees, deterministic checks, independent code and image review, isolated candidate runtime, explicit approval, FF-only application, and supervised self-upgrade foundations.

Planned: voice, wake word, screen understanding, desktop control, Gmail/Calendar, learned procedure capture, richer automation triggers, PostgreSQL deployment, and broader trusted policies.
