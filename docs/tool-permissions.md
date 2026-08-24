# Tool execution, permissions and recovery

Jarvis runs actions through one boundary: `ToolRegistry` in `packages/core/src/tools/`.
It classifies, decides, records, and recovers. Nothing else runs a tool.

This layer exists ahead of the modules that need it — screen/desktop, Gmail,
Calendar, voice, automations. None of those are implemented; registering one is
supposed to be a matter of declaring its risk level, not of inventing permission
logic again.

Two things to be clear about up front. The registered tools today are `observe`,
`reversible_modification` and one `destructive` (`memory.purge`); the
`sensitive` tier is exercised by tests, not by shipped functionality. And the
coding agents do not call this registry at all yet — they are CLI subprocesses
with their own tooling. `actor: 'agent'` is therefore the rule that will apply
when they do, enforced and tested now so it is not retrofitted later.

## Risk classification

| Level | Meaning | Examples |
| --- | --- | --- |
| `observe` | Reads state, changes nothing | `memory.search`, `project.list` |
| `safe_action` | Changes only Jarvis-internal scratch state | — |
| `reversible_modification` | Changes durable state that can be undone | `memory.store`, `job.create` |
| `sensitive` | Touches private data or the outside world | mail, calendar, screen, desktop input |
| `destructive` | Loses data, or has no undo | `memory.purge`, sending, paying |

Classification is the only thing a tool author has to get right.

## Decision

`packages/core/src/tools/policy.ts` is pure: risk × actor → `allow`, `confirm`, `deny`.

| | observe | safe_action | reversible | sensitive | destructive |
| --- | --- | --- | --- | --- | --- |
| user | allow | allow | allow | confirm | confirm |
| agent | allow | allow | **confirm** | **deny** | **deny** |
| system | allow | allow | allow | confirm | **deny** |

Three rules hold regardless of configuration, grants, or call arguments:

1. **An agent never reaches `sensitive` or `destructive`.** Broader agent powers
   are a future decision, not something that leaks in on the day someone
   registers a tool with the wrong actor.
2. **A standing permission can only turn `confirm` into `allow`.** It can never
   overturn a `deny`, and it is capped at `sensitive` — a `destructive` action
   always comes back to a human, grant or no grant.
3. **`maxRisk` only tightens.** A call site may lower its own ceiling. There is
   no value, in any argument, that raises it.

## Standing permissions ("always allow this here")

A grant is `(tool, actor, approved risk, approved definition revision, project?, session?)` with an optional expiry. A `NULL`
scope column means "any"; a set one must match exactly, so a permission granted
for one project never applies to another. A grant matches only when both risk and explicit definition revision equal the currently registered tool. Drift never updates a grant; it requires a fresh permission, including when a risk change would otherwise lower the base policy. Schema-v5 migration revokes legacy grants lacking either integrity field rather than inferring a safe revision.

Revocation keeps the row, so a past execution can still point at the permission
that authorised it.

Standing permissions are only ever granted to the user's own actions.
`ToolRegistry.grant()` rejects any other actor, so this holds for every caller,
not just the HTTP route — and `#matchingGrant` additionally refuses to match a
grant row belonging to a non-user actor, so a row written directly into the
database (or left by an older build) authorises nothing.

Approving a single agent invocation stays possible; remembering it does not.
Delegated autonomy for agents is gated behind the OS-isolation milestone in
`docs/roadmap.md`.

## Audit

Every attempt writes one `tool_executions` row — including the refused ones,
which are the interesting ones. The row is written *before* the tool runs, which
is what makes a crash recoverable. It holds the decision, the reason, the actor,
the context, the arguments, the result or error, and the duration.

Stored arguments come in two flavours and the difference matters:

- **Accepted** arguments are the exact validated payload, because an approval
  that outlives the process replays it. They are therefore never truncated, and
  a call whose arguments contain something matching a credential pattern is
  refused outright rather than stored redacted — a redacted argument would
  silently execute with mangled input.
- **Rejected** arguments are audit text only. They are redacted and bounded, and
  `inputValidated` is false, which is what blocks them from ever being replayed.

An approval is bound to three persisted integrity values: the reviewed risk, the tool's required explicit `revision`, and SHA-256 of the canonical accepted JSON payload. Zod validation/transformation runs once when the request is created; approval passes that exact stored canonical value to the implementation without a second semantic transform. Any risk/revision/hash mismatch expires the request without running or creating a grant. Tool authors must bump `revision` whenever input schema or security-relevant semantics change; hashing function source or runtime internals is intentionally forbidden.

Tool *results* are always redacted and bounded; a result is never re-executed,
so redaction there is lossless.

## Long actions and recovery

