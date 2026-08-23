# ADR 0001: local monorepo and memory-first bootstrap

Status: accepted (2026-08-23)

## Decision

Use a three-workspace TypeScript monorepo: core domain/infrastructure, one persistent Hono orchestrator, and one React/Vite UI. Store durable state in local SQLite using Node's built-in driver. Use FTS5 as the mandatory retrieval baseline and a lazy local multilingual E5 model as an optional semantic signal. Integrate official subscription-authenticated Claude/Codex CLIs through structured streams. Isolate coding work with Git worktrees and retain a human merge boundary.

## Why

This is the smallest architecture that proves durable memory, orchestration, live observation, agent execution, verification, independent review, visual evidence, and safe self-development without paid APIs, Docker, microservices, or duplicated provider logic.

## Consequences

SQLite-specific FTS/vector storage stays behind Memory Service so PostgreSQL can replace it later. The orchestrator is a single-machine control plane. App-server integration, distributed workers, automatic procedure learning, and trusted auto-merge remain deferred until a measured need exists.

