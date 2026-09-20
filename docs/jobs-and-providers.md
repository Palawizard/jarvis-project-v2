# Jobs, providers, and verification

## Lifecycle

```text
queued -> planning -> implementing -> verifying
                                |         `-> verification fixer (bounded) --+
                                |                                             |
                                +----> reviewing <----------------------------+
                                          | critical/high/medium
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

Planning is deterministic: inspect the committed base, create an isolated worktree, and build an auditable Context Pack. No model call happens inside the pipeline whose only purpose would be restating the request — the structured brief, when there is one, was compiled once before the Job existed (see `docs/conversations.md`) and is carried on the Job as derived context beside the user's own request.

## Providers

`AgentProvider` exposes capabilities and structured execution/resume behavior. The registry routes by role and availability without leaking provider syntax into the pipeline.

- Claude Code uses official non-interactive `--print --output-format stream-json`, retains the session ID, and resumes fix work when possible.
- Codex uses official `codex exec --json` JSONL and retains the thread ID. The installed app-server is currently experimental, so V1 deliberately uses the stable CLI surface.
- Capability checks inspect CLI version and official login status and refresh periodically. Availability is what the installed CLI answers **now**; a recorded failure never subtracts from it.
- Quota/spend/session limits, unavailable/start errors, timeout, protocol failures, and a provider rejecting one of Jarvis's own output schemas (`schema_rejected`, “schema rejected by provider” — a Jarvis defect, never the reviewed code) are classified centrally. They are recorded for the UI, diagnostics and the routing reason — including the reset timestamp a provider named, when it named one — but they are **informational only**. There is no persistent cooldown gate: a provider that reported a limit ten minutes ago is routable on the very next attempt, because the user may have switched account, the provider may have recovered early, or the reported reset may simply have been wrong. Any of those used to make Resume impossible on a Job with nothing wrong with it.
- Provider attempts for one logical AI action are bounded by `JARVIS_PROVIDER_ATTEMPTS` (default 2, clamped to 1–2): the preferred provider, then one healthy alternate, then pause. The provider that just failed is ordered last for the next attempt inside the same action, so the retry does not route straight back to it. A later Resume starts a fresh bounded attempt. Cancellation is not failure and is never rerouted.
- Review always uses a fresh context, prefers a provider different from the implementer/fixer, and never resumes an implementation session. If only one provider is healthy, a fresh same-provider review is allowed.
- Every deterministic routing decision records role, provider, model, capability tier, effort, policy score, the factors behind it, reason, overrides, availability, avoidance, signals, and time.

### Model and effort policy

One central, deterministic policy (`packages/core/src/agents/policy.ts`) chooses the model AND the effort for every agent run. No extra model call is made to make the choice.

- The decision space is closed: Claude is `sonnet` (normal) or `opus` (strong), Codex is `gpt-5.6-terra` (normal) or `gpt-5.6-sol` (strong) — the real Codex CLI model IDs, not the `terra`/`sol` shorthand from the feature spec — and effort is `low`, `medium` or `high`. `haiku`, `xhigh` and `max` are unreachable, and the adapters reject anything outside the allowlists rather than forwarding it to a CLI.
- Two independent dimensions: `capabilityTier` (is a more capable model justified?) and `effort` (how deeply should it think?). `sonnet/high` and `opus/medium` are both valid and mean different things.
- Two producers, one non-authoritative `executionRecommendation` for the initial implementer: `normal|strong` capability, `low|medium|high` effort, and 1-4 concrete reasons.
  - **Chat Jobs** get it from the tool-free Brief Compiler, as one more field of the same structured call that compiles the brief. No extra selector call is added to that path, and none may be.
  - A Job with an `originMessageId` is chat-origin and never calls the Execution Advisor — including when its brief could not be compiled, or when it was created by the candidate button in a clarification. It falls back to the deterministic policy instead of adding a selector call to the chat path.
  - **Direct Jobs** — the Jobs page, `POST /api/jobs` without an origin message — have no brief and must not compile one just to choose a model. They get it from the **Execution Advisor** (`packages/core/src/jobs/advisor.ts`), a tool-free role with a FIXED normal/medium profile that answers this one question and nothing else. Its output schema has exactly three fields: there is no way to express a provider, a model ID, a project, a permission, a sandbox mode or an approval behaviour. It runs once per Job, before the implementer, and the answer is persisted on the Job so Resume never pays for it again.
  - For a continuation, the advisor is given trusted structured facts Jarvis measured — source HEAD and base, changed files and lines, workspaces touched, path-derived sensitive categories, verification state, unresolved high/medium findings — never a previous agent's prose. A three-word "continue" in front of five thousand changed lines of auth and recurrence work is judged on the remaining work, not on the length of the sentence.
  - When valid, the recommendation replaces request-length and brief-count scoring; trusted self-development/high-risk floors, security floors, role bounds, provider health and the fixed provider mapping still win. Missing or malformed advice falls back to deterministic policy and is **not** treated as a provider outage. Reviewer, fixer and Visual QA continue to route from post-implementation evidence.

