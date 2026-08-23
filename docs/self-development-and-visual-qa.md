# Self-development and visual QA

Jarvis registers its own repository as the `jarvis` Project at boot. A self-development request follows exactly the normal job pipeline in a separate branch/worktree; the running control plane and candidate checkout are distinct.

V1 safety boundary:

- never modify the running checkout;
- never auto-merge, push, publish, or restart into candidate code;
- preserve dirty user work outside the candidate;
- require deterministic verification and independent review;
- stop at human approval even after success.

After a successful job, one compact project episode preserves goal, outcome, files, verification, review, branch/head, and provenance. Validated agent proposals may promote durable architectural decisions or constraints. The transcript and changed source are not copied into memory.

## Visual QA

For a project with a configured dev command and URL, Jarvis starts the candidate app, waits for reachability, captures desktop and mobile screenshots with Playwright, records console errors and failed requests, and persists artifact paths. Startup/capture failures become explicit evidence and do not masquerade as a successful review.

Screenshots are marked as evidence only unless a compatible image reviewer actually runs. User/manual inspection therefore remains honest and useful without a paid vision API.

Future work includes route discovery, scripted interactions, isolated candidate ports for concurrent apps, screenshot baselines, and subscription-backed visual-review adapters.

