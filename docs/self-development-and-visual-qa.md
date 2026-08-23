# Self-development and visual QA

Jarvis registers its own repository as the `jarvis` Project at boot. A self-development request follows exactly the normal job pipeline in a separate branch/worktree; the running control plane and candidate checkout are distinct.

Current safety boundary:

- never apply Jarvis through the generic candidate application service;
- never push, force refs, stash, or resolve conflicts during activation;
- preserve dirty user work outside the candidate;
- require deterministic verification and independent review;
- require explicit approval and a second explicit activation confirmation.

`scripts/supervisor.mjs` is intentionally outside the process being replaced. `pnpm supervisor <config.json>` starts Jarvis with a supervised activation-request path. The upgrade manager launches the candidate with dynamic API/web ports and a unique `JARVIS_HOME`, records the current/candidate SHA and rollback ref, and exposes activation only after candidate health passes. The supervisor rechecks clean HEAD/branch/ref identity, applies FF-only, rebuilds, restarts, checks `/health`, and restores the prior SHA only when rollback preconditions still hold. Ambiguity becomes `inspection_required`.

The config keeps executable and argument fields separate and places the request outside the repository:

```json
{
  "repository": "C:\\absolute\\jarvis",
  "requestFile": "C:\\outside-jarvis\\activation.json",
  "healthUrl": "http://127.0.0.1:4319/health",
  "buildCommand": { "executable": "pnpm", "args": ["build"] },
  "startCommand": {
    "executable": "pnpm",
    "args": ["--filter", "@jarvis/orchestrator", "start"]
  }
}
```

`GET /health` returns status, version, commit, and a real DB probe without runtime paths or credentials.

After a successful job, one compact project episode preserves goal, outcome, files, verification, review, branch/head, and provenance. Validated agent proposals may promote durable architectural decisions or constraints. The transcript and changed source are not copied into memory.

## Visual QA

Projects opt into candidate runtime isolation with an executable/argv and port-environment mapping. Jarvis reserves dynamic local ports until launch, creates an isolated runtime home, and reports unsupported remapping instead of risking the current application's port. Jarvis self-candidates must echo a per-launch nonce and exact commit from `/health`; generic projects rely on their configured health contract. Arbitrary frameworks cannot inherit the reservation socket, so a narrow release-to-bind race remains for generic projects.

Playwright supports bounded deterministic `goto`, `click`, `fill`, `wait`, and `screenshot` actions, desktop/mobile capture, console errors, and failed requests. A router-selected subscription CLI can inspect all images with schema-constrained findings. `reviewedBy` stays null on missing evidence, unavailable reviewer, provider error, or invalid output. Required Jarvis UI review fails closed.

Implemented and exercised deterministically: port/state isolation, interactions, capture, structured parsing, reviewer-unavailable truthfulness, FF activation, health failure, and rollback in temporary repositories/processes. Live image inspection remains separately reported by dogfood evidence because it consumes subscription quota.
