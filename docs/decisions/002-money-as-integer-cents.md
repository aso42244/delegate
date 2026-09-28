# 002 — Money is integer cents, and crosses HTTP as a string

**Status:** accepted
**Date:** 2026-08-08

## Context

A hard constraint of the project: all money is stored as integer cents in `BIGINT`
columns, never floats, never `REAL`, never a JavaScript `number` in persistence.

Prisma maps `BIGINT` to JavaScript `bigint`, which is correct, and which
`JSON.stringify` refuses to serialize. That is a real consequence of the
constraint and needs a deliberate answer rather than an ad hoc one per endpoint.

## Decision

Money is `bigint` from the column to the edge of the HTTP layer. At that edge it
is serialized as a **decimal string of cents** — `"-12345"` — and parsed back with
`centsFromJson`, which rejects anything that is not a whole number of cents.

`Cents` is a plain alias for `bigint`, not a branded type. A brand would force an
`as Cents` assertion at every Prisma boundary, and an assertion asserts rather than
checks: the safety would be theatre while the noise would be real. The single place
a lossy value can enter is `cents()`, which rejects non-integer numbers outright.
Every field, column and parameter carries a `Cents` suffix instead.

## Consequences

A string survives JSON, sorts unambiguously, and cannot be silently coerced to a
lossy float by a client. The cost is one conversion at each boundary, covered by
round-trip tests including values beyond `Number.MAX_SAFE_INTEGER`.

Parsing user input rejects more than two decimal places rather than rounding.
Silently turning `1.005` into `1.00` in financial software is worse than telling
the user the cell is wrong.
