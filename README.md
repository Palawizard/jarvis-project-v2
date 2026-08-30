# Jarvis

Jarvis is a local-first conversational assistant that also runs your coding work. You open it and talk to it: ordinary questions get ordinary answers, and when you want work done you ask for it in words. It remembers durable context, runs coding jobs in isolated Git worktrees, verifies and independently reviews them, presents a candidate for explicit approval, and safely fast-forwards it into a clean target repository.

Projects and Jobs are capabilities Jarvis uses from conversation — they stay fully inspectable and controllable through their own pages, but you never have to pick a project before Jarvis will talk to you.

The bootstrap intentionally implements one complete development workflow instead of speculative desktop, mail, calendar, or voice features. Claude Code and Codex use their existing subscription-backed CLI authentication; Jarvis never reads their credentials and requires no paid API key.

## Requirements

- Windows, macOS, or Linux with Node.js 22.5+
- Git
- pnpm 10 (`corepack enable` if needed)
- Claude Code and/or Codex CLI logged in through their official login flow
- Chromium for visual QA (`pnpm exec playwright install chromium`)

## Start

```powershell
pnpm install
pnpm dev
```

Open <http://localhost:5199>. Jarvis opens on a conversation. Runtime data defaults to `~/.jarvis`; set `JARVIS_HOME` to keep a separate instance. The API binds only to `127.0.0.1:4319`.

Conversations are persistent, independent, and addressable at `/chat/<id>`; refreshing or restarting keeps them. Rename, pin, archive and delete them from the sidebar, search everything with Ctrl+K, and manage projects and Jobs from their own pages when you want the detail.

`pnpm dev` is the normal supervised developer experience: it builds core and the orchestrator, generates a per-launch supervisor session outside the repository, starts `scripts/supervisor.mjs` (which owns the orchestrator) and Vite, and prints — exactly once — the self-upgrade activation token for that session. Keep it: activating a self-upgrade later asks for it in the browser. It is never written to disk, an environment variable, the database, or an API. Ctrl+C is a clean shutdown of the whole tree on every platform, and the ports become reusable. `pnpm dev:unsupervised` is the raw watch-oriented development loop: no supervisor, so it can prepare a self-upgrade but never activate one. Only explicitly allowlisted non-secret `JARVIS_*` variables reach the supervised runtime.

On every orchestrator start, the controlling terminal prints a one-use pairing secret valid for ten minutes. Enter it in the locked UI. The resulting high-entropy control credential stays in that exact browser origin's `localStorage`; private API and authenticated fetch-stream event requests attach it in `X-Jarvis-Control`. Jarvis stores only its SHA-256 hash. It deliberately does not use an authentication cookie: HTTP cookies are not port-scoped, while candidate runtimes share the host on other ports.

If one subscription is temporarily quota-limited, set `JARVIS_IMPLEMENTER_PROVIDER` and `JARVIS_REVIEWER_PROVIDER` to `claude` or `codex` before launch. The default remains Claude-first, and unavailable CLIs still fail closed.

On first semantic-memory use, Jarvis downloads `Xenova/multilingual-e5-small` into its local model cache. Retrieval falls back to SQLite FTS5 if the model or runtime is unavailable and works offline after the model is cached.

