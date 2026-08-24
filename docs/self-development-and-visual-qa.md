# Self-development and visual QA

Jarvis registers its own repository as the `jarvis` Project at boot. A self-development request follows exactly the normal job pipeline in a separate branch/worktree; the running control plane and candidate checkout are distinct.

Current safety boundary:

- never apply Jarvis through the generic candidate application service;
- never push, force refs, stash, or resolve conflicts during activation;
- preserve dirty user work outside the candidate;
- require deterministic verification and independent review;
- require human-control authentication before approval, application, preparation, or activation;
- require explicit approval and a second explicit activation confirmation.

`scripts/supervisor.mjs` is intentionally outside the process being replaced. `pnpm supervisor <config.json>` starts Jarvis with a private local activation IPC endpoint. The upgrade manager launches the candidate with dynamic API/web ports, an explicit non-authoritative candidate-mode flag, and a unique `JARVIS_HOME`; candidate mode never mints or prints a human pairing bootstrap. It records the current/candidate SHA and rollback ref, and exposes activation only after candidate health passes. Candidate commands receive an allowlisted platform environment; provider children also lose ambient secrets and every control/supervisor variable. On Windows, untrusted verification, provider, candidate-runtime, build, and supervised-runtime processes are created suspended inside a kill-on-close Job Object; a leader exit is not accepted until all descendants have been terminated. The authenticated browser credential is never sent to the supervisor. A second high-entropy token held by the human is entered only at activation; the config contains only its SHA-256 hash, the token is validated in supervisor memory, and only a token-free processing record is persisted before candidate-controlled build or runtime work. Rejected/processed records never retain it, and ambiguous crash residue fails closed. The supervisor then rechecks clean HEAD/branch/ref identity before FF-only application, rebuild, restart, `/health`, and conditional rollback. Ambiguity becomes `inspection_required`.

The config keeps executable and argument fields separate and places the request outside the repository:

```json
{
  "repository": "C:\\absolute\\jarvis",
  "requestFile": "C:\\outside-jarvis\\activation.json",
  "activationTokenHash": "<sha256-of-a-random-32-byte-human-token>",
  "healthUrl": "http://127.0.0.1:4319/health",
  "buildCommand": { "executable": "pnpm", "args": ["build"] },
  "startCommand": {
    "executable": "pnpm",
    "args": ["--filter", "@jarvis/orchestrator", "start"]
  }
}
```

Generate the token and hash out of band, keep the token with the human, and put only the hash in the config. For example: `node -e "const c=require('node:crypto'),t=c.randomBytes(32).toString('hex');console.log('token='+t);console.log('hash='+c.createHash('sha256').update(t).digest('hex'))"`. The UI asks for the token only at the final activation action.

`GET /health` returns status, version, commit, and a real DB probe without runtime paths or credentials.

After a successful job, one compact project episode preserves goal, outcome, files, verification, review, branch/head, and provenance. Validated agent proposals may promote durable architectural decisions or constraints. The transcript and changed source are not copied into memory.

## Visual QA

Projects opt into candidate runtime isolation with an executable/argv and port-environment mapping. Jarvis reserves dynamic local ports until launch, creates an isolated runtime home, and reports unsupported remapping instead of risking the current application's port. Jarvis self-candidates must echo a per-launch nonce and exact commit from `/health`; generic projects rely on their configured health contract. Arbitrary frameworks cannot inherit the reservation socket, so a narrow release-to-bind race remains for generic projects.

Playwright supports bounded deterministic `goto`, `click`, `fill`, `wait`, and `screenshot` actions, desktop/mobile capture, console errors, and failed requests. Before navigation it installs context-wide guards for every main-frame document, redirect, click/form/JavaScript navigation, and popup. The guards remain active through screenshot and context shutdown; every callback settles and exact-origin confinement is rechecked before persistence. An attempted escape permanently fails the scenario, aborts the foreign document before dispatch, and deletes its screenshots. Subresources may use CDNs. Artifact paths are derived only from validated DB-owned job/project identities and proven beneath the configured artifact root before filesystem or browser work.

A router-selected subscription CLI can inspect all images with a whole-response schema. Codex receives each image through its official attachment option; Claude must emit a successful exact-path `Read` result for every image. Every provider must return the exact shot ID and content digest for every inspected image, and every finding must reference an exact successfully captured `(scenarioName, route, viewport)` tuple. Missing image-consumption evidence, malformed output, or hallucinated findings are reviewer protocol errors that retry/reroute review and never invoke a visual fixer. `reviewedBy` stays null on missing evidence, unavailable reviewer, provider error, or invalid output. Required Jarvis UI review fails closed.

Visual QA configuration is job-scoped when supplied and falls back to the Project defaults; a recovery job never has to PATCH global project configuration. Each persisted scenario has a name, route, bounded declared interactions, and viewports. Interactions run before the final screenshot, and scenario name plus reviewed candidate HEAD are stored with every evidence row and finding. Captures are content-addressed, the isolated candidate is stopped before review, and the image digest is revalidated before and after review and again before application approval. Jarvis's self-project defaults cover both Command and Tools desktop/mobile states, with Tools reached through stable `data-testid` selectors.

Visual review judges attached pixels only and cannot claim hidden code correctness. High/medium findings block by default; low/info stay advisory. A blocking product finding enters a bounded visual fixer loop. Any source change invalidates both the prior code-review HEAD and screenshots, so Jarvis reruns deterministic verification, a fresh code review, candidate runtime, capture, and image review. Browser/server/provider failures are infrastructure failures: they pause the job and never trigger CSS/source edits. Configure limits with `JARVIS_MAX_VISUAL_FIX_CYCLES` and `JARVIS_VISUAL_REVIEW_BLOCKING_SEVERITIES`.

Implemented and exercised deterministically: port/state isolation, interactions, capture, structured parsing, reviewer-unavailable truthfulness, FF activation, health failure, and rollback in temporary repositories/processes. Live image inspection remains separately reported by dogfood evidence because it consumes subscription quota.
