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
- Central risk-classified tool permission policy, persisted audit, user-only standing permissions, atomic approval expiry, cooperative timeout cancellation, and restart recovery.
- Free deterministic GitHub Actions CI.
- Bounded code/visual repair loops, provider stage rerouting, durable pause/resume, immutable validation-only candidate import, and job-scoped Visual QA scenarios.
- Explicit ordered verification steps; Jarvis's full gate includes integration and Playwright E2E while live subscription tests remain opt-in.
- One-use terminal pairing, origin-scoped browser control capability, authenticated private API/fetch-stream events, and adversarial loopback-client denial.
- Schema-v5 grant-definition binding, exact recovery/repair evidence checkpoints, strict review protocols, and exact-origin Visual QA navigation/artifact confinement.
- Schema-v7 conversations: persistent multi-conversation chat, a chat agent path with no source-editing authority, strict structured action routing, deterministic project resolution with explicit ambiguity, conversation-linked Job provenance and tombstones, project/Job archive-versus-delete lifecycles with immutable-evidence protection, one shared destructive confirmation, global search, and classified provider-failure recovery with bounded fresh-context session recovery and stale-Job detection.

## Partial

- Procedures share the durable record lifecycle but learned structured procedure capture is not implemented.
- Supervisor activation requires Jarvis to have been launched under the external supervisor, which `pnpm dev` now does by default; `pnpm dev:unsupervised`, candidate runtimes, and any other unsupervised process can prepare but not activate.
- The running supervisor is never hot-replaced: activating a candidate that changes `scripts/supervisor.mjs`, `scripts/dev.mjs`, or the Windows job runner flags `supervisorRestartRequired` in the signed evidence and takes effect only at the next `pnpm dev`.
- Runtime port reservation has an unavoidable narrow handoff race for arbitrary frameworks; Jarvis self-candidates close it with a per-launch nonce and commit check, while generic projects rely on their configured health contract.
- Provider cooldowns are runtime-local; restarting Jarvis clears them. Within a run, recoverable provider failures are recorded and rerouted with a bounded stage budget.
- Route/interaction configuration is deterministic and deliberately small, not a browser agent.
- Restart recovery pauses running development jobs with their worktree checkpoint and marks running agent calls interrupted. Candidate application/supervisor crash recovery remains separately conservative.
- Tool Registry contains only tools needed for the bootstrap slice; the permission layer is built ahead of the modules that will need it, so `sensitive` and `destructive` are exercised by tests rather than by shipped tools.
- Human HTTP authority is authenticated even on loopback. OS-level isolation of agent children is still not implemented, so sensitive agent tools remain disabled. See `docs/tool-permissions.md`.
- A tool timeout aborts `ctx.signal` and records `timed_out` with `effectUnknown`, but cannot force uncooperative code to stop; a tool that ignores the signal may still complete its side effect.

## Planned — next five milestones

Phase 1b hardened self-development, and the permission-gated tool-execution and recovery layer is now in place. On top of it, voice/screen/desktop and official Gmail/Calendar modules can be developed through Jarvis with the same evidence and approval boundaries, each registering as a risk-classified tool.

**Blocking milestone — verified OS-level agent isolation.** No `sensitive` tool (Gmail, Calendar, screen capture, desktop input) may be enabled for the `agent` actor until agent child processes run under a verified restricted user or container with filesystem, credential, process, and control-plane network separation. Human HTTP authority now requires a browser-origin capability, so loopback alone cannot impersonate the user; that does not prove containment of arbitrary same-user malware or make sensitive delegated autonomy safe. Until this milestone ships:

- agents are hard-denied `sensitive` and `destructive` by policy, and
- standing permissions cannot be granted to the `agent` actor at all, so delegated autonomy stays off by construction.

Delegated standing permissions for agents are the milestone *after* that isolation, never before it.
