# 003 — Migrations are forward-only

**Status:** accepted
**Date:** 2026-08-08

## Context

The build specification chose Prisma because "migrations are versioned,
reviewable, and reversible". Two of those three are true. **Prisma Migrate does
not generate down migrations**, and there is no supported way to roll one back
other than restoring a backup or writing a new forward migration.

## Decision

Keep Prisma; correct the rationale. Migrations are versioned, reviewable, plain
SQL, and **forward-only**. An applied migration is never edited. Recovering from a
bad migration means writing the next one, or restoring from the nightly `pg_dump`.

Constraints Prisma's schema language cannot express — partial and expression
indexes, check constraints — are written by hand in their own migration. Prisma
does not model them, so they survive subsequent `migrate dev` runs untouched.

## Consequences

This aligns with the project's own engineering principle that migrations are
forward-only, so nothing is lost. It does raise the value of the tested restore
path: with no down migrations, the backup _is_ the rollback mechanism.
