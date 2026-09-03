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
2. **A code change** — a message that tells Jarvis to change the source of a
   registered repository: "implémente OAuth dans Sitepilot", "code sur le projet
   Jarvis …", "fix this bug in Jarvis". Jarvis creates exactly one Job and
   starts it. Which messages these are is decided by a dedicated classifier, not
   by the conversational assistant; see below.
3. **A clarification** — a change is clearly wanted, but not clearly to a
   registered repository. Jarvis asks, offers the projects as choices, and
   starts nothing.
4. **Ordinary conversation** — an explanation, an opinion, brainstorming, a
   question about Jarvis itself, or anything you want written that is not a
   change to a repository. This produces an answer and nothing else. **A normal
   message never creates a Job.**
5. **A structured action** — the assistant writes its reply for you and may
   append at most one `jarvis-action` block: inspect a Job, rename the
   conversation, analyse or archive a project. Trusted code validates and
   dispatches it, and anything destructive stops at your confirmation.

## Editing an earlier message

Every message carries **Copy**, and every message you wrote carries **Edit**.
Editing is not a correction appended at the end: the conversation resumes from
that message, so the edited turn and everything below it are deleted before the
new wording is answered. The reply to a question that no longer exists must not
stay in the transcript.

That is only honest while the deleted branch left nothing behind it, so a rewind
is refused when the branch:

- has a tool execution still `running`;
- started a Job — cancel the Job instead, `job.cancel` is the capability for
  stopping work, and rewriting the request is not;
- ran anything above `observe` that did not stop before executing. Not just the
  actions you confirmed: `conversation.create` is `safe_action`, so it is
  auto-approved and succeeds inside the turn. Its effect is durable either way,
  and a `failed`, `timed_out` or `interrupted` execution is assumed to have had
  one too;
- contains an explicit memory command, which is applied deterministically and
  never reaches the tool boundary.

An execution that only read (`observe`) is edited straight through: deleting the
messages around it leaves nothing in Jarvis that the transcript now contradicts.
A request still waiting for your confirmation is denied first — an approval
dialog whose message is about to disappear has no context left to answer.

This rests on every assistant message produced by a tool execution carrying that
execution's id, not only the ones that stopped at a confirmation.

## How Jarvis decides what you asked for

### Why this is not left to the conversational assistant

It used to be. Asked, in a new conversation, to "code sur le projet Jarvis une
nouvelle implémentation …", the conversational provider answered that its
working folder was empty and asked where the Jarvis repository was. No Job was
created, and Jarvis had a registered self project with that exact path the whole
time. A capability that only exists when a model chooses to emit a JSON block is
not a capability.

### Why this is not left to a parser either

The first four attempts at a fix answered it in trusted code with grammar:
preposition lists, repository nouns, noun-head tests, attachment rules,
confidence scores. Each version passed its tests and each one, in review, bound
the wrong repository for a sentence structurally identical to one that had to
bind. The pair that settled it:

> fix the login bug **in Jarvis** → change the Jarvis repository
> write a blog post about the retry logic we shipped **in Jarvis** → write a blog post

Same preposition, same name, same position, opposite meaning. Separating them is
parsing, not pattern matching, and a hand-written parser for two languages is
not a thing to keep correct underneath a security rule.

### What happens instead

Interpretation is delegated to a model. Authority is not.

```text
your message
    |
semantic router          tool-free, ephemeral, strict JSON schema
    |                    "what is this, and which repository does it change?"
    +--> normal chat / project management --> the conversational assistant
    +--> unclear target                   --> a question, zero Jobs
    +--> change repository P
             |
         autostart verifier   a second run: fresh context, its own prompt,
             |                a smaller input surface, and nothing the
             |                router wrote beyond three bounded values
             +--> clarify --> a question, zero Jobs
             +--> allow P
                      |
                  trusted validation --> job.create, started
```

The router and the verifier are separate roles from the conversational
assistant, and both run the way conversation runs: **no filesystem, no shell, no
Git, no database, no Jarvis tools, and no provider-native tools at all**, in an
empty scratch directory, with no session persisted.

They classify. They cannot act. And the only thing either of them produces that
survives is **a project id chosen from the list it was handed**. Neither writes
the instruction the coding agent executes — that is your own message, carried
across by Jarvis — and neither writes any text that reaches a later prompt.

At most twelve projects are described in one routing decision, with the
conversation's own project always among them. If you have more, the prompt says
so and asks rather than choosing from a partial list.

