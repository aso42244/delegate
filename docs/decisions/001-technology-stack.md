# 001 — Technology stack

**Status:** accepted
**Date:** 2026-08-08

## Context

The owner explicitly deferred architecture, valuing functionality first, security
second, performance third. The workload is one household on a Synology NAS.

## Decision

TypeScript end to end, Node.js 22 LTS, Fastify, PostgreSQL 16, Prisma, React 19 +
Vite, TanStack Query, TanStack Table (headless), Tailwind CSS, `@fastify/session`

- `argon2`, `node-cron` in-process, Vitest + Playwright, multi-stage Docker with
  Compose.

Explicitly avoided: Redis, Kafka, microservices, GraphQL, Electron, any auth SaaS,
any paid API.

## Consequences

One language and shared types between API and UI. `node-cron` in-process avoids a
Redis dependency that a single-household workload cannot justify; the cost is that
scheduled jobs stop when the container stops, which is acceptable because a missed
hourly sync self-corrects on the next run.

Sessions are stored in PostgreSQL rather than in `@fastify/session`'s default
in-memory store, which loses every session on container restart and grows without
bound. This keeps Redis out while still surviving a restart.

Node 22 is pinned in the Dockerfile and CI. Local development on a newer Node
works; the container is the artefact that matters.
