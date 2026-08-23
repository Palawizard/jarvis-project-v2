# Jarvis repository guidance

Jarvis is a TypeScript/pnpm monorepo: `packages/core` owns domain logic and SQLite persistence, `apps/orchestrator` exposes Hono HTTP/SSE, and `apps/web` is the React/Vite UI.

Critical invariants:

- Jarvis memory is canonical; Claude sessions and this file are not product memory.
- Scope-filter before ranking; unrelated project memory must never enter context.
- Raw history is audit/recovery data, never default prompt context.
- Retrieval is local and hard-budgeted. Never add a cloud call solely for memory.
- Never persist secrets or copy provider credentials.
- Coding jobs and candidate runtimes never bypass worktree/state/port isolation.
- Verification is executed by Jarvis; an agent's claim is not evidence.
- Source changes invalidate code-review and visual-evidence HEAD identities; repair always re-verifies, re-reviews, and recaptures as applicable.
- Recoverable interruptions pause the same job/worktree. Resume must validate repository, base, expected HEAD, and dirty state before mutation.
- Application transactions fail closed: exact reviewed HEAD, clean target, FF-only, no stash/push/conflict AI.
- Self-activation requires explicit approval and the external supervisor; rollback never overwrites dirty work.
- Database migrations preserve existing memories/jobs/projects and reject unknown versions.
- Provider and visual-review availability must be reported honestly; `reviewedBy` is never faked.
- Provider children use official subscription auth and never inherit paid API keys.
- Every tool runs through the permission boundary in `packages/core/src/tools/`; privilege comes from the call site's actor, never from a request payload, and agents never reach sensitive/destructive. Every definition has an explicit revision which must be bumped for schema/security-semantic changes; approvals bind revision, risk, and canonical input hash. Standing permissions are user-only; approval expiry and claiming are one atomic conditional update.

Commands: `pnpm dev`, `pnpm supervisor <config.json>`, `pnpm verify` (complete deterministic gate), `pnpm test` (unit only), `pnpm test:integration`, `pnpm test:all`, `pnpm test:e2e`. Live agents require explicit `JARVIS_LIVE_AGENT_TESTS=1`.

Keep changes narrow. Reuse existing services and event types before adding abstractions. Update the relevant documentation when an implemented/planned boundary changes.