## Verify

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
```

`pnpm verify` (and its alias `pnpm verify:full`) is the complete deterministic gate: format, lint, typecheck, every non-live Vitest project including integration, build, and Playwright E2E. `pnpm test` means unit tests only; `pnpm test:all` means all non-live Vitest projects.

The Playwright suite gives **every test its own orchestrator**: a private `JARVIS_HOME` under `.jarvis/e2e/runtimes/`, its own database and its own port, booted by `tests/e2e/start-server.mjs` through the fixtures in `tests/e2e/fixtures.ts`. That is what makes `--repeat-each`, retries, test order and parallel workers safe, and it means the product carries no test-only reset or data-deletion surface: isolation is process-level, and the launcher refuses any home outside `.jarvis/e2e`. Each test checks the API is really answering `/health` with its own runtime nonce before it opens the UI, and a runtime that dies mid-test is reported as an orchestrator lifecycle failure rather than as a missing element.

Real subscription-provider tests are separate and never run through `test`, `verify`, or CI:

```powershell
$env:JARVIS_LIVE_AGENT_TESTS='1'
pnpm test:live-agents
```

The suite performs one tiny real edit per available CLI, strips API-key variables from provider children, and writes `.jarvis/live-agent-smoke.json`.

## Working vertical slice

1. Ask for the work in a conversation — "Create a job on Jarvis to fix the mobile nav", or "Implement OAuth in Sitepilot". Jarvis resolves the project from what you said, and asks which one if several are plausible. (Registering a repository on the Projects page is what makes it resolvable.)
2. A live Job card appears in the conversation, and the conversation stays usable while the Job runs.
3. Jarvis creates `jarvis/<job-id>` in an isolated worktree based on committed `HEAD`; dirty user files stay untouched and are excluded.
4. A real Claude/Codex worker receives a bounded, inspectable Context Pack.
5. Jarvis observes structured CLI events, runs explicit ordered verification steps, and performs an independent review. Critical/high code findings enter a bounded repair → verification → fresh-review loop.
6. Configured web projects run on isolated dynamic ports and receive scenario-based Playwright desktop/mobile evidence and subscription-backed visual review. High/medium visible findings enter a bounded visual repair → verification → code review → recapture loop.
7. Jarvis stores one compact project episode and validated memory proposals.
8. The user approves the exact reviewed candidate, then separately applies it. Application is clean-target, exact-ancestry, FF-only, idempotent, persisted, and never pushes.

For Jarvis itself, normal application is disabled. `pnpm dev` already runs Jarvis under the external supervisor; an approved candidate must pass isolated preflight, then a second explicit activation request — confirmed in the browser and authorised with the startup activation token — lets the supervisor apply, rebuild, restart, healthcheck, and roll back on failure. `pnpm supervisor <config.json>` remains the low-level entry point for tests and debugging.

Recoverable provider exhaustion, repair-budget exhaustion, and orchestrator restart pause the same Job with its worktree and checkpoint preserved. Resume validates repository/base/exact expected HEAD/cleanliness before rerunning the exact persisted repair kind and evidence. An uncheckpointed planning worktree is reusable only at the pinned base SHA. Raw messages/events are audit history, not default model context.

## Documentation

- [Conversations, projects, and jobs](docs/conversations.md)
- [Architecture](docs/architecture.md)
- [Memory architecture and policy](docs/memory.md)
- [Jobs, providers, and verification](docs/jobs-and-providers.md)
- [Self-development and visual QA](docs/self-development-and-visual-qa.md)
- [Tool execution, permissions, and recovery](docs/tool-permissions.md)
- [Roadmap and implementation status](docs/roadmap.md)
- [Bootstrap ADR](docs/decisions/0001-bootstrap-foundation.md)

## Security boundaries

- Local storage by default; runtime DB, models, logs, worktrees, screenshots, and `.env` are Git-ignored.
- Memory writes reject credential-like content, including explicit remember requests.
- Provider authentication remains inside official CLIs.
- Jobs never stash, force refs, resolve conflicts, push, or overwrite dirty user work.
- Self-activation requires explicit user action and the external supervisor boundary.
- Visual QA images remain evidence-only unless a real CLI reviewer successfully inspected them.
- Loopback is not authentication. Agent and candidate processes are hostile to the control plane: every private `/api/*` read or mutation requires the browser-held control credential, mutations also require the configured exact UI origin, and only `/health`, auth status/pairing, and CORS preflight remain unauthenticated. Bootstrap/control secrets are removed from child environments and never enter worktrees, URLs, events, or activation files.
- Conversation is not authority. The chat model never touches SQLite, Git, approval state, or the supervisor: it may only request one of a fixed set of validated actions, which trusted code decides. It cannot confirm its own destructive request, approve a candidate, apply a change, or activate a self-upgrade.
- Deleting a conversation never deletes its Jobs, your durable memory, or application evidence. Unregistering a project never deletes the repository from disk. An applied candidate can be archived but never hard-deleted.
- Tools run through one gated boundary. Risk classification plus the authenticated call site's actor decides run/confirm/refuse; privilege is never read from a request payload; agents cannot reach sensitive or destructive tools; every attempt is recorded before it runs. Standing grants bind the registered risk and explicit definition revision.
