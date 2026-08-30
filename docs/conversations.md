# Conversations, projects, and jobs

Jarvis is a chat assistant first. You open it and talk to it. Projects and Jobs
are capabilities it can use from that conversation, not a form you must fill in
before it will respond.

```text
pnpm dev
    |
Jarvis opens as a conversational assistant
    |
conversations are persistent and independent
    |
talk normally  -- an ordinary question is an ordinary answer
    |
when you want work done, ask for it in words
    |
background Jobs surface as live cards in the conversation
    |
human approval and self-upgrade boundaries stay explicit
```

## What happens to a message

Every message you send takes exactly one of these paths.

1. **Explicit memory command** — `remember …`, `forget …`, `update …`. Handled
   deterministically and locally. No model call, so no provider quota is spent
   deciding that "remember that I prefer pnpm" is a memory command. An ambiguous
   `forget` renders the exact candidates in chat rather than guessing.
2. **Ordinary conversation** — an explanation, an opinion, brainstorming, a
   question about Jarvis itself. This produces an answer and nothing else. **A
   normal message never creates a Job.**
3. **A structured action** — the model writes its reply for you and may append
   at most one `jarvis-action` block. Trusted code validates and dispatches it.
4. **A clarification** — when several projects or Jobs could be meant, Jarvis
   asks instead of guessing.

## The four layers of memory

These are deliberately distinct, and deleting one never silently deletes
another.

| Layer | What it is | Survives conversation deletion |
| --- | --- | --- |
| Conversation transcript | The raw discussion | No |
| Conversation working state | Compact goal, decisions, constraints, entities | No |
| Global user memory | Durable facts and preferences about you | **Yes** |
| Project memory | Durable knowledge about one repository | **Yes** |
| Job episode | Compact record of completed work | **Yes** |

A new conversation gets fresh working state and still has access to your durable
memory. Deleting a conversation removes its transcript and its working state.
Explicit `forget` operates on durable memory, never on message history — and a
full transcript is never promoted into memory wholesale.

## Conversation ↔ Job provenance

A Job created from a conversation records the conversation id, the id of the
message that caused it, the original wording, the resolved project, and the
normalised goal. The conversation shows it as a live card that updates over the
event stream.

Deleting a conversation does **not** delete the Jobs created from it. The
`jobs.session_id` foreign key is `ON DELETE SET NULL` precisely so that tidying
up a chat can never erase an audit trail. Deleting a Job leaves a tombstone, so
a card that still references it renders as a tombstone rather than breaking.

The conversation stays fully usable while Jobs run. A Job is background work,
not a global chat lock.

## Natural project resolution

There is no required project chooser. The resolver is deterministic, and its
precedence is, strongest first:

1. an exact project id appearing in the message;
2. an exact canonical name, alias, repository basename, or self synonym;
3. a unique word-boundary mention of one of those names;
4. the conversation's current project affinity, when the message names none.

"Fix the Jobs page in Jarvis" resolves the self project. "Implement OAuth in
Sitepilot" resolves by name or alias. "Fix auth in website" with two plausible
websites resolves to **nothing** — Jarvis asks which one. Affinity is
convenience, not authority: naming another project overrides it, and destructive
actions always require an explicitly resolved target.

Aliases are editable in project settings. Archived projects drop out of the
default candidate set but are still resolvable when named explicitly.

## Archive versus delete

Archive is the normal way to put something away. It is reversible and it
preserves everything.

- **Conversation** — archive hides it from the sidebar; delete removes the
  transcript and working state only.
- **Project** — archive hides it from active views and default resolution.
  *Unregister never deletes the repository from disk.* If the project has active
  Jobs, unregister is refused and names the blocker. If it has historical Jobs or
  memory, unregister soft-archives it so that history stays understandable. Only
  a registration nothing depends on is removed outright. The Jarvis self project
  can never be unregistered.
- **Job** — archive removes it from History and preserves every artifact.

### When a Job may be deleted

