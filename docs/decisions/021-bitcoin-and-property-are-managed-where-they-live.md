# 021. Bitcoin and property are managed where they live

**Status:** accepted
**Date:** 2026-08-16

## Context

Adding a Bitcoin holding took two steps in two places: create an account under
Settings → Accounts, then attach a quantity under Settings → Bitcoin & Property.
A property was the same — create the account, then record a value. The owner
asked for both to be creatable from their own tab.

Underneath that was a bug the two-step flow made easy to hit. Setting a quantity
wrote `bitcoin_sats` and nothing else, but `computeBudgetIdentity` sums
`balance_cents` straight from `accounts`. A holding marked in-budget therefore
contributed **zero** to the one number the owner reads, while the Accounts page,
the composition tile and the net worth chart all showed it at quantity × price.
Nothing anywhere said the two disagreed.

## Decision

**The account row stays. Its lifecycle moves.**

Every part of this system reads `accounts`: the identity, the budget read model,
the net worth series, the equity netting, the staleness banners. Giving Bitcoin
or property their own home would mean reimplementing all of it for two cases. So
a holding and a property remain ordinary rows, and a new column says who owns
them:

    managed_as: none | bitcoin | property

Their tab creates, renames and retires them. Settings → Accounts still lists them
— leaving them off would make that page a lie about what the budget is made of —
but shows them read-only with a link to where they are understood.

The guard runs in both directions, and that is deliberate. `PATCH
/api/accounts/:id` refuses a managed row, and the Bitcoin and property routes
refuse an unmanaged one. Flipping `in_budget` from the Accounts route would set
the flag without writing the dollar figure the identity reads, which is exactly
the bug above; leaving one route that could still do it would be closing the bug
by convention rather than by construction.

**An in-budget holding is revalued daily, not hourly.**

`balance_cents` is written for in-budget holdings only, because that is the only
place it is read for them — the chart and the composition tile derive quantity ×
price themselves, and a second stored copy would be a second thing to get wrong.

Daily rather than on every price fetch: the banner is a reading of the
household's spending, and one that moved with the market all day would be a
reading of the market instead. "Balanced" has to mean something about behaviour.
The trade is that the identity is balanced against a price up to 24 hours old,
which is stated in a warning shown the first time anyone puts a holding in the
budget — once, household-wide, because a warning repeated on every toggle is one
nobody reads.

Three moments override the daily cadence, because a day-old figure would be
visibly wrong: the quantity changed, the holding was just created, or it was just
put into the budget. Taking one _out_ of the budget clears the figure instead;
left behind it would go on counting after the toggle said it should not.

Default: net worth on, budget off. Bitcoin and a house are not spendable, so
counting either as budget money is a decision rather than the path of least
resistance.

## Consequences

Backfill is derived from what each row already demonstrates about itself — a
holding carries satoshis, a property has a valuation or a mortgage pointed at it
— so no existing account has to be reclassified by hand.

An in-budget holding makes the identity move on its own, once a day, with no
transaction behind it. That is the honest consequence of asking a spending
question about an asset that reprices, and the warning says so rather than
hiding it.

`account_valuations` is unchanged and still lives on `/api/accounts/:id/valuations`.
Recording what something was worth is not specific to a house.

## Amendment, 2026-08-23

**A holding and a property are no longer rows on Settings → Accounts. They are
one line under the tables.**

The original decision kept them in the list and gave the reason in a sentence:
leaving them off "would make that page a lie about what the budget is made of."
That reasoning is still right, and this amendment does not overturn it — it
stops paying two full rows for it.

What the owner asked for was that both be managed _exclusively_ where they live.
Two read-only rows, each carrying a name, a chip, a figure and a button through
to another tab, were the largest thing on a page whose whole problem was that it
was too busy. They also read as accounts you might edit, which is exactly what
they are not.

So the page now ends with:

    Also counted:  1505 E Otonka Trail  $350,000.00  ·  Ott Multi-Sig

Neither is listed among the accounts, neither has a row menu, and each name
links to the tab that owns it. The page still shows what the totals are made of
— in 30px rather than 100.

**A figure appears only where `balance_cents` is maintained**, which is the
decision above read back honestly. A property's is its valuation and is always
written. A holding's is written only while it is in the budget; taking one out
clears it, so a net-worth-only holding carries `0` — the absence of a figure,
not a balance of zero. The row this line replaces printed that `0` as `$0.00`
next to a wallet worth six figures, which was wrong every day it shipped. The
name still links through to where the real quantity lives.

The guard is unchanged and still runs in both directions: `PATCH
/api/accounts/:id` refuses a managed row and the Bitcoin and property routes
refuse an unmanaged one. Nothing about the identity, the daily revaluation or
the defaults moves.

One consequence worth stating. The line is the _only_ place on this page those
two figures appear, so it must not be dropped in a future tidy-up of the same
kind. If it ever goes, the page becomes the thing this ADR was written to
prevent.
