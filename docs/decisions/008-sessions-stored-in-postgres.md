# 008 — Sessions stored in PostgreSQL

**Status:** accepted
**Date:** 2026-08-08

## Context

`@fastify/session` defaults to an in-memory store. On a Synology that restarts
containers for DSM updates, that logs the household out every time, and the store
grows without bound because nothing evicts expired entries. Redis is the usual
answer and is explicitly out of scope for a two-person workload.

## Decision

Sessions live in the `sessions` table, through a `PrismaSessionStore`
implementing the `@fastify/session` store interface.

The table requires a `user_id`, so only authenticated sessions can be stored.
That is enforced with `saveUninitialized: false`: an anonymous visitor never
reaches the store, and the store refuses to write a row for a session with no
user rather than failing a foreign key at request time.

Expiry is enforced in two places. A stale cookie is rejected and its row deleted
when it is presented, and login sweeps every expired row. Sweeping at login
rather than on a schedule avoids introducing a background job for a table that
holds two people's sessions.

## Consequences

- Restarts and updates no longer sign anyone out.
- Logout and password changes can revoke a session for real, because the session
  is a row that can be deleted rather than a signed cookie that must be waited
  out. Archiving a user and resetting a password both delete their sessions
  immediately for the same reason.
- Session reads add a query per authenticated request. At household scale this
  is irrelevant, and §13 prefers a slow correct answer to a fast wrong one.
- The session id is rotated on login and on password change, so a session id
  captured before either event cannot be replayed after it.
