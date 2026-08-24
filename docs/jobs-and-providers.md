# Jobs, providers, and verification

## Lifecycle

```text
queued -> planning -> implementing -> verifying
                                |         `-> verification fixer (bounded) --+
                                |                                             |
                                +----> reviewing <----------------------------+
                                          | critical/high
                                          v
                                     code fixer --commit--> verifying (max 2)
                                          |
                                          v pass/advisory
                                      visual_qa
                                          | high/medium
                                          v
                                    visual fixer --commit--> verifying
                                          |                    -> fresh review
                                          +---------------------> fresh visual QA (max 2)
                                          |
                                          v pass/advisory
                                    awaiting_user -> approved -> FF-only applied
```

Any active stage may become `paused` or `cancelled`. Provider exhaustion, restart, or bounded repair exhaustion is recoverable and preserves the same worktree/head; `failed` is for irrecoverable setup or corrupt state. `awaiting_user` means a candidate passed configured gates and remains isolated. State transitions are validated centrally and persisted as events.

Planning is deterministic: inspect the committed base, create an isolated worktree, and build an auditable Context Pack. This avoids a model call whose only purpose would be restating the request.

## Providers

`AgentProvider` exposes capabilities and structured execution/resume behavior. The registry routes by role and availability without leaking provider syntax into the pipeline.

- Claude Code uses official non-interactive `--print --output-format stream-json`, retains the session ID, and resumes fix work when possible.
- Codex uses official `codex exec --json` JSONL and retains the thread ID. The installed app-server is currently experimental, so V1 deliberately uses the stable CLI surface.
- Capability checks inspect CLI version and official login status and refresh periodically. Runtime rate limits enter a temporary cooldown.
- Quota/spend/session limits, cooldown, unavailable/start errors, timeout, and protocol failures are classified centrally. The failed run remains in history and the same stage reroutes up to `JARVIS_AGENT_STAGE_RETRIES` (default 2 retries). Cancellation is not failure and is never rerouted.
- Review always uses a fresh context, prefers a provider different from the implementer/fixer, and never resumes an implementation session. If only one provider is healthy, a fresh same-provider review is allowed.
- Every deterministic routing decision records role, provider, model, reason, overrides, availability, avoidance, task profile, and time.
- Model profiles are cheap rules: mechanical work uses economy, ordinary work balanced, and high-risk/self-development quality. Explicit provider environment overrides remain authoritative when usable.

Authentication is always delegated to the installed CLI. Jarvis never reads OAuth tokens or requires API credits.

## Verification and review

Projects may define ordered `verification.steps` with `name`, `command`, `timeoutMs`, `required`, and `kind`. Setup/install is recorded separately from evidence, and a configured dependency install runs at the start of every verification cycle: `node_modules` or other filesystem residue is never treated as proof of successful setup. Reports classify `none`, `product`, `infrastructure`, or `cancelled`: setup failure, spawn/start failure, missing executable, and timeout are infrastructure; an ordinary completed check with a non-zero exit is product failure only after setup succeeds. Infrastructure retries are bounded by `JARVIS_VERIFICATION_INFRA_RETRIES` (default 2) and never invoke a source fixer. Jarvis executes the trusted-project commands itself, shows exactly what ran, and cannot call unit-only evidence “all tests.” For Jarvis, `pnpm verify` covers format, lint, typecheck, all non-live Vitest projects (unit and integration), build, and Playwright E2E. Live subscription-agent tests remain opt-in.

Review runs in a fresh, read-only provider context with the original request, acceptance criteria, reviewer Context Pack, changed files/diff, implementer summary as an untrusted claim, and deterministic verification evidence. The whole structured response must validate: no malformed finding is dropped, contradictory verdict/finding combinations are protocol errors or fail closed, and protocol errors retry/reroute the reviewer without invoking a fixer.

Structured severity, not the reviewer's prose/verdict alone, determines blocking. Code defaults to `critical,high`; medium/low/info remain persisted advisory findings. A source change clears the reviewed HEAD identity, so a new deterministic verification and independent review are mandatory. Limits are configurable through `JARVIS_MAX_REVIEW_FIX_CYCLES` and `JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES`.

## Pause, resume, and validation-only recovery

Running jobs checkpoint the logical stage, base, worktree, exact candidate HEAD, cycle counts, last provider/session, repair kind, and the relevant verification/review/visual evidence IDs and findings. On restart they become `paused` without replacing that evidence with the restart reason; `POST /api/jobs/:id/resume` first validates repository identity, worktree existence, exact expected HEAD, and understood cleanliness. Without an expected candidate checkpoint, planning recovery accepts only `HEAD === base SHA`. Implementation/fix may resume the same external session; a fresh fixer reconstructs the same persisted evidence prompt. Verification reruns; review is fresh; Visual QA restarts and recaptures.

`POST /api/jobs` also accepts `validationOnly: true` with a pinned `candidateSource: { baseSha, sourceSha }`. Git plumbing verifies both commits and ancestry, creates the isolated job worktree from the explicit base, applies the exact binary base-to-source delta, proves tree parity, commits only on the job branch, skips implementation, and starts at verification. It never checks out or mutates the source ref.

The candidate branch/worktree, implementation result, verification, structured findings, routing decisions, Context Pack selections, screenshots, and episode remain inspectable. Approval binds the exact clean reviewed HEAD. A separate application transaction requires a clean registered target at the candidate base and performs only `git merge --ff-only`; divergence fails closed, repeat apply is idempotent, candidate provenance is retained, and no remote push occurs.

`test:live-agents` is opt-in, quota-conscious, one-attempt proof of the real Claude/Codex CLI process, structured events, session/thread identity, file edit, and deterministic verification. API-key environment variables are removed from provider children so this path cannot silently prefer API billing.