| Request shape | Brief recommendation | Final implementer profile |
| --- | --- | --- |
| Documentation comment with no behavior change | normal/low | Claude Sonnet/medium after the implementer floor |
| Newest 400 Events plus duplicate-free pagination and live SSE | normal/high | Claude Sonnet/high |
| Google Calendar + iCloud bidirectional sync across credentials, persistence, tools and UI | strong/high | Claude Opus/high or Codex `gpt-5.6-sol`/high |
| Permissions, auth, or sandbox architecture | strong/high | Strong/high after trusted security floors |

- A small scoring table bands the result (`<0` normal/low, `0-2` normal/medium, `3-4` normal/high, `5-6` strong/medium, `>=7` strong/high). Trusted sensitive path categories (auth, permissions, sandbox/isolation, supervisor/activation, database migration) floor a source-touching role at strong/high.
- Per-role floors and ceilings are applied last and cannot be escaped: `router` and `autostart_verifier` are always normal/low, `brief_compiler` and `chat` never go strong, `reviewer` is never below high effort.
- Effort is really transmitted: `--effort` for Claude Code, `-c model_reasoning_effort="…"` for Codex. Both are probed from the installed CLI. When a CLI cannot take one, the flag is omitted and the routing decision records `effort not applied` instead of claiming otherwise.
- There is no model environment override. `JARVIS_CLAUDE_MODEL` / `JARVIS_CODEX_MODEL` were removed: they were a way to put an arbitrary model behind every role and bypass the role bounds. Explicit PROVIDER overrides are unchanged and remain authoritative when usable.

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
| `brief_compiler` | Scratch directory holding nothing but the JSON Schema its own answer is constrained to | **None** |

The last four are deliberately separate roles even though their confinement is
identical, because what they are trusted with is not. `chat` answers you and may
*request* a structured action. `router` classifies one message into a bounded
schema. `autostart_verifier` names the repository it thinks is meant, in a fresh
context, and its agreement is required before any unattended write-capable agent
starts. `brief_compiler` runs only once both have agreed, and is trusted with
nothing at all: it restates a settled request as derived context for the
implementer, and the Job stores the user's own words separately as the
authority. Folding them into one role would make "one model said so" sufficient
again, which is the thing the split exists to prevent. None of the three
non-conversational roles can call a tool, create a Job, or reach the database.

Their confinement is identical; their **inputs deliberately are not**. The
verifier is shown the router's conclusion — three bounded values, so that
trusted code can tell whether the two agree — and nothing else the router wrote:
no reasoning, no wording, no clarification question. It is also shown strictly
less than the router is: no transcript, no project summary or analysis profile,
no memories and no rendered tool output. Two runs over the same inputs are one
opinion counted twice, so a decision that only holds in the light of something
another model wrote fails the second check by construction. See
`docs/conversations.md` for the full provenance rule.

Five roles make a promise the provider itself has to keep, so none is routed to
a provider that cannot keep it. `chat`, `router`, `autostart_verifier` and
`brief_compiler` promise no tools and need `toolFreeChat`; `project_analyst` promises an exact
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

Routing runs are pinned by the model policy to the cheap bounded model at low
effort (`sonnet`/`gpt-5.6-terra`, `low`) and get a 90-second ceiling rather than
the 30-minute agent timeout: a one-sentence classification that has not answered
in that long has failed, not thought harder. Every message in a workspace with a
registered project spends one such run, and a message that routes to a code
change spends two. There is no retry and no third opinion, so a turn costs at
most two classifications however badly they go.

Authentication is always delegated to the installed CLI. Jarvis never reads OAuth tokens or requires API credits.

## Verification and review