### What each classifier is allowed to read

A routing prompt has two regions, and what decides which region a value goes in
is **who wrote it** — never how useful it looks.

| Region | Written by | Contains |
| --- | --- | --- |
| Trusted, first | Jarvis, from its own registry | project ids, detected stack, the conversation's project id, whether Jarvis asked a question last turn and about which id — plus the names and aliases **you** registered (a model can propose a rename, but only through a confirmation you answer) |
| Untrusted, last | anyone else | your latest message; for the router only, your own previous messages |

Everything in the trusted region is serialised as JSON, so a project you named
`", "id": "…` is a name rather than a structure, and nothing is interpolated into
an English sentence. Everything in the untrusted region is a JSON string
literal, introduced as material to interpret — which is also why nothing in
your message is rewritten on the way in to keep a delimiter intact. (It arrives
as stored, so anything that looked like a credential was redacted and a very
long message truncated — both before routing sees it.)

**Neither prompt contains** a project's summary, its analysis profile, any
memory, any search or job result, or anything Jarvis said on a previous turn.
Not in the trusted region, where it would read as Jarvis's own policy, and not
in the untrusted region either, because there is no routing question it answers.
Those are not arbitrary exclusions. The analyst reads a repository's README and
`CLAUDE.md`, so for any repository you did not write yourself, its profile is
somebody else's writing; `inspect_project` copies a project's summary into a
reply, so replaying a transcript is a second route for the same text; and a
model's own clarification question was a third. Each was closed on its own in
review and the next one appeared, so the rule now excludes the whole category.

The two prompts are also deliberately not built from the same inputs:

```
router     trusted facts + your latest message + your own earlier messages
verifier   trusted facts + your latest message + the proposal (three values)
```

The verifier sees no transcript at all. If a request only reads as a code change
in the light of an earlier turn, the verifier cannot establish a repository and
asks instead — one question, zero Jobs. That is the intended outcome rather than
a gap: an unattended agent should not start on an instruction nobody typed.

### What trusted code checks before anything starts

The classifier's answer is untrusted structured data, and is treated as such:

- the schema version must be exactly the one Jarvis wrote, every enum value must
  be known, every field within bounds, and an unknown field is a refusal — not a
  field to ignore;
- `targetProjectId` must be an id **this invocation offered**, not merely a
  project that exists, so an id a model invented or was told to say by something
  inside your message resolves to nothing;
- the project is resolved from that id by `ProjectService`, which remains the
  only source of a repository path — no model-produced string ever becomes a
  path or a command;
- archived projects are never offered and never accepted;
- and the verifier must independently return `allow` **on the same project id**.

Anything else — disagreement, a malformed answer, an unreachable provider, a
Stop — ends in a question or an ordinary answer, and zero Jobs. There is no
"repair the answer and continue" path.

### Two checks, because one model is not a security boundary

The router prompt frames your whole message as content to interpret rather than
instructions to follow, which measurably helps with pasted email, quoted
changelogs and tickets. It is not claimed as a defence: a model can be talked
out of any instruction. That is precisely why a second, independent run — fresh
context, different prompt, shown the same candidate list and asked to name the
repository itself rather than to confirm one — has to agree before an unattended
write-capable agent starts. Exactly one router, at most one verifier, never a
third opinion.

For that second opinion to be worth anything, the two runs must not share an
input that something outside Jarvis can write. Two runs of the same model over
the same inputs are one opinion counted twice. So nothing a classifier produces
is ever fed to the other or to a later turn — not its clarification question,
not a restatement of your request — and every free-text input the verifier
drops is one the router keeps, as set out above. Its inputs are not a strict
subset: it also gets the router's conclusion, three categorical values that
carry no text. Every one of those was a real
channel in an earlier version of this design, found in review; closing the
category rather than the instance is what makes "independent" accurate rather
than aspirational.

### Affinity, and what it is worth

The project a conversation is bound to is passed to both classifiers as a strong
hint about **which** repository is meant. It is not evidence that a code change
was asked for. In a conversation bound to Jarvis:

| You say | What happens |
| --- | --- |
| "implémente ça" | a Job on Jarvis |
| "écris-moi un email pour prévenir l'équipe" | an email, zero Jobs |
| "crée une facture pour ce client" | an invoice, zero Jobs |

Affinity is only written when a Job really exists — asking for one, or being
asked which repository you meant, does not change what the conversation is
about.

### Confirming a target

