# Phase 1c implementation plan

Baseline: `d62c273fccef7bbaab6c1542d9bd1f935c30db40` on
`phase/1c-job-resilience`.

1. Harden tool approvals and runtime readiness: persist canonical-input and
   explicit tool-definition identity, fail closed on legacy/drifted approvals,
   align retry/timeout attribution semantics, require an HTTP-successful web
   probe, and make process cleanup observable and idempotent.
2. Add schema-v4 recovery checkpoints: paused jobs, resumable stage/provider
   metadata, repair-cycle counts, reviewed/evidence head identities,
   validation-only candidate source, and job-scoped visual scenarios. Preserve
   v1-v3 data; expire unverifiable legacy approvals.
3. Refactor the pipeline around resumable stage checkpoints and bounded agent
   attempts. Verification, code-review repair, and visual-repair loops stay in
   one worktree; provider infrastructure failures reroute without editing; an
   exhausted stage pauses with its artifacts and exact reason.
4. Add native Git candidate materialization with repository/base/source checks,
   exact tree parity, and no source-ref mutation. Validation-only jobs start at
   deterministic verification.
5. Formalize review/evidence semantics and scenarios: severity-derived blocking,
   source-head-bound code reviews and screenshots, bounded declared interactions,
   and fresh review/capture after every source change.
6. Make verification explicit and complete, including integration and E2E for
   Jarvis, while keeping live-agent checks opt-in. Harden Windows/nested-worktree
   config loading, timeouts, direct process startup, teardown, and port checks.
7. Expose create/resume/state/artifact details in the API and Jobs UI; document
   repair budgets, provider recovery, validation-only imports, and the honest
   OS-isolation capability boundary.
8. Run focused regressions, full standard gates, both deterministic self-job
   smoke scenarios, then adversarially review `d62c273..HEAD`, fix genuine
   critical/high findings, commit, and non-force-push only the current branch.