Projects may define ordered `verification.steps` with `name`, `command`, `timeoutMs`, `required`, and `kind`. Setup/install is recorded separately from evidence, and a configured dependency install runs at the start of every verification cycle: `node_modules` or other filesystem residue is never treated as proof of successful setup. Auto-detected JavaScript, Python, Rust, and Go projects receive an explicit setup command before checks. Reports classify `none`, `product`, `infrastructure`, or `cancelled`: setup failure, spawn/start failure, missing executable, and timeout are infrastructure; an ordinary completed check with a non-zero exit is product failure only after setup succeeds. A report is `infrastructure` only when NO required check observed a product failure: one check killed at its time budget cannot un-observe a real non-zero exit standing next to it, because that exit is evidence about the candidate and a report classified infrastructure never reaches a fixer. A failed setup is still infrastructure whatever the later checks say, and cancellation still wins over both. Step budgets are configuration, not constants: `JARVIS_VERIFICATION_STEP_TIMEOUT_MS` (default 30 minutes) and `JARVIS_VERIFICATION_INSTALL_TIMEOUT_MS` (default 20 minutes) set the floor, and a project step's own `timeoutMs` still wins. Infrastructure retries are bounded by `JARVIS_VERIFICATION_INFRA_RETRIES` (default 2) and never invoke a source fixer; a retry re-runs setup and everything that is not yet proven, and reuses the checks that already passed on that exact commit, so getting past one flaky or timed-out step does not cost another full suite. Jarvis executes the trusted-project commands itself, shows exactly what ran, and cannot call unit-only evidence “all tests.” `kind: 'final'` marks a closing gate rather than a repair-loop check: those steps are skipped on every verification cycle and run once, alone, on the exact HEAD that has already passed review and visual QA and is about to be offered for approval. Any source change afterwards re-enters verification, clears the evidence heads, and re-runs the gate, so a final-gate result can never outlive the commit it was produced from. For Jarvis, `pnpm verify` covers format, lint, typecheck, unit and integration Vitest, build, and Playwright E2E; the self Visual QA catalog smoke is the `final` step, so `pnpm verify:full` is what a candidate that could be activated must pass. Live subscription-agent tests remain opt-in.

Review runs in a fresh, read-only provider context with the original request, acceptance criteria, reviewer Context Pack, changed files/diff, implementer summary as an untrusted claim, and deterministic verification evidence. The whole structured response must validate: no malformed finding is dropped, contradictory verdict/finding combinations are protocol errors or fail closed, and protocol errors retry/reroute the reviewer without invoking a fixer.

The review answer arrives through the provider's own constrained-output channel (`--json-schema` / `--output-schema`), with the terminal fenced block kept as a fallback for a CLI that cannot be constrained or that answers in prose anyway. Both paths end at the same strict validation, so nothing is loosened: a contradictory verdict, a blocking finding with no recommendation, or an answer that fails the schema is a protocol error, which is **infrastructure** — it consumes no review repair cycle, marks no HEAD as reviewed, and invalidates no verification evidence. The schema file is written under the artifacts directory, never into the candidate worktree. Every schema handed to a provider is written for STRICT Structured Outputs — root object, `additionalProperties: false`, every `properties` key listed in `required`, no `oneOf` — because Codex refuses anything else with `invalid_json_schema` before the model runs and the whole attempt is spent. An optional field is therefore spelled required-and-nullable, and the provider's `null` is normalized back to absence before the trusted Zod parse. `strict-schema.test.ts` asserts those rules over every exported provider schema.

Structured severity, not the reviewer's prose/verdict alone, determines blocking. Code defaults to `critical,high,medium`; only low/info remain persisted advisory findings. `codeReviewBlockingSeverities` is the single source of truth: the reviewer prompt defines each severity from it and names which ones block, the derivation in `review/engine.ts`, the pipeline's fixer gate and the Job view's blocking/advisory labels all read that one list. The model's own `verdict` field decides nothing — when it claims `approve` while the severities it reported derive `request_changes`, Jarvis emits `review.verdict.overridden` with the severities in question and the Job view says the gate corrected the reviewer. A source change clears the reviewed HEAD identity, so a new deterministic verification and independent review are mandatory. Limits are configurable through `JARVIS_MAX_REVIEW_FIX_CYCLES` (default 1 batch fixer) and `JARVIS_CODE_REVIEW_BLOCKING_SEVERITIES`.

### HEAD-bound evidence and repair budgets

Every expensive result is a statement about one exact candidate commit, and the Job row records which: `verifiedHead`, `reviewedHead`, `reviewBlockedHead`, `visualHead`, `visualAttemptHead`, `finalGateHead`. Evidence is valid while its head equals the current candidate and goes stale the moment the candidate moves — nothing is deleted, it simply stops matching, and every historical row keeps the `head_ref` it describes.

Two currencies, deliberately not mixed:

