# Roadmap and implementation status

## Implemented

- Local TypeScript monorepo, SQLite/WAL persistence, Hono API/SSE, React UI.
- Projects, compact sessions, explicit job state machine, persisted events and crash recovery.
- Claude Code and Codex CLI capability detection and structured adapters.
- Isolated Git worktrees, deterministic verification, independent structured review.
- Local FTS5 plus optional multilingual E5 embeddings, supersession, dedupe, expiry, provenance, secret rejection, bounded inspectable Context Packs.
- Playwright screenshot evidence and manual human acceptance boundary.
- Explicit candidate approval plus persisted clean-target FF-only application.
- Isolated dynamic candidate runtimes, deterministic interaction scripts, and real subscription-backed image-review adapters.
- Deterministic provider/model routing with health, cooldowns, explanations, and opt-in real-provider smoke tests.
- External supervisor activation protocol, health endpoint, rollback ref, and temporary-repository rollback tests.
- Deterministic EN/FR memory classification and fail-closed ambiguous forget.
- Free deterministic GitHub Actions CI.

## Partial

- Procedures share the durable record lifecycle but learned structured procedure capture is not implemented.
- Supervisor activation requires Jarvis to have been launched through `pnpm supervisor <config.json>`; existing unsupervised processes can prepare but not activate.
- Runtime port reservation has an unavoidable narrow handoff race for arbitrary frameworks; health verification catches collisions.
- Route/interaction configuration is deterministic and deliberately small, not a browser agent.
- Restart recovery preserves/marks unknown application state and reconciles supervisor evidence; supervisor crash recovery remains conservative.
- Tool Registry contains only tools needed for the bootstrap slice.

## Planned — next five milestones

Phase 1b deliberately hardened self-development before adding broader powers. The next highest-leverage capability is a permission-gated tool-execution policy and recovery layer; after that, voice/screen/desktop and official Gmail/Calendar modules can be developed through Jarvis with the same evidence and approval boundaries.
