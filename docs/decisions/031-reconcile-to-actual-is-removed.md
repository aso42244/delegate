# 031. Reconcile to Actual is removed

**Status:** accepted
**Date:** 2026-08-24

## Context

Reconcile to Actual was a first-class screen: every delegation listed with its
computed balance and an editable "actual", and one commit writing every
correction as an `adjust` delta sharing a batch. Sixty corrections as one screen
and one commit rather than sixty modals.

It existed for a single moment in a household's life. At go-live the owner has
backfilled and categorized twelve months of history, which drives every envelope
deeply negative — Grocery reads −$9,000 when its true balance is $725 — and one
screen turns that into day-one numbers. The first commit also stamped
`go_live_at`, which is what separated backfilled history from live activity.

That moment has passed. Go-live happened, the budget has run on real data for
weeks, and the screen has not been opened since. The owner's judgement is that it
will not be needed again — a household that backfills later corrects the drift
where the drift is visible, on the Budget page or in Settings → Delegations,
where the same `adjust` event is one line away.

## Decision

**The screen, its route and its domain function are removed.**

`reconcileToActual` is gone from `domain/adjust.ts`, `POST
/api/budget/reconcile` from the routes, `Reconcile.tsx` and its tab from the web
app, and the Go-live card from Settings → Budget, which reported a date nothing
writes any more.

**Nothing about the data is removed.** Every `adjust` event a reconciliation ever
wrote is untouched, still in the ledger, still summed into every cached balance,
still visible in per-line history — those events are ordinary manual adjustments
and always were. The batch that grouped them still groups them.

**`budget_settings.go_live_at` stays**, and stays in the settings API. Migrations
are forward-only ([ADR 003](003-forward-only-migrations.md)) and the value on a
live deployment is a real fact about that household — the day it stopped being a
spreadsheet. Nothing writes it now and nothing displays it; it is history the
column outlived the screen for. Deleting the column to tidy up would be
destroying the one thing the feature left behind that was worth keeping.

## Consequences

**The bulk path is gone and the per-line one is not.** Correcting sixty lines now
means sixty visits to a row menu, which would have been unacceptable at go-live
and is merely tedious at the rate corrections actually happen. If a second
household ever adopts this, go-live for them is a worse day than it was here.
That is the trade, and it is the owner's to make: he is the household.

**Nothing else read `go_live_at`.** It was checked before writing, and rendered
on one card. No view, no query and no calculation branches on it, so removing
the writer changes no behaviour anywhere.

**The screen was tested, and those tests go with it.** `e2e/reconcile.spec.ts`,
the `Reconcile to Actual` block in `budget-api.test.ts`, the go-live block in
`settings.test.ts`, and the reconciliation block in `identity.test.ts`. What
those tests actually protected — that an `adjust` writes an exact delta, that a
batch groups, that the cached balance agrees with the ledger afterwards — is
covered where it belongs, in the manual-adjustment tests that remain.
