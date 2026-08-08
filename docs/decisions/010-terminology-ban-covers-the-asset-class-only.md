# 010 — The terminology ban covers the asset class, not cryptography

**Status:** accepted
**Date:** 2026-08-08

## Context

Hard constraint 1 of the build prompt forbids the generic asset-class term and
any variant of it anywhere in the project, stating that the only name for the
asset is **Bitcoin**. CI enforces it.

Read literally, that also forbids **cryptography**, **cryptographic**, and Node's
standard library module `node:crypto`. Those senses of the word have nothing to
do with the asset class, and forbidding them had a cost:

- Correlation ids were generated from a timestamp and a counter instead of
  `randomUUID()`, so two processes starting in the same millisecond would have
  produced colliding ids.
- Batch ids were fetched from PostgreSQL with `gen_random_uuid()`, costing a
  network round trip **inside the transaction** that Delegate, Transfer and
  Reconcile each hold open — for a value the database was never the authority on.
- The dummy hash guarding against username enumeration was seeded from
  `Math.random()`, which is not a secure random source. Harmless in that specific
  use, but the wrong habit to establish in an application whose main defence is a
  password hash.

None of those were good engineering. Each existed only to route around a word.

The owner confirmed the intent: the banned word was meant as the abbreviation of
the generic asset-class term, and only Bitcoin is of interest. Cryptography was
never meant to be included.

## Decision

The ban covers the **asset class** and nothing else.

- The generic asset-class noun, singular or plural, is forbidden outright in any
  casing anywhere — code, comments, column names, commit messages, UI copy. It is
  not written in this document either; the check in `.github/workflows/ci.yml`
  carries the exact pattern.
- Its short form is still forbidden as a standalone word, since that is how the
  asset class is usually abbreviated — **unless** it appears as one of the
  recognised technical forms: `cryptography`, `cryptographic`,
  `cryptographically`, `node:crypto`, `crypto.<member>`, or `webcrypto`.
- The asset itself is still called **Bitcoin**, or `BTC`. That has not changed
  and is not negotiable.

CI enforces exactly this. The check remains, because the original constraint's
purpose — never letting the asset be described generically — is untouched.

## Consequences

- `randomUUID()` from `node:crypto` is used for batch ids and correlation ids: a
  secure v4 UUID, generated in-process, no round trip.
- The enumeration defence hashes a random value rather than a `Math.random()`
  string.
- Encrypting a stored credential at rest becomes possible at all, which the
  in-app SimpleFIN connection flow depends on.
- A future contributor reading hard constraint 1 in the build prompt will find it
  stricter than what CI enforces. That gap is deliberate and is recorded here.
