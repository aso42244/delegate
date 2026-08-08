# 009 — SimpleFIN sync cadence and request window

**Status:** accepted
**Date:** 2026-08-08

## Context

§7 specifies an hourly sync, and instructs us to follow SimpleFIN's own guidance
instead if their documentation indicates a different cadence is appropriate.

The published protocol specification documents no rate limits and gives no
guidance on sync frequency.

## Decision

**Hourly stands.** One request an hour is roughly 720 a month for the whole
household, which is a negligible load on any bridge, and it is the cadence the
specification asks for.

Two things follow from having no documented limit rather than a generous one:

- The scheduled job never retries a failed run. It waits for the next hour. A
  bridge having a bad morning must not receive an escalating series of retries
  from us on top of it.
- A run refuses to start while another is in flight, so the manual sync button
  and the hourly job cannot overlap. A run left `running` for more than thirty
  minutes is treated as a killed process and failed, so a crash cannot block
  syncing forever.

### The request window

The first sync requests twelve months. Later syncs request from the last
successful run minus a **seven-day overlap**, so a transaction that posts late is
still inside the window.

**A long range must be split into windows of 45 days.** This was found by running
against the real bridge, and it could not have been found any other way. Asking
for twelve months in one request returns `200 OK` with a plausible-looking set of
transactions and a note buried in `errlist`:

> Requested date range exceeds limit of 90 days and was capped.

Measured against the household's own accounts, that silent cap was the difference
between **275 transactions over 88 days** and **423 over 193 days** — a request
that looked entirely successful was returning 65% of the available history.

The bridge separately recommends 45 days per request and warns that the 90-day
limit may tighten in future, so windows are 45 days rather than 90. It costs a
few more requests on the one-off backfill and nothing afterwards.

This matters more than it first appears: go-live reconciliation corrects
delegation balances against a categorized backlog, so a backlog quietly missing
half its history produces balances that are wrong with nothing on screen to
explain why.

**The window is then widened to cover the oldest outstanding pending
transaction.** This is the part that is easy to get wrong. Absence from the feed
is how a vanished pending transaction is detected, and that inference is only
valid for transactions we actually asked about. A hold older than the overlap —
hotel and car-rental deposits routinely run seven to ten days — would otherwise
sit forever: never reported, never reconciled, with the owner's envelope wrong
the entire time and nothing on screen to explain why.

### Protocol version

The request does not pin a protocol version, and the parser accepts both v1
(`errors`, inline `org`) and v2 (`errlist`, `connections`, `conn_id`). Pinning a
version we cannot test against risks being refused outright by a bridge that
speaks the other one; accepting both costs a handful of optional fields.

## Consequences

- Sync is idempotent by construction: rows are keyed on SimpleFIN's transaction
  id plus the account, which is a unique index, so a re-run updates in place.
- Widening the window for pending rows makes the request slightly larger while a
  long hold is outstanding. That is the correct trade — the alternative is silent
  and permanent inaccuracy.
- If SimpleFIN later publishes rate limits, this decision should be revisited
  rather than assumed still valid.
- **Twelve months of history may simply not exist.** Against the household's real
  accounts the feed returns roughly six months, no matter how the request is
  windowed — that is what the institutions hold, not a limit we can engineer
  around. §7 anticipated this ("or as far back as SimpleFIN permits if less"), but
  it changes what go-live reconciliation is reconciling against, so it is stated
  here rather than discovered on the day.
