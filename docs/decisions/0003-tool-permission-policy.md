# 0003 — One gated boundary for tool execution

## Context

The tool registry gated calls with a `maxRisk` ceiling supplied by the caller,
and the HTTP route read that ceiling out of the request body. Any caller could
name its own privileges. Nothing was recorded, nothing survived a restart, and
the registry handed out no way to see what had been attempted.

The next phase (screen/desktop, Gmail, Calendar, voice, automations) is exactly
the set of capabilities where that is unacceptable.

## Decision

One class owns the tool table, the policy decision, the audit row and the
recovery pass. The catalog is a private field with no accessor, so there is no
second path from "a tool exists" to "a tool ran".

Privilege comes from an `actor` asserted by the call site in code, never from a
payload. Risk classification per tool plus actor decides allow/confirm/deny.
Standing permissions can only upgrade `confirm` to `allow`, never overturn a
`deny`, and never cover a `destructive` action. Agents cannot reach `sensitive`
or `destructive` at all.

Every attempt is persisted before it runs. Anything left running at startup is
marked interrupted and surfaced; it is never replayed automatically, because
Jarvis cannot know a tool is idempotent.

## Consequences

- Registering a future tool means declaring a risk level, nothing more.
- Refusals, timeouts and interrupted actions are first-class UI content.
- Loopback is not authority. Private API access requires the origin-bound browser
  control credential, and mutations additionally require the exact configured
  Origin; residual same-user browser/profile compromise is documented in
  `docs/tool-permissions.md`.