- Every invocation has a timeout (`JARVIS_TOOL_TIMEOUT_MS`, default 60s, or the
  tool's own `timeoutMs`). When it fires, Jarvis aborts `ctx.signal` and stops
  waiting.

  Aborting a signal does not stop arbitrary code. A tool that watches the signal
  can cancel its own work; a tool that ignores it keeps running and may still
  produce its side effect long after Jarvis gave up. So a timeout is recorded as
  `timed_out`, distinct from an ordinary `failed`, and carries
  `effectUnknown: true` — the same marker `interrupted` gets. Both mean "Jarvis
  cannot say whether this happened", and the UI offers them as *Re-issue anyway*
  rather than *Re-issue*, because a re-issue may duplicate a real-world action.
- A deterministic rejection is `failed` with `effectUnknown: false`: the tool
  reported that nothing happened.
- On boot, `recoverInterrupted()` marks every `running` row `interrupted`. Its
  effect on the outside world is unknown, so it is surfaced and **never**
  replayed automatically. Re-issuing is an explicit user action that goes back
  through the policy from the start, at the **original** execution's actor: an
  agent's action re-issued stays an agent action, so it is decided at the
  agent's privilege and still needs a confirmation.
- Pending approval requests older than `JARVIS_TOOL_APPROVAL_TTL_MS` (default
  24h) expire, so an old prompt cannot be answered later against changed state.
- Approval survives a restart: the request holds the validated payload, so
  answering it after a reboot runs exactly what was asked for.
- Only `interrupted`, `timed_out`, `expired`, and `failed` executions may be explicitly re-issued. Succeeded, running, pending, and freshly denied rows are not retryable. Every re-issue re-enters current policy and records its parent execution and original run attribution.
- Finished rows are pruned after `JARVIS_TOOL_AUDIT_RETENTION_DAYS` (default 90).
  Open rows are never pruned.

## Security analysis: how this could be bypassed

### Closed

- **Caller-asserted privilege.** `POST /api/tools/:name` used to read `maxRisk`
  out of the request body, defaulting to `reversible_modification`. Any caller
  could name its own ceiling. The actor is now fixed in code at each call site;
  the only thing a request can still say about risk is a *lower* ceiling.
- **Reaching the implementation directly.** The tool table is a private class
  field with no accessor. There is no `get(name)` returning a `ToolDefinition`,
  so there is no object on which `.execute()` can be called behind the policy.
  A unit test asserts no such accessor reappears.
- **Grant escalation.** Grants are re-evaluated against the live tool
  definition, bind risk and definition revision, cannot lift a `deny`, and cannot cover `destructive`.
- **Approval swapping.** Approval takes an id and no payload, and replays the
  stored canonical arguments. Approving a benign request cannot be turned into
  approving a different one. Risk, required definition revision, and canonical
  payload hash must all match; legacy pending rows without them expire during
  schema-v4 migration and legacy grants without identity are revoked by schema v5.
- **Approval replay.** Claiming a pending row is a conditional `UPDATE ... WHERE
  status='pending_approval'`, so two concurrent approvals cannot both run it.
- **Risk downgrade by tampering.** The decision reads risk from the registered
  definition, never from the `risk` column of the row being approved.
- **Credentials in the audit log.** Arguments are secret-scanned and refused;
  results are redacted.
- **Silent replay after a crash.** Interrupted actions are never auto-resumed.

### Human HTTP authority and residual OS isolation

Loopback is explicitly untrusted. All private reads and human-authority mutations require the random browser control credential; mutations additionally enforce exact Origin. Pairing uses an in-memory one-use secret printed only to the human terminal. Only its control-token hash persists. The UI keeps the raw credential in origin-scoped storage and sends a custom header, never a cookie, URL, SSE query, child environment, log, event, worktree, or supervisor request. Therefore a same-user loopback client without the browser capability cannot call a route that hardcodes `actor:user`.

`POST /api/auth/revoke` invalidates the persisted credential. Clear the browser's `jarvis-human-control` local-storage entry, restart Jarvis, and enter the newly printed bootstrap to pair again. An already-paired startup does not mint another bootstrap. Static UI, `/health`, `/api/auth/status`, `/api/auth/pair`, and CORS `OPTIONS` preflight are the only unauthenticated surfaces.

This does not claim verified OS process isolation: same-OS-user malware that can inspect/control the human browser or read its profile is outside this browser-capability boundary. `AgentIsolationBackend.preflight()` remains false until a restricted user/container can verify process, filesystem/credential, and control-plane network separation. Sensitive agent tools therefore remain denied even though ordinary agent/candidate loopback impersonation is closed.

Two smaller residual notes:

- Secret detection is pattern-based (`memory/secrets.ts`). It is deliberately
  conservative, but it is not a proof.
- `ctx.signal` is cooperative. Generic code cannot be forcibly cancelled, so a
  tool that ignores the signal can still complete its side effect after Jarvis
  has given up. This is recorded (`timed_out`, `effectUnknown`) rather than
  papered over, and it is a reason to prefer tools that honour the signal.

## Adding a tool

```ts
registry.register({
  name: 'calendar.create_event',
  revision: '1',
  description: 'Create an event in the connected calendar.',
  risk: 'sensitive',
  input: z.object({ title: z.string(), startsAt: z.string() }),
  timeoutMs: 15_000,
  async execute(input, ctx) {
    /* ... */
  },
});
```

That is the whole integration. Get `risk` right and the rest — confirmation,
standing permissions, audit, recovery, UI — already applies.
