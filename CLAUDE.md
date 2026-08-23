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
- Application transactions fail closed: exact reviewed HEAD, clean target, FF-only, no stash/push/conflict AI.
- Self-activation requires explicit approval and the external supervisor; rollback never overwrites dirty work.
- Database migrations preserve existing memories/jobs/projects and reject unknown versions.
- Provider and visual-review availability must be reported honestly; `reviewedBy` is never faked.
- Provider children use official subscription auth and never inherit paid API keys.
- Every tool runs through the permission boundary in `packages/core/src/tools/`; privilege comes from the call site's actor, never from a request payload, and agents never reach sensitive/destructive.

Commands: `pnpm dev`, `pnpm supervisor <config.json>`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`. Live agents require explicit `JARVIS_LIVE_AGENT_TESTS=1`.

Keep changes narrow. Reuse existing services and event types before adding abstractions. Update the relevant documentation when an implemented/planned boundary changes.
