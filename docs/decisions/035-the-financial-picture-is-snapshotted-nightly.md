# 035 — The financial picture is snapshotted nightly

**Status:** accepted
**Date:** 2026-08-28
**Supersedes:** [ADR 013](013-historical-balances-are-reconstructed-from-the-ledger.md)

## Context

[ADR 013](013-historical-balances-are-reconstructed-from-the-ledger.md) considered
exactly three options for "what was this worth on that date", and **rejected
snapshotting as option 1**:

> Snapshot balances nightly. A new table, a new scheduled job, and a chart that
> begins the day the feature ships — useless for the twelve months of history the
> owner is about to import, which is the history he actually wants to look at.

It chose reconstruction, and recorded the price honestly:

> **A gap in the transactions becomes a wrong balance, silently.** If the feed
> omits one, every reconstructed point before it is off by that amount while
> today's balance stays right.

Both halves have moved.

**The reason to reject snapshots has expired.** The backfill happened in August.
There is no longer a body of imported history waiting to arrive that snapshots
would miss; there is a live household budget generating one day of real state at
a time, and every day nothing captures it is a day gone for good.

**The price is no longer worth paying.** Reconstruction is exact only if the
transaction record is complete. [ADR 009](009-simplefin-sync-cadence-and-window.md)
records that the feed returns roughly six months whatever window is asked for,
and the handoff records a live incident where ten charges sat pending for days
while the bridge reported itself healthy. A reconstructed series is a confident
line drawn through data that can be quietly incomplete, and nothing about it says
so.

There is also a category of question reconstruction cannot answer at all. It
walks _today's_ classification backwards, so archiving an account, retiring a
holding or changing an in-budget flag rewrites history that has already been
looked at. The chart stops being a record of what the application showed and
becomes a statement about what it would show today if the past had been
different.

## Decision

**Store a daily record.** Three tables, keyed by a **date** rather than a
timestamp, written by a nightly job for the _previous_ day:

- `account_snapshots` — one row per account per day
- `delegation_snapshots` — one row per delegation per day
- `aggregate_snapshots` — one row per day for the whole picture

Four decisions inside that are worth stating, because each is the difference
between a table and a table that answers the question.

**1. Provenance is per row.** `observed`, `reconstructed`, `carried`,
`interpolated` — declared in that order, strongest first, and an aggregate takes
the weakest provenance among its inputs. A single date can legitimately mix a
reconstructed delegation with an interpolated account, and collapsing that to one
flag per day would report the whole picture as an estimate because one account
was.

**2. The aggregates are stored, not derived.** Recomputing them from the two
detail tables at query time would reintroduce the exact failure above: a row
recomputed under today's classification is a different number wearing the same
date.

**3. Two scopes, not one.** Net worth includes the house and the mortgage; the
identity is precisely the reading that excludes them. Three totals cannot serve
both, so both pairs are stored. The identity is the **four-term** figure from
[ADR 020](020-pending-transactions-in-the-identity.md), and the pending term gets
its own column so the row explains itself.

**4. Classification is captured, not joined.** `account_snapshots` carries the
type and both budget flags as they stood that night; `delegation_snapshots`
carries the grouping. Otherwise moving a delegation between groupings
retroactively moves a year of its history with it, which is the same failure
point 2 exists to prevent, one level down.

### No initial backfill

**History starts with the first run after deploy.** This is an explicit product
decision by the owner, taken with its cost stated: the Insights page currently
reconstructs net worth back to the earliest transaction — roughly six months —
and on the day this ships it will show a single point instead.

The alternative was offered and declined: the gap-filling logic below _is_ a
backfill, and seeding 180 days at deploy would have cost almost nothing to build.
The reason to decline is that seeded rows would carry ADR 013's weakness into a
table whose whole purpose is to be trustworthy. A snapshot that says `observed`
should mean somebody looked.

So `domain/history.ts` and its ledger-walking are removed. The four widgets it
fed are not — they are rebuilt on snapshots. The reconstruction survives only
inside the gap-filler, where it repairs outages going forward and marks every row
it writes as `reconstructed` rather than `observed`.

### Gap filling

The NAS reboots and containers restart. Missing dates between the last snapshot
and yesterday are filled by the **most accurate method available per row**:

1. **Delegations** — replay the append-only event ledger to end of day. Exact
   regardless of gap length. `reconstructed`.
2. **SimpleFIN accounts** — take the next known-good balance and subtract every
   **posted** transaction after the missing date, walking backward one day at a
   time. Signs go through `accountBalanceDelta`, the one function that already
   knows a debt opposes a transaction amount. `reconstructed`.
3. **Manual accounts** — carry the last value entered on or before the date.
   Manual values change in steps, not slopes. `carried`.
4. **Bitcoin** — the quantity is a dated ledger
   ([ADR 023](023-bitcoin-holdings-are-a-dated-ledger.md)) and so is **exact**,
   not carried. With a real close for that date the row is `reconstructed`; when
   the price has to be carried forward the row is `interpolated`, because that is
   the part that became an estimate.
5. **Interpolation** — a straight midpoint, and only where no exact method
   exists. Logged at warning level with the account and the date range. If this
   fires often something is wrong.

## Consequences

- **Insights resets on deploy.** One point on day one, seven in week one. Every
  widget needs a graceful "not enough history yet" state rather than a broken
  axis, and that is a requirement rather than a nicety.
- **A snapshot is a record, not a derivation.** Nothing can retroactively change
  what a stored day says — which is the property ADR 013 could not offer, and the
  reason this reverses it.
- **Storage is trivial and history is kept forever.** At roughly 20 accounts and
  60 delegations: `365 × (20 + 60 + 1)` ≈ **29,600 rows and about 5.5 MB a year**,
  ~55 MB after a decade, against a nightly dump that is currently 199 KB. There
  is **no rollup and no automatic deletion**, and a future session should not
  invent one — the numbers do not justify it until roughly ten times this scale.
- **A silent no-op is the failure mode to fear.** The nightly `pg_dump` failed
  every night for weeks into a log nobody read, and the lesson recorded in the
  handoff is to check for the evidence a job leaves rather than the absence of an
  error. So the newest snapshot date is surfaced in the interface with a banner
  when it is over 48 hours old. A log line alone cannot distinguish "wrote rows"
  from "wrote nothing".
- **The job never throws into the timer.** Same as sync and backup: an unhandled
  rejection in a cron callback takes the process down, and losing the application
  because a snapshot failed would be worse than the missing snapshot — which the
  gap-filler repairs on the next run anyway.
- **`observed` is never overwritten.** Not by a reconstruction, and not by an
  admin re-run. A re-run repairs what is missing; it does not revise what was
  seen.
- **The three tables commit together or not at all.** A partial day is worse than
  a missing day, because the gap-filler can see a missing day and cannot see a
  half-written one.
