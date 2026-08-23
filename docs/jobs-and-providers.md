# Jobs, providers, and verification

## Lifecycle

```text
queued -> planning -> implementing -> verifying
                                |         |
                                `-> fixing (bounded retry)
                                          |
                                      reviewing
                                          |
                                      visual_qa
                                          |
                                    awaiting_user
                                          |
                                      completed
```

Any active stage may become `failed` or `cancelled`. `awaiting_user` means a candidate passed configured gates and remains isolated. State transitions are validated centrally and persisted as events.

Planning is deterministic: inspect the committed base, create an isolated worktree, and build an auditable Context Pack. This avoids a model call whose only purpose would be restating the request.

## Providers

`AgentProvider` exposes capabilities and structured execution/resume behavior. The registry routes by role and availability without leaking provider syntax into the pipeline.

- Claude Code uses official non-interactive `--print --output-format stream-json`, retains the session ID, and resumes fix work when possible.
- Codex uses official `codex exec --json` JSONL and retains the thread ID. The installed app-server is currently experimental, so V1 deliberately uses the stable CLI surface.
- Capability checks inspect CLI version and official login status; unavailable providers remain explicit and do not crash startup.

Authentication is always delegated to the installed CLI. Jarvis never reads OAuth tokens or requires API credits.

## Verification and review

Project detection records package-manager, install, format/lint/typecheck/test/build/dev commands. Jarvis executes configured checks itself in cost order, stores exit code/duration/bounded output, and may invoke one bounded corrective cycle. A project with no configured deterministic check remains unverified and cannot reach user acceptance.

Review runs in a fresh, read-only provider context with the original request, acceptance criteria, reviewer Context Pack, changed files/diff, implementer summary as an untrusted claim, and deterministic verification evidence. Unparseable or failed review output is an error, never approval.

The candidate branch/worktree, implementation result, verification, structured findings, Context Pack selections, screenshots, and episode remain inspectable. The reviewed Git HEAD must remain clean and unchanged through acceptance. V1 records acceptance but does not merge or push.
