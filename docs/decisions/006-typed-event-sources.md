# 006 — Delegation events reference their source with typed foreign keys

**Status:** accepted
**Date:** 2026-08-08
**Deviates from:** build specification §6.4

## Context

The specification sketches `delegation_events.source_id` as a single nullable
column pointing at "transaction / transfer / delegate_run". That is a polymorphic
reference, and PostgreSQL cannot enforce one: nothing stops a `source_id` from
naming a row that does not exist, or from being interpreted against the wrong
table.

## Decision

Three typed nullable foreign keys instead: `transaction_id`, `delegate_run_id`,
`delegation_transfer_id`. Each is a real foreign key, so the database guarantees
the source row exists.

`batch_id` stays a plain indexed column rather than a foreign key, because a batch
legitimately may or may not have a `delegate_runs` row behind it — a Reconcile
commit shares a batch without being a Delegate press.

## Consequences

Three columns where the sketch had one, and queries name the column they mean.
In exchange, a dangling source reference is impossible rather than merely
unlikely, which matters for a table that is the sole source of truth for every
balance in the application.