- **Product repair budgets** count fixer runs that actually changed the candidate in response to real evidence. `JARVIS_MAX_FIX_CYCLES` (default 2 verification fixers), `JARVIS_MAX_REVIEW_FIX_CYCLES` (default 1), `JARVIS_MAX_VISUAL_FIX_CYCLES` (default 1). A counter is charged only after its fixer has completed, so a provider outage before it starts leaves the budget intact.
- **Provider attempts** are the separate `JARVIS_PROVIDER_ATTEMPTS` budget above. Infrastructure failures never consume a product budget.

The second verification fixer has to earn it. Each failing report gets a stable failure signature — the failing step set, statuses, exit codes and a normalized tail with timings, timestamps, hashes and line/column noise removed. A second fixer runs only when that signature actually moved; an identical signature means the previous repair changed nothing that matters, and the Job pauses instead of looping. Real progress — "unit and integration both fail" becoming "two stale unit assertions, integration green" — is exactly what the signature detects, and what a bare counter used to pause on.

## Pause, resume, and validation-only recovery

Running jobs checkpoint the logical stage, base, worktree, exact candidate HEAD, cycle counts, last provider/session, repair kind, and the relevant verification/review/visual evidence IDs and findings. On restart they become `paused` without replacing that evidence with the restart reason.

**Resume computes the next useful transition; it does not replay the stage it paused in.** `planNextTransition` (`packages/core/src/jobs/evidence.ts`) is deterministic trusted code — no model decides a state transition — and it reads the current commit, the persisted evidence heads and the remaining repair budgets to choose exactly one of: continue an interrupted agent run, verify, repair verification, review, repair the review, run Visual QA, repair a visual defect, run the final gate, finish, or **nothing**. An expensive stage whose evidence already describes the current commit is skipped and audited as `job.evidence.reused`. The same planner answers `GET /api/jobs/:id` as `resumePlan`, so the paused-Job view can say what Resume will do, which stages will be reused and when nothing useful can happen — instead of offering a button that spends quota to arrive back where it started.

Exact HEAD binding is unchanged as a security property, but an unexpected HEAD is now a classified recovery decision rather than a permanent refusal:

- **Trusted agent change.** A commit produced by a run Jarvis itself launched into the worktree it owns is recorded as the candidate, whatever the run's outcome — including a run that committed and then failed on quota. A run that ends without completing also has its uncommitted work committed as a checkpoint before the Job pauses, so a pipeline-written pause always leaves a known candidate and a clean worktree. Only when an **orchestrator restart** (`restartReason = orchestrator_restart`, written solely by crash recovery and cleared by every pipeline pause) interrupted an implementing/fixing run does Resume attribute an unrecorded descendant commit, or uncommitted changes, to that run. This is what stops committed agent work from becoming unreachable behind "recovery HEAD changed" without letting a human commit made during an ordinary pause pass as agent work.
- **External HEAD change.** A commit Jarvis did not create — including any commit made after the pipeline paused and recorded its agent's HEAD — is never silently adopted. The Job pauses with named options; `job.adoptHead` (`sensitive`, human-confirmed, unreachable by any agent) is the explicit adopt, and it invalidates the evidence bound to the previous commit so the required stages run again.
- **Dirty worktree.** Uncommitted changes Jarvis did not make are never auto-committed; the mismatch is surfaced and an explicit choice is required.
- **Advanced target.** A target repository that has moved past the Job's base is still a refusal: a candidate is only meaningful relative to the base it branched from.

Without an expected candidate checkpoint, planning recovery accepts only `HEAD === base SHA`. Implementation/fix may resume the same external session; a fresh fixer reconstructs the same persisted evidence prompt.

`POST /api/jobs` also accepts `validationOnly: true` with a pinned `candidateSource: { baseSha, sourceSha }`. Git plumbing verifies both commits and ancestry, creates the isolated job worktree from the explicit base, applies the exact binary base-to-source delta, proves tree parity, commits only on the job branch, skips implementation, and starts at verification. Validation-only jobs never invoke verification, code-review, or visual source fixers and never commit verification-produced changes; exact materialized HEAD, cleanliness, and source-tree parity are rechecked after every gate. It never checks out or mutates the source ref.

The candidate branch/worktree, implementation result, verification, structured findings, routing decisions, Context Pack selections, screenshots, and episode remain inspectable. Approval binds the exact clean reviewed HEAD. A separate application transaction requires a clean registered target at the candidate base and performs only `git merge --ff-only`; divergence fails closed, repeat apply is idempotent, candidate provenance is retained, and no remote push occurs.

`test:live-agents` is opt-in, quota-conscious, one-attempt proof of the real Claude/Codex CLI process, structured events, session/thread identity, file edit, and deterministic verification. API-key environment variables are removed from provider children so this path cannot silently prefer API billing.
