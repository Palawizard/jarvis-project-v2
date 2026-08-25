# ADR 0002: External supervisor for Jarvis self-upgrades

Status: accepted

## Decision

The process that activates Jarvis code is a small external Node supervisor, not the orchestrator being replaced. Jarvis persists an upgrade transaction, creates a rollback ref, healthchecks the isolated candidate, and sends an activation request over the supervisor's private local IPC endpoint only after explicit user confirmation. The supervisor independently revalidates repository identity, clean branch/HEAD, candidate ancestry, and rollback ref before FF-only application.

Candidate approval, preparation, and activation HTTP requests require the paired browser's human-control credential before activation is requested. That credential is origin-scoped browser state and is never copied to the candidate environment, command line, supervisor IPC, or supervisor. Final activation additionally requires an out-of-band human token; only its hash is configured in the trusted runtime, the token is validated in supervisor memory, and only a canonical token-free processing record is persisted. Ambiguous crash residue fails closed on restart. `/health` remains unauthenticated solely for candidate/supervisor identity checks.

It rebuilds and restarts Jarvis, checks `/health`, and rolls back to the recorded prior SHA only if the checkout remains clean and at the expected candidate. It never pushes, stashes, forces refs, or resolves conflicts. Results are written atomically for the restarted orchestrator to reconcile; ambiguous state requires inspection.

## Consequences

- Jarvis cannot activate itself unless launched under the supervisor. `pnpm dev` bootstraps that supervisor — including the per-launch activation token, whose raw value only ever reaches the terminal — so normal self-updates need no terminal work; `pnpm supervisor <config.json>` stays as the low-level path.
- The supervisor stays intentionally small and owns no product database or provider credentials.
- Candidate runtime uses a separate `JARVIS_HOME` and dynamic ports.
- Rollback behavior is tested against temporary repositories and processes, not the user's live checkout.
