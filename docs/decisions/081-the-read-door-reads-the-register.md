# 081. The read door reads the register

**Status:** accepted
**Date:** 2026-10-07

Amends [ADR 070](070-the-read-door-is-its-own-surface.md), which kept the
transaction register off the read door and said a third route would be a change
to the contract first. This is that change.

## Context

Eventide's Possessions has a "Start a record" for logging one purchase: the
television, the dishwasher, the bicycle. What it needs is the purchase itself —
when, how much, where, on which card — and that lives only in Delegate's
register. With two reads, both totals, there was nothing to pick a purchase
from, so the household typed the figures in by hand from the other screen.

## Decision

**Two more reads, on the same door and behind the same guard.**
`GET /api/read/transactions` lists the register, newest first, and
`GET /api/read/transactions/:id` returns one row. Both are `listTransactions`
and the register's own row select — the query the Transactions page makes — so
there is still no arithmetic on the door that a screen does not show.

- **A narrower filter set than the page's.** Words (which find a merchant by
  the household's own name too, as the page's search does), an account, a
  window (`dateFrom` inclusive, `dateBefore` exclusive), and a direction. That
  is what finding one purchase takes. The page's working filters —
  uncategorized, pending, a line, a grouping — stay the page's.
- **Pages of at most 100**, fifty by default, by `limit` and `offset`, with the
  total. A client looking for one purchase never needs the whole register in a
  response.
- **The row arrives whole:** the account it was on, the lines it was filed to,
  and the merchant's own name beside the bank's description. A record made from
  it needs nothing else from Delegate.
- **An archived row is never listed, and is always answered by its id.** A
  record in Eventide that points at a purchase keeps resolving after the row is
  withdrawn here, and says so through `archivedAt` rather than vanishing.
- **Still nothing that writes.** No body, no `POST`. Eventide keeps the
  transaction's id; it never sends one back to change anything.

## Consequences

- `docs/api-for-eventide.md` documents both routes and their refusals: a query
  it cannot read is a 400 `invalid_request`, an id that is no transaction a
  404 `not_found`.
- The register's search moved from the route into `domain/transactions.ts`
  (`merchantNames`, `searchFeedNamesFor`) so both doors search the same way.
- A token can now read every purchase, not just the totals. That was always the
  token's reach in principle (ADR 069: it reads as the person who made it); it
  is now its reach in fact, and the Settings card's "last used" is how to see
  it is being used.