| State | Deletable |
| --- | --- |
| Running or otherwise active | No — cancel first, and let the worktree be released |
| Paused / awaiting_user, never applied | Yes, with confirmation — deleting abandons the candidate |
| Failed / completed, never applied | Yes, with confirmation |
| Any candidate application row (including `approved` or `failed`), or any self-upgrade transaction | **Never** — Archive is the only offer |

An application row is immutable evidence: that a change really happened to a
repository, or that a human authorised one. Deleting an eligible Job removes its disposable worktree, candidate
branch, screenshots, verification/review/run rows and disposable context, and
leaves an audit tombstone recording that you deleted it. The repository itself,
your project and user memory, and all application evidence are preserved.

## Destructive confirmation

Every destructive management action goes through one confirmation dialog that
states what will happen, what will be removed, what will be preserved, and that
it is irreversible.

The dialog is not the security boundary. Server-side authority never depends on
a browser modal existing: destructive tools are refused for the `agent` actor by
policy and require an authenticated human approval bound to the exact action,
target id, definition revision and canonical argument hash.

**The model cannot confirm its own request.** When chat asks for something
destructive, the request is re-issued as the user's and returns a pending
approval that only an authenticated human call can answer. Jarvis says so
plainly rather than claiming it did the thing.

## What chat can never do

Jarvis chat may create a self-development Job if you ask, and may inspect one. It
may not approve a candidate, apply a change, activate a self-upgrade, or obtain
the activation token. Those need you, and activation additionally needs the
external supervisor. The chat agent runs with no source-editing authority, never
inside a development worktree, and has no path to SQLite, Git, approval state or
supervisor state — it may only request one of the declared actions, which
trusted code then decides.

## Agent recovery

Provider failures are classified rather than collapsed into "agent reported an
error": quota, cooldown, invalid external session, unavailable executable,
timeout, protocol failure, cancellation, and genuine agent failure.

Quota exhaustion is **provider state, not a product defect**. It never invokes a
source fixer. Jarvis tries another healthy provider; if none remains, the Job
pauses with an explicit reason and, where the provider named one unambiguously,
a reset time.

When a persisted external Claude/Codex session cannot be resumed, Jarvis retires
that session id and retries **once** in a fresh provider context: the same
provider, the same worktree with its edits intact, and the same prompt. Nothing
is rebuilt or re-summarised for the retry — the worktree already holds the work,
and the agent is told to inspect it. The retry consumes an attempt from the
stage's existing budget, so it is bounded and cannot loop, and the retired
session id is cleared from the Job row so a later Resume cannot replay it.

A session id belongs to exactly one provider. The Job records the provider that
issued it alongside the id, and a resumed session is only ever handed back to
that same provider — a Claude thread is never passed to Codex, or the reverse,
whichever call site assembled the pair.

Resuming a *paused* Job is a different path: it rebuilds the stage prompt from
the Job's own request, acceptance, stage and checkpoint reason, and for a repair
stage from the exact persisted checkpoint.

## Stale Jobs

Before resuming, Jarvis checks that the project still exists, its repository is
present, the worktree is intact, and the target head still matches the base the
candidate branched from. If the target has moved on — exactly what happens after
Jarvis self-updates — resume is blocked and explains itself:

```text
This Job was based on 9a69af65.
The target is now 0472c283.
```

The offered ways forward are restarting as a new Job against the current base
(which preserves a link to its predecessor and never resurrects stale reviewed
evidence), inspecting the old candidate, or archiving the old Job.

## Supervised versus unsupervised development

- `pnpm dev` — the normal supervised launcher. Builds core and the orchestrator,
  runs the orchestrator under `scripts/supervisor.mjs`, and prints the
  self-upgrade activation token once for that session. Self-upgrade activation
  is possible.
- `pnpm dev:unsupervised` — the raw watch-oriented loop for iterating on source.
  No supervisor, so it can prepare a self-upgrade but can never activate one.

Ctrl+C is a clean shutdown of the whole tree on every platform, and the ports
become reusable. Only explicitly allowlisted non-secret `JARVIS_*` variables
reach the supervised runtime; the allowlist is a list of exact names, never a
prefix match, and a test scans the sources so a newly supported setting cannot
be silently forgotten.
