# Jarvis

Jarvis is a local-first assistant foundation that can remember durable context, run coding jobs in isolated Git worktrees, verify and independently review them, present a candidate for explicit approval, and safely fast-forward it into a clean target repository.

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

Open <http://localhost:5199>. Runtime data defaults to `~/.jarvis`; set `JARVIS_HOME` to keep a separate instance. The API binds only to `127.0.0.1:4319`.

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

Real subscription-provider tests are separate and never run through `test`, `verify`, or CI:

```powershell
$env:JARVIS_LIVE_AGENT_TESTS='1'
pnpm test:live-agents
```

The suite performs one tiny real edit per available CLI, strips API-key variables from provider children, and writes `.jarvis/live-agent-smoke.json`.

## Working vertical slice

1. Select or register a local Git project.
2. Enter a coding request in Command.
3. Jarvis creates `jarvis/<job-id>` in an isolated worktree based on committed `HEAD`; dirty user files stay untouched and are excluded.
4. A real Claude/Codex worker receives a bounded, inspectable Context Pack.
5. Jarvis observes structured CLI events, runs explicit ordered verification steps, and performs an independent review. Critical/high code findings enter a bounded repair → verification → fresh-review loop.
6. Configured web projects run on isolated dynamic ports and receive scenario-based Playwright desktop/mobile evidence and subscription-backed visual review. High/medium visible findings enter a bounded visual repair → verification → code review → recapture loop.
7. Jarvis stores one compact project episode and validated memory proposals.
8. The user approves the exact reviewed candidate, then separately applies it. Application is clean-target, exact-ancestry, FF-only, idempotent, persisted, and never pushes.

For Jarvis itself, normal application is disabled. Run Jarvis through `pnpm supervisor <config.json>`; an approved candidate must pass isolated preflight, then a second explicit activation request lets the external supervisor apply, rebuild, restart, healthcheck, and roll back on failure.

Recoverable provider exhaustion, repair-budget exhaustion, and orchestrator restart pause the same Job with its worktree and checkpoint preserved. Resume validates repository/base/exact expected HEAD/cleanliness before rerunning the exact persisted repair kind and evidence. An uncheckpointed planning worktree is reusable only at the pinned base SHA. Raw messages/events are audit history, not default model context.

## Documentation

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
- Tools run through one gated boundary. Risk classification plus the authenticated call site's actor decides run/confirm/refuse; privilege is never read from a request payload; agents cannot reach sensitive or destructive tools; every attempt is recorded before it runs. Standing grants bind the registered risk and explicit definition revision.
