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
                                   UI changed?
                                     no |        | yes
                                        |        v
                                        |   interactive visual QA (attempt 1)
                                        |        |
                                        |        +-- product_defect --> visual fixer (max 1)
                                        |        |        --commit--> verifying -> fresh review
                                        |        |        -> targeted visual recheck (failed
                                        |        |           check goals only)
                                        |        +-- inconclusive / infra --> ONE fresh retry
                                        |        |        -> still inconclusive: record the
                                        |        |           status and continue (never a
                                        |        |           third attempt, never a fixer)
                                        |        v pass
                                        v        v
                                    awaiting_user -> approved -> FF-only applied
```

Visual QA eligibility is deterministic and costs no model call: a candidate that changed no
rendered UI records `visualQaStatus: 'skipped'` and no browser starts. There is no path with a
third visual attempt, a second visual fixer, or a plan-repair loop; a new attempt needs a new Job.

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

### Roles and what each one may touch

| Role | Working directory | Tools |
| --- | --- | --- |
| `implementer`, `fixer`, `visual_fixer` | Isolated job worktree | Full; Codex runs `workspace-write` |
| `reviewer` | Job worktree, read-only | Read-only permission mode; Codex `read-only` |
| `visual_reviewer` | Artifact directory | `Read` only |
| `project_analyst` | Disposable worktree pinned to the project's committed HEAD, confined by `--restricted` | `Read,Glob,Grep` only — never Bash, Edit or Task |
| `chat` | Empty scratch directory, never a repository and never the Jarvis home | **None** |
| `router` | Empty scratch directory | **None** |
| `autostart_verifier` | Empty scratch directory | **None** |

The last three are deliberately separate roles even though their confinement is
identical, because what they are trusted with is not. `chat` answers you and may
*request* a structured action. `router` classifies one message into a bounded
schema. `autostart_verifier` names the repository it thinks is meant, in a fresh
context, and its agreement is required before any unattended write-capable agent
starts. Folding them into one role would make "one model said so" sufficient
again, which is the thing the split exists to prevent. Neither routing role can
call a tool, create a Job, or reach the database.

Their confinement is identical; their **inputs deliberately are not**. The
verifier is shown the router's conclusion — three bounded values, so that
trusted code can tell whether the two agree — and nothing else the router wrote:
no reasoning, no wording, no clarification question. It is also shown strictly
less than the router is: no transcript, no project summary or analysis profile,
no memories and no rendered tool output. Two runs over the same inputs are one
opinion counted twice, so a decision that only holds in the light of something
another model wrote fails the second check by construction. See
`docs/conversations.md` for the full provenance rule.

Four roles make a promise the provider itself has to keep, so none is routed to
a provider that cannot keep it. `chat`, `router` and `autostart_verifier`
promise no tools and need `toolFreeChat`; `project_analyst` promises an exact
read-only allowlist and needs `enforcesToolAllowlist`. Only Claude declares
either today. Codex's `read-only` sandbox prevents writes but still runs shell
commands, which is not the same guarantee, so it serves none of them — a role
goes unserved rather than being served with a weaker promise than the one stated
here.

Every tool-free role is tool-free at two independent levels, because one of them
is a flag in someone else's release process. Configuration: `--tools ''`
disables the whole built-in set, `--disallowed-tools` additionally names by hand
the tools whose appearance here would be a security event (`AskUserQuestion`,
`Task`, `Explore`, `Bash`, `Edit`, `Read`, …), `--permission-mode plan` denies
writes, and `--restricted` confines the file tools to the working directory —
which is what the analyst needs, since it is told to read a registered
repository's README and CLAUDE.md and those are somebody else's text. Runtime:
if a tool-free run emits any provider-native tool-use event anyway, that is a
**protocol violation** — the run is aborted, its output is discarded rather than
shown as an answer or parsed as a decision, and the tool event is never
forwarded, so nothing downstream can render a provider's own question as Jarvis
UI or accept a provider subagent's exploration as conversation. Codex is never
routed to any of them: it does not declare `toolFreeChat`, and its `read-only`
sandbox is read-only, not tool-free. A structured `jarvis-action` block is text,
not a tool call, and is unaffected.

Routing runs use the balanced model profile and a 90-second ceiling rather than
the 30-minute agent timeout: a one-sentence classification that has not answered
in that long has failed, not thought harder. Every message in a workspace with a
registered project spends one such run, and a message that routes to a code
change spends two. There is no retry and no third opinion, so a turn costs at
most two classifications however badly they go.

Authentication is always delegated to the installed CLI. Jarvis never reads OAuth tokens or requires API credits.

## Verification and review

Projects may define ordered `verification.steps` with `name`, `command`, `timeoutMs`, `required`, and `kind`. Setup/install is recorded separately from evidence, and a configured dependency install runs at the start of every verification cycle: `node_modules` or other filesystem residue is never treated as proof of successful setup. Auto-detected JavaScript, Python, Rust, and Go projects receive an explicit setup command before checks. Reports classify `none`, `product`, `infrastructure`, or `cancelled`: setup failure, spawn/start failure, missing executable, and timeout are infrastructure; an ordinary completed check with a non-zero exit is product failure only after setup succeeds. Infrastructure retries are bounded by `JARVIS_VERIFICATION_INFRA_RETRIES` (default 2) and never invoke a source fixer. Jarvis executes the trusted-project commands itself, shows exactly what ran, and cannot call unit-only evidence “all tests.” For Jarvis, `pnpm verify` covers format, lint, typecheck, all non-live Vitest projects (unit and integration), build, and Playwright E2E. Live subscription-agent tests remain opt-in.

Review runs in a fresh, read-only provider context with the original request, acceptance criteria, reviewer Context Pack, changed files/diff, implementer summary as an untrusted claim, and deterministic verification evidence. The whole structured response must validate: no malformed finding is dropped, contradictory verdict/finding combinations are protocol errors or fail closed, and protocol errors retry/reroute the reviewer without invoking a fixer.

Structured severity, not the reviewer's prose/verdict alone, determines blocking. Code defaults to `critical,high`; medium/low/info remain persisted advisory findings. A source change clears the reviewed HEAD identity, so a new deterministic verification and independent review are mandatory. Limits are configurable through `JARVIS_MAX_REVIEW_FIX_CYCLES` and `JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES`.

## Pause, resume, and validation-only recovery

Running jobs checkpoint the logical stage, base, worktree, exact candidate HEAD, cycle counts, last provider/session, repair kind, and the relevant verification/review/visual evidence IDs and findings. On restart they become `paused` without replacing that evidence with the restart reason; `POST /api/jobs/:id/resume` first validates repository identity, worktree existence, exact expected HEAD, and understood cleanliness. Without an expected candidate checkpoint, planning recovery accepts only `HEAD === base SHA`. Implementation/fix may resume the same external session; a fresh fixer reconstructs the same persisted evidence prompt. Verification reruns; review is fresh; Visual QA restarts as a fresh interactive attempt against the exact HEAD.

`POST /api/jobs` also accepts `validationOnly: true` with a pinned `candidateSource: { baseSha, sourceSha }`. Git plumbing verifies both commits and ancestry, creates the isolated job worktree from the explicit base, applies the exact binary base-to-source delta, proves tree parity, commits only on the job branch, skips implementation, and starts at verification. Validation-only jobs never invoke verification, code-review, or visual source fixers and never commit verification-produced changes; exact materialized HEAD, cleanliness, and source-tree parity are rechecked after every gate. It never checks out or mutates the source ref.

The candidate branch/worktree, implementation result, verification, structured findings, routing decisions, Context Pack selections, screenshots, and episode remain inspectable. Approval binds the exact clean reviewed HEAD. A separate application transaction requires a clean registered target at the candidate base and performs only `git merge --ff-only`; divergence fails closed, repeat apply is idempotent, candidate provenance is retained, and no remote push occurs.

`test:live-agents` is opt-in, quota-conscious, one-attempt proof of the real Claude/Codex CLI process, structured events, session/thread identity, file edit, and deterministic verification. API-key environment variables are removed from provider children so this path cannot silently prefer API billing.