When Jarvis asks which repository you meant, the question comes with your
projects as buttons. **Clicking one is the fastest and most exact answer**: it
names the project yourself, so no classifier is consulted at all, and the Job
starts on the request Jarvis carried forward from the message it asked about.

Answering in words works too. Jarvis remembers which repository it named — as an
id, not as a sentence — so "oui, Jarvis" is enough. When Jarvis had named a
specific repository and you agree, that is the second opinion: a person who was
shown the name and said yes is better evidence than another model run, and
without it the same question could be asked forever with no way through it.

Either way the request that runs is what you actually typed, including anything
you wrote before the question was asked. Nothing is summarised or restated on
the way.

### Why a routed Job needs no confirmation

The Job is created through the same `job.create` tool, with the same input shape
and the same policy evaluation, as the "Start Job" button on the project page.
What reaches it is your own sentence, verbatim, and a project id trusted code
resolved from a list it had itself offered — no model-authored text at all. A
model chose between candidates; it did not write anything that gets executed.

A `create_job` the conversational assistant emits is a different thing — that is
the model's inference about what you wanted, in the model's own words — and it
stops at a confirmation the model cannot answer.

### What this costs

Every message in a workspace with at least one registered project spends one
tool-free classification run; a message that routes to a code change spends a
second for the independent check. Messages in a workspace with no registered
projects, and explicit memory commands, spend none. Routing uses the balanced
model profile and gives up after 90 seconds — a one-sentence classification that
has not answered by then has failed, not thought harder. There is no retry: if a
provider is unreachable, the turn becomes an ordinary answer and no Job is
created.

## What the conversation knows about your projects

Every turn is given a bounded registry of the registered projects: name, id,
path, aliases, a short stack summary, a one-line summary, and whether the
project has been analysed. When a turn mentions a project, that project's full
snapshot and profile are injected too, along with its project-scoped memories.

That is why "où est le projet Jarvis ?" and "quelle stack utilise Jarvis ?" are
answered directly. The conversational provider has no filesystem access at all —
it runs in an empty scratch directory with every built-in tool disabled — so
everything it knows about a repository, Jarvis handed it.

Per-turn resolution is not conversation affinity. Mentioning a project in a
question enriches that turn's context; it does not change what the conversation
is about. Affinity is only written when a Job really exists.

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

The self project is the one special case. Its name is also how you *address*
Jarvis, so a bare "Jarvis" anywhere in a sentence is not a reference to its
repository — only a construction that cannot be an address is: a preposition
("in Jarvis", "sur Jarvis", "dans Jarvis"), a possessive, or an explicit noun
("the Jarvis repo", "le projet Jarvis"). French phrasings are included because
their absence was the reason "code sur le projet Jarvis" resolved to nothing.

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

## Project analysis

A registered project can be analysed once, on request: a bounded read-only agent
reads a **disposable worktree pinned to the project's committed HEAD** — never
your working checkout, so uncommitted work is neither seen nor touched — and
returns a structured profile: purpose, architecture, languages, frameworks,
modules, entrypoints, test strategy, build workflow, conventions, integrations,
data stores, risks and where to read first.

It is not a Job. There is no verification, no code review, no visual QA and no
application transaction, because nothing is changed. The agent has reading tools
only; it cannot run a command, edit a file or make a commit.

The result is stored on the project row with the exact commit it was read from,
and it is used in two places: the context a conversation gets when it resolves
that project, and the context pack a coding Job's worker starts from. One to
three short facts are also written to project memory through `MemoryService`,
with stable subjects so a re-analysis replaces them instead of accumulating
near-duplicates. They are excluded from the unregister preflight's history
count: they are Jarvis's own orientation notes, and counting them would turn
every analysed project into a soft archive on Jarvis's say-so rather than on
anything the user did. Because that lets the hard path run while project-scoped
memories exist, unregistering deletes the project's memory in the same
transaction as the row — `memories.scope_id` has no foreign key, so nothing else
would.

**A profile is context, never authority.** Nothing an analysis writes is ever
executed. `Project.commands` stays what deterministic detection found or what
you configured — the analyst may describe a build workflow in prose, and that
prose never becomes a shell command.

When the repository moves past the analysed commit, the profile is marked
potentially stale wherever it appears and is still used. It is not discarded and
not refreshed automatically: re-analysing on every commit would burn provider
quota for no one's benefit. **Réanalyser** is a button.

A failed analysis is inert: the previous profile survives untouched, the project
stays fully usable, and the failure is shown with a retry.

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
