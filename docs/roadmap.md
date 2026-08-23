# Roadmap and implementation status

## Implemented

- Local TypeScript monorepo, SQLite/WAL persistence, Hono API/SSE, React UI.
- Projects, compact sessions, explicit job state machine, persisted events and crash recovery.
- Claude Code and Codex CLI capability detection and structured adapters.
- Isolated Git worktrees, deterministic verification, independent structured review.
- Local FTS5 plus optional multilingual E5 embeddings, supersession, dedupe, expiry, provenance, secret rejection, bounded inspectable Context Packs.
- Playwright screenshot evidence and manual human acceptance boundary.

## Partial

- Procedures share the durable record lifecycle but learned structured procedure capture is not implemented.
- Visual QA captures evidence; automatic image review and broad route interactions are not implemented.
- Restart recovery preserves/marks state but deliberately does not auto-resume unknown processes.
- Tool Registry contains only tools needed for the bootstrap slice.

## Planned — next five milestones

1. Local wake word, streaming speech-to-text/text-to-speech, and explicit microphone privacy controls.
2. Screen/window capture plus local active-application understanding and redaction boundaries.
3. Permission-gated desktop input tools with reversible actions, confirmations, and audit events.
4. Official OAuth Gmail/Calendar connectors with draft-first/send-confirmed policies.
5. Stronger self-development: resumable supervisors, richer visual scripts/review, candidate-port isolation, patch application/merge UI, and risk-based trust policies.

