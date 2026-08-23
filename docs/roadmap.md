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
- Central risk-classified tool permission policy, persisted audit, standing permissions, and restart recovery.
- Free deterministic GitHub Actions CI.

## Partial

- Procedures share the durable record lifecycle but learned structured procedure capture is not implemented.
- Supervisor activation requires Jarvis to have been launched through `pnpm supervisor <config.json>`; existing unsupervised processes can prepare but not activate.
- Runtime port reservation has an unavoidable narrow handoff race for arbitrary frameworks; Jarvis self-candidates close it with a per-launch nonce and commit check, while generic projects rely on their configured health contract.
- Provider cooldowns are runtime-local; restarting Jarvis clears them, and a failed in-flight provider call is not automatically replayed through another subscription.
- Route/interaction configuration is deterministic and deliberately small, not a browser agent.
- Restart recovery preserves/marks unknown application state and reconciles supervisor evidence; supervisor crash recovery remains conservative.
- Tool Registry contains only tools needed for the bootstrap slice; the permission layer is built ahead of the modules that will need it, so `sensitive` and `destructive` are exercised by tests rather than by shipped tools.
- Tool permission enforcement is in-process. The loopback API is unauthenticated, so a local process running as the same user can still act as the user; OS-level isolation of agent children is not implemented. See `docs/tool-permissions.md`.
- A tool timeout records the failure but cannot cancel the underlying work.

## Planned — next five milestones

Phase 1b hardened self-development, and the permission-gated tool-execution and recovery layer is now in place. On top of it: voice/screen/desktop and official Gmail/Calendar modules can be developed through Jarvis with the same evidence and approval boundaries, each registering as a risk-classified tool. The remaining permission work is sandboxing agent children at the OS level and, only then, delegated standing permissions for agents.
