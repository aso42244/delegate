# 070 — The read door is its own surface

**Status:** accepted
**Date:** 2026-09-21

The door half of Eventide's ADR 268: _one route surface in Delegate, read-only,
with no write path at all, serving what `domain/budget.ts` and
`domain/overview.ts` already compute._ Follows
[ADR 069](069-a-token-reads-as-a-person.md), which is the credential that opens
it, and [ADR 002](002-money-as-integer-cents.md), which decides what money
looks like when it crosses.

## Context

The obvious way to let a token read the budget is to teach the existing guard
about bearer tokens. `routes/budget.ts` registers `AUTHENTICATED` as a
plugin-scope `preHandler` and then declares one GET and eighteen POSTs. A token
accepted by that guard reads `/api/budget` today, and moves money the day
somebody refactors the guard chain, adds a route to that file, or forgets which
of the nineteen a token was meant for. "Read-only" would be a property of the
current arrangement rather than of the design.

## Decision

**Its own route file, its own plugin, its own guard: `routes/read-door.ts`.**
Registered in `app.ts` before `spa`, whose not-found handler is the SPA fallback
and must see every API route already declared.

**A write path is unexpressible, not merely absent.** Nothing in the file takes
a body, nothing in it is a `POST`, and the guard in it is the only code in the
application that knows what a bearer token is. A `POST` to either route is a
404 from the not-found handler, before any guard runs, because there is no route
for it to reach.

**A bearer token and only a bearer token.** The guard reads the `Authorization`
header and never the session, so a signed-in browser cannot reach these routes
— with or without a token beside its cookie — and a token cannot reach anything
guarded by a session. Two credentials, two doors, and neither fits the other's
lock. The integration tests walk a token up to the budget, the overview, the
register, the token routes and Delegate itself, and every one answers 401.

**Two routes, and no arithmetic of their own.** `GET /api/read/budget` is
`buildBudgetView` flattened — every line with its grouping carried on it, every
in-budget account, the identity. `GET /api/read/overview` is `buildFigures` for
all seven figures, `payCycleAt`, and three of `buildOverview`'s tiles: the
backlog, the overspent lines, spending by grouping this cycle. If a number
appears in that file that appears nowhere on a screen, it is a bug in that file.

**Money is a string of whole cents**, through `centsOut`, exactly as it is for
the pages. `"41287"` is $412.87. This is the one thing a client reading the door
must not get wrong, and the contract says so in its first table.

**Three refusals, two of them the same.** No header or the wrong scheme is
`bearer_required` — the client forgot the header, and saying so costs nothing. A
token that is unknown, revoked, or an archived account's is `invalid_token`, one
status and one message, so the door never says which of those it was to whoever
found it. Both carry `WWW-Authenticate: Bearer`. Everything the rest of the
application already does to `/api/` still applies: `Cache-Control: no-store`,
the global rate limit, and the empty 404 over the onion address while remote
access is off.

**Every accepted read is stamped** — when, and from where — on the token that
made it. That is the visibility half of the credential's shape (ADR 069), and it
is what the Settings card reads.

**The contract is a document**, `docs/api-for-eventide.md`: every field, its
unit, and what each refusal looks like. A field added to the route is a field
added there in the same change. It is also pasted into the pull request that
ships it, because a contract that lives only in code gets negotiated twice.

## Consequences

- Eventide's Finances view is built against two documented reads and nothing
  else. "How much is left in Groceries" is `delegations[].balanceCents` on the
  line whose name matches — no tree to walk.
- Filtering, pagination and the transaction register are deliberately not here.
  Those are the pages; this is a reading of them. A third route is a change to
  the contract first.
- `presentRow` in `routes/budget.ts` and the presenters in `read-door.ts` are
  two projections of one `BudgetRow`. That is not the drift ADR 062 warns of —
  the arithmetic is shared and only the choice of fields differs — but a field
  renamed on `BudgetRow` now breaks two places rather than one, and the compiler
  will say so in both.
- The door is under the global rate limit but has no limit of its own. A token
  is a household member's credential, not a stranger's guess, and the reads it
  makes are the reads the pages make.
