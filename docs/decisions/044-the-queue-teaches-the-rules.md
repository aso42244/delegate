# 044. The queue teaches the rules

**Status:** accepted
**Date:** 2026-09-01

## Context

Categorizing the queue is the chore this application asks the household to
perform, and the rules engine exists to shrink it. In practice it did not,
because there was no route from one to the other.

A rule could only be created on Settings → Rules, from a blank dialog, against a
merchant name somebody had to remember and type correctly. So the categorizations
repeated most often — the ones that would benefit most from a rule — were exactly
the ones nobody stopped mid-queue to automate. The evidence for what the rule
should say was sitting in the register the whole time, in the form of the same
decision made fourteen times, and nothing read it.

There was also a dead endpoint. `POST /api/rules/from-transaction` and
`createRuleFromTransaction` were built long ago and **called by nothing** — no
interface, no test, no end-to-end spec. Reading it explains why it was never
missed: it built the rule from the **whole** raw description. For `AMAZON
MKTPL*RT4G93` that is a rule matching a reference which never occurs again, so it
would have matched the one transaction it was built from and nothing else, for
ever, silently. The feature was not merely unfinished. It was wrong in the
particular way this project keeps writing down: it would have appeared to work.

## Decision

Two halves of one idea, and they share a normalization so they cannot disagree.

**The queue answers from its own history.** For an uncategorized row,
`GET /api/transactions/suggestions` reports where that merchant went the last few
times: a delegation, and the counts behind it. The row shows the name; the
evidence — `2 of 2 before went to Grocery` — is in the accessible name and on
hover, which is the same division a header pill makes and for the same reason.

**A suggestion is advice and writes nothing**, exactly like the pair suggestions
(§7) and like a check proposal ([ADR 030](030-a-cleared-check-is-confirmed-not-assumed.md)).
It is offered in three places that are all one press: a button in the register
row, the first entry in the picker's list, and the first entry in the sheet on a
phone. Being first in the picker also improves what was already there — pressing
Enter on an empty query used to choose the first of an arbitrary eight.

**What counts as evidence is deliberately conservative.**

- **Two prior decisions, and a majority of them.** One is as often a coincidence
  as a pattern, and a merchant split evenly between two envelopes has no answer
  to give — offering either half of a tie invents one.
- **A split is not evidence.** It says one charge was two things, which is a fact
  about that charge rather than about the merchant, and counting it would let one
  transaction vote twice.
- **An archived delegation is never suggested.** It still resolves for history —
  `Grocery (archived)` — but offering it as a destination offers a category that
  no longer exists.

**A merchant is the first three letter-runs of the raw feed text, ignoring runs
shorter than three characters.** `KROGER #123 CINCINNATI` and `KROGER #4471
CINCINNATI` land on one key; `AMAZON MKTPL*RT4G93` and `AMAZON MKTPL*ZX9WK1` land
on one key. It is a heuristic and it is allowed to be, because **every suggestion
carries the count it was drawn from** — a key that grouped the wrong things says
so on the row rather than hiding inside a confident answer.

**And the row menu turns an accepted suggestion into a rule.** _Always categorize
like this_, on a row already filed under exactly one delegation, opens a dialog
whose match text is a **field, not a fact**: pre-filled with the merchant, and
editable before anything is created.

That field is the whole fix for the dead endpoint. The needle cannot be the
merchant key, because the key is normalized and a rule matches the real
description — `kroger cincinnati`, built by deleting `#123` from between the two
words, appears nowhere in the text it came from. So the longest leading run of
the key that **is** actually present wins, and a single token always is, because
every token came from that text. `WHOLEFDS MKT #10234` yields `WHOLEFDS MKT`,
which fires on the next visit to a different store.

It is still a guess: it cannot know that `TST*` is a payment processor rather
than the restaurant. The expensive failure here is a needle broad enough to file
future charges somewhere wrong, so the guess is shown where it can be read and
corrected rather than applied where it cannot.

## Consequences

**`merchantKey` and `suggestedMatchValue` live in `@budget/shared`**, not in the
API. The server groups history with one and the dialog fills its field with the
other, and if those two drifted apart the rule created from a suggestion would
stop matching the transactions that produced it — with nothing to say so.

**The suggestion is its own request, not a field on the register.** A slow tally
cannot hold up the rows, and a failure to answer leaves a page that works with
nothing suggested on it. That is the right failure for advice: absent, never
wrong.

**It is bounded on both sides** — the most recent 5,000 categorized transactions
as evidence, the most recent 1,000 waiting rows as questions. The register grows
for ever and this runs whenever it is opened. Recent history is also better
evidence than old: where a merchant went last year matters less than where it
went last month.

**No bulk "accept every suggestion".** It was considered and deliberately left
out. Accepting fifty heuristic decisions in one press is the shape of action this
codebase already regrets elsewhere, and the per-row press is one keystroke.

**There is no preview of what a new rule would match**, which is the one thing a
future session might want to add. Settings → Rules has a preview for the bulk
apply and this dialog has none, so a needle that is too broad is visible only
after the next sync. The mitigation is that rules are archivable and only ever
touch uncategorized rows; the cost is that the failure is quiet, which is the
kind of cost worth revisiting.
