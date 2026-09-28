# 046. The export is three files

**Status:** accepted
**Date:** 2026-09-02

## Context

This household came from a spreadsheet. There was no way back.

Nothing in the application exported anything. The only route out was the nightly
`pg_dump`, which is a restore artefact — it answers "can this deployment be
rebuilt", not "what did we spend on the house last year". Every question the
application does not have a screen for was therefore unanswerable without a
database prompt, and so was every cross-check against a bank statement.

That is a bad position for a self-hosted application to put a household in. The
data is theirs, it is on their disk, and it was legible only to this code.

## Decision

**Three CSV files, on Settings → Sync, beside the backups.**

- `transactions.csv` — one row per transaction, archived rows included and
  marked.
- `delegation-events.csv` — one row per envelope movement, reversed events
  included and marked.
- `snapshots.csv` — the nightly picture, accounts and delegations together.

**Three rather than one wide file, because of splits.** A split transaction has
one amount and two envelope movements. A single file would either repeat the
amount on both rows — so the amount column no longer sums to what left the
accounts — or drop the per-envelope figures, which is the thing somebody
exporting a budget most wants. Two files, each internally consistent: the
register sums to what left the accounts, the ledger sums to what the delegations
hold.

**Money is a decimal, not cents.**
[ADR 002](002-money-as-integer-cents.md) says cents travel as decimal strings,
and that is a rule about JSON, where the danger is a float quietly losing one. A
CSV is opened in a spreadsheet, and a column of `-4210` where `-42.10` was meant
is a column somebody sums and acts on. It is formatted from the integer by hand
so the value never passes through a float on the way out.

**A description is defused before it is written.** Excel and Sheets both treat a
cell beginning `=`, `+`, `-` or `@` as a formula. A bank description is written
by somebody outside this household, and `=HYPERLINK(...)` in a merchant name is a
real way to hand a person a document that does something when they open it. Text
fields get a leading apostrophe when they start with one of those; **generated
values do not**, because a negative amount begins with `-` and must stay a number
the spreadsheet can add up. That distinction is carried in the type — `raw()`
marks a value this application produced — rather than guessed at per call site.

**Plain links, not a fetch and a blob.** A download is a navigation, the session
cookie goes with it, and the browser's own save dialog is better than anything
reimplemented here. The links are labelled for what they do — `Download
transactions as CSV` — because "Transactions" alone is also the sidebar's link
and tells a screen reader nothing about saving a file.

**Any signed-in person may export.** It is the same data every screen already
shows them; making it administrator-only would protect nothing and would make the
household's own records feel borrowed.

## Consequences

**Built in memory rather than streamed.** A decade of a household's register is
tens of thousands of rows — a few megabytes of string on a machine already
running Postgres beside it. Streaming is the right answer at a size this will not
reach, and the wrong complexity to carry until it does. If a deployment ever
finds this slow, the fix is a cursor, and the shape of the code does not fight
it.

**The export is not a backup and must not be read as one.** It cannot restore
this application: no ids, no credentials, no encrypted columns, and by design —
an export that carried the encrypted SimpleFIN token would be a plaintext-adjacent
copy of a secret sitting in a downloads folder. The nightly dump remains the
thing that restores, and the two live beside each other on one card so the
difference is visible.
