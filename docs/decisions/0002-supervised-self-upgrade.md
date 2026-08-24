# ADR 0002: External supervisor for Jarvis self-upgrades

Status: accepted

## Decision

The process that activates Jarvis code is a small external Node supervisor, not the orchestrator being replaced. Jarvis persists an upgrade transaction, creates a rollback ref, healthchecks the isolated candidate, and writes an activation request only after explicit user confirmation. The supervisor independently revalidates repository identity, clean branch/HEAD, candidate ancestry, and rollback ref before FF-only application.

Candidate approval, preparation, and activation HTTP requests require the paired browser's human-control credential before any activation request is written. That credential is origin-scoped browser state and is never copied to the candidate environment, command line, activation file, or supervisor. `/health` remains unauthenticated solely for candidate/supervisor identity checks.

It rebuilds and restarts Jarvis, checks `/health`, and rolls back to the recorded prior SHA only if the checkout remains clean and at the expected candidate. It never pushes, stashes, forces refs, or resolves conflicts. Results are written atomically for the restarted orchestrator to reconcile; ambiguous state requires inspection.

## Consequences

- Jarvis cannot activate itself unless launched with `pnpm supervisor <config.json>`.
- The supervisor stays intentionally small and owns no product database or provider credentials.
- Candidate runtime uses a separate `JARVIS_HOME` and dynamic ports.
- Rollback behavior is tested against temporary repositories and processes, not the user's live checkout.
