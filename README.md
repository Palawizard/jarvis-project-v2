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

`pnpm verify` runs format, lint, typecheck, all Vitest projects, and build. E2E is separate because it starts a real local server and browser.

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
5. Jarvis observes structured CLI events, runs configured verification commands, and performs an independent review.
6. Configured web projects run on isolated dynamic ports and receive deterministic Playwright desktop/mobile evidence and subscription-backed visual review.
7. Jarvis stores one compact project episode and validated memory proposals.
8. The user approves the exact reviewed candidate, then separately applies it. Application is clean-target, exact-ancestry, FF-only, idempotent, persisted, and never pushes.

For Jarvis itself, normal application is disabled. Run Jarvis through `pnpm supervisor <config.json>`; an approved candidate must pass isolated preflight, then a second explicit activation request lets the external supervisor apply, rebuild, restart, healthcheck, and roll back on failure.

Failure, cancellation, review, verification, provider capability, and restart-recovery states are persisted and visible. Raw messages/events are audit history, not default model context.

## Documentation

- [Architecture](docs/architecture.md)
- [Memory architecture and policy](docs/memory.md)
- [Jobs, providers, and verification](docs/jobs-and-providers.md)
- [Self-development and visual QA](docs/self-development-and-visual-qa.md)
- [Roadmap and implementation status](docs/roadmap.md)
- [Bootstrap ADR](docs/decisions/0001-bootstrap-foundation.md)

## Security boundaries

- Local storage by default; runtime DB, models, logs, worktrees, screenshots, and `.env` are Git-ignored.
- Memory writes reject credential-like content, including explicit remember requests.
- Provider authentication remains inside official CLIs.
- Jobs never stash, force refs, resolve conflicts, push, or overwrite dirty user work.
- Self-activation requires explicit user action and the external supervisor boundary.
- Visual QA images remain evidence-only unless a real CLI reviewer successfully inspected them.
