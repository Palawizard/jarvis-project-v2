# Jarvis repository guidance

Jarvis is a TypeScript/pnpm monorepo: `packages/core` owns domain logic and SQLite persistence, `apps/orchestrator` exposes Hono HTTP/SSE, and `apps/web` is the React/Vite UI.

Critical invariants:

- Jarvis memory is canonical; Claude sessions and this file are not product memory.
- Scope-filter before ranking; unrelated project memory must never enter context.
- Raw history is audit/recovery data, never default prompt context.
- Retrieval is local and hard-budgeted. Never add a cloud call solely for memory.
- Never persist secrets or copy provider credentials.
- Coding jobs use isolated Git worktrees and never destroy dirty user work.
- Verification is executed by Jarvis; an agent's claim is not evidence.
- Review is independent/read-only. Self-development stops for human approval and never auto-merges.
- Provider and visual-review availability must be reported honestly; fail explicitly rather than fake success.

Commands: `pnpm dev`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`.

Keep changes narrow. Reuse existing services and event types before adding abstractions. Update the relevant documentation when an implemented/planned boundary changes.

