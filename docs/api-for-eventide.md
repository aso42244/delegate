# The read door: Delegate's API for Eventide

The whole of what another application can read from this budget, and how. Four
routes, one credential, no writes. This is the contract Eventide's Finances view
is built against; a field that changes here changes here first.

Decisions: [ADR 069](decisions/069-a-token-reads-as-a-person.md) (the
credential), [ADR 070](decisions/070-the-read-door-is-its-own-surface.md) (the
door), [ADR 071](decisions/071-tokens-are-managed-on-access.md) (where they are
managed), [ADR 081](decisions/081-the-read-door-reads-the-register.md) (the
register). On the Eventide side, its ADR 268 is what this implements.

## The credential

A bearer token, made on **Settings → Access → API tokens** by the person it will
read as. It is shown once, at creation, and never again; Delegate keeps a SHA-256
digest. It looks like `dlg_` followed by 43 characters of base64url.

Send it on every request:

```
Authorization: Bearer dlg_…
```

Nothing else authenticates here. A session cookie is refused whether or not a
token rides beside it, and the token opens nothing but the four routes below — not
the budget's own API, not the token routes, nothing that writes.

**It reads as the person who made it.** Whatever that account can see, the token
sees; in this household that is the whole budget. Revoke it from the same card.
Revoking signs nobody out and touches no other token.

## Refusals

| What was sent                                              | Status | Body                                                                                |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| No `Authorization`, or not `Bearer …`                      | 401    | `{"error":{"code":"bearer_required","message":"This route takes a bearer token."}}` |
| A token nobody issued                                      | 401    | `{"error":{"code":"invalid_token","message":"This token is not accepted."}}`        |
| A **revoked** token                                        | 401    | identical to the line above                                                         |
| A token whose account has been archived                    | 401    | identical to the line above                                                         |
| Anything over the onion address while remote access is off | 404    | empty                                                                               |
| A `POST` (or anything but `GET`) to any route              | 404    | `{"error":{"code":"route_not_found",…}}`                                            |
| A query the transactions route cannot read                 | 400    | `{"error":{"code":"invalid_request",…}}`, naming the field in `details.fields`      |
| A transaction id that is no transaction                    | 404    | `{"error":{"code":"not_found",…}}`                                                  |
| Too many requests from one address                         | 429    | `{"error":{"code":"too_many_requests",…}}`                                          |

Unknown, revoked and archived are deliberately one answer. Both 401s carry a
`WWW-Authenticate: Bearer` header. Every response carries `Cache-Control:
no-store`.

## Units, everywhere

- **Money is a string of whole cents.** `"41287"` is $412.87. Never a JSON
  number, never dollars. Parse it as an integer (`BigInt`, or an integer type
  that holds 64 bits); do not divide by a hundred until the moment it is shown.
  Negative is a leading `-`. A field that can have no answer is `null`, which is
  not `"0"`.
- **Debts are positive magnitudes.** A $500 card balance is `"50000"`.
- **An instant** (`asOf`, `cycleStartedAt`, `balanceAsOf`, `checkIssuedAt`,
  `oldestPostedAt`, `start`, `end`, `since`, `postedAt`, `archivedAt`) is an
  ISO 8601 timestamp in UTC.
- **A day** (`targetDate`) is `YYYY-MM-DD` and has no zone: a decided day.
- `progressBasisPoints` is an integer 0–10000.

## `GET /api/read/budget`

The Budget page, flattened. Every live delegation, every in-budget account, and
the reading at the top.

```json
{
  "asOf": "2026-09-21T14:00:00.000Z",
  "identity": {
    "status": "to_delegate",
    "differenceCents": "489000",
    "toleranceCents": "500",
    "assetsCents": "1240000",
    "debtsCents": "51000",
    "delegationsCents": "700000",
    "pendingCents": "0"
  },
  "cycleStartedAt": "2026-09-12T00:00:00.000Z",
  "delegations": [
    {
      "id": "3f1c…",
      "name": "Grocery",
      "kind": "envelope",
      "checkNumber": null,
      "checkMemo": null,
      "checkIssuedAt": null,
      "grouping": { "id": "9b2e…", "name": "3 - Food", "color": "#46A171" },
      "balanceCents": "41287",
      "amountToDelegateCents": "25000",
      "isUtility": false,
      "notes": null,
      "target": null,
      "max": {
        "maxBalanceCents": "40000",
        "roomCents": "0",
        "delegatingCents": "0",
        "withheldCents": "25000",
        "status": "full"
      }
    },
    {
      "id": "c4d8…",
      "name": "Check 1042 — Roof repair",
      "kind": "check",
      "checkNumber": "1042",
      "checkMemo": "Roof repair",
      "checkIssuedAt": "2026-09-12T00:00:00.000Z",
      "grouping": { "id": "e70a…", "name": "Outstanding Checks", "color": null },
      "balanceCents": "85000",
      "amountToDelegateCents": null,
      "isUtility": false,
      "notes": null,
      "target": null,
      "max": null
    }
  ],
  "accounts": [
    {
      "id": "7a90…",
      "name": "Everyday Checking",
      "type": "asset",
      "grouping": null,
      "balanceCents": "1240000",
      "standbyCents": "0",
      "source": "simplefin",
      "managedAs": "none",
      "balanceAsOf": "2026-09-21T09:00:00.000Z",
      "needsReview": false
    }
  ]
}
```

| Field                                                                    | Type                                            | Meaning                                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asOf`                                                                   | instant                                         | When this was computed.                                                                                                                                              |
| `identity.status`                                                        | `to_delegate` \| `balanced` \| `over_delegated` | The reading beside the page title.                                                                                                                                   |
| `identity.differenceCents`                                               | cents                                           | Assets − debts − delegations + categorized pending. Positive is money not yet delegated.                                                                             |
| `identity.toleranceCents`                                                | cents                                           | Within ± this reads `balanced`.                                                                                                                                      |
| `identity.assetsCents`, `debtsCents`, `delegationsCents`, `pendingCents` | cents                                           | The four terms of that subtraction.                                                                                                                                  |
| `cycleStartedAt`                                                         | instant \| null                                 | When Delegate was last pressed. Null before the first press.                                                                                                         |
| `delegations[]`                                                          | list                                            | Every live line, in the order the Budget page shows them: grouping by grouping, then the ungrouped.                                                                  |
| `delegations[].kind`                                                     | `envelope` \| `check`                           | A `check` row is an outstanding cheque, carried as a line.                                                                                                           |
| `delegations[].checkNumber`                                              | string \| null                                  | Checks only: the number that identifies one among several outstanding. Null on an envelope — the key is always present.                                              |
| `delegations[].checkMemo`                                                | string \| null                                  | Checks only: what it was written for. Null on an envelope, and null on a check written without one — never an empty string.                                          |
| `delegations[].checkIssuedAt`                                            | instant \| null                                 | Checks only: when it was written. Null on an envelope.                                                                                                               |
| `delegations[].grouping`                                                 | `{id, name, color}` \| null                     | `color` is `#RRGGBB` or null.                                                                                                                                        |
| `delegations[].balanceCents`                                             | cents                                           | **What is left in the envelope.** Negative is overspent.                                                                                                             |
| `delegations[].amountToDelegateCents`                                    | cents \| null                                   | Added on each Delegate press. Null is an ad-hoc line, which is not zero.                                                                                             |
| `delegations[].isUtility`                                                | boolean                                         |                                                                                                                                                                      |
| `delegations[].notes`                                                    | string \| null                                  | Free text.                                                                                                                                                           |
| `delegations[].target`                                                   | object \| null                                  | What the line is saving towards, or null on most lines.                                                                                                              |
| `target.targetCents`                                                     | cents                                           |                                                                                                                                                                      |
| `target.targetDate`                                                      | day \| null                                     | The next occurrence still ahead.                                                                                                                                     |
| `target.intervalMonths`                                                  | integer \| null                                 | Null is a one-off.                                                                                                                                                   |
| `target.shortfallCents`                                                  | cents                                           | Still to be put in; `"0"` once met.                                                                                                                                  |
| `target.cyclesRemaining`                                                 | integer \| null                                 | Paychecks left before the date. Null without a date.                                                                                                                 |
| `target.neededPerCycleCents`                                             | cents \| null                                   | What each remaining paycheck has to carry.                                                                                                                           |
| `target.status`                                                          | `met` \| `on_track` \| `behind` \| `standing`   |                                                                                                                                                                      |
| `delegations[].max`                                                      | object \| null                                  | The ceiling a Delegate press stops at, or null on most lines. Only Delegate is capped — a transfer, a refund or an adjustment may take a line past it.               |
| `max.maxBalanceCents`                                                    | cents                                           | The ceiling itself, as the household typed it.                                                                                                                       |
| `max.roomCents`                                                          | cents                                           | What still fits below it. `"0"` once the line is at or over it.                                                                                                      |
| `max.delegatingCents`                                                    | cents                                           | What the next press would actually move into this line.                                                                                                              |
| `max.withheldCents`                                                      | cents                                           | What the maximum keeps out of that press. `"0"` when it is not in the way; the money stays undelegated rather than going elsewhere.                                  |
| `max.status`                                                             | `room` \| `partial` \| `full`                   | Whether the whole amount fits, some of it, or none.                                                                                                                  |
| `accounts[]`                                                             | list                                            | In-budget accounts only, assets then debts, each in the Budget page's order. Off-budget accounts (property, retirement) are net worth, not budget, and are not here. |
| `accounts[].type`                                                        | `asset` \| `debt`                               |                                                                                                                                                                      |
| `accounts[].balanceCents`                                                | cents                                           | The figure the page shows, standby included. Debts positive.                                                                                                         |
| `accounts[].standbyCents`                                                | cents                                           | How much of that is hand-entered while the feed was behind. `"0"` almost always.                                                                                     |
| `accounts[].source`                                                      | `simplefin` \| `manual`                         |                                                                                                                                                                      |
| `accounts[].managedAs`                                                   | `none` \| `bitcoin` \| `property`               |                                                                                                                                                                      |
| `accounts[].balanceAsOf`                                                 | instant \| null                                 | When the figure was last confirmed.                                                                                                                                  |
| `accounts[].needsReview`                                                 | boolean                                         | A synced account the household has not yet classified.                                                                                                               |

## `GET /api/read/overview`

The figures band across the top of Overview, the pay cycle, and the three
readings a glance needs.

```json
{
  "asOf": "2026-09-21T14:00:00.000Z",
  "payCycle": {
    "start": "2026-09-12T00:00:00.000Z",
    "end": "2026-09-26T00:00:00.000Z",
    "lengthDays": 14,
    "elapsedDays": 9,
    "progressBasisPoints": 6429
  },
  "figures": [
    { "key": "inflow", "valueCents": "491470", "count": null },
    { "key": "spent", "valueCents": "312044", "count": null },
    { "key": "left_to_spend", "valueCents": "179426", "count": null },
    { "key": "uncategorized", "valueCents": null, "count": 4 },
    { "key": "safe_per_day", "valueCents": "35885", "count": null },
    { "key": "net_worth", "valueCents": "48210000", "count": null },
    { "key": "days_to_payday", "valueCents": null, "count": 5 }
  ],
  "uncategorized": { "count": 4, "oldestPostedAt": "2026-09-18T00:00:00.000Z" },
  "overspent": [{ "id": "3f1c…", "name": "Dining", "balanceCents": "-1820" }],
  "spendingByGrouping": {
    "since": "2026-09-12T00:00:00.000Z",
    "cycleMissing": false,
    "entries": [{ "key": "9b2e…", "name": "3 - Food", "color": "#46A171", "spendCents": "61204" }]
  },
  "spending": [{ "id": "5d7a…", "spentCents": "48210" }]
}
```

| Field                                | Type                                        | Meaning                                                                                           |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `payCycle`                           | object \| null                              | Null when no payday anchor is set. Then there is no tick, no `safe_per_day`, no `days_to_payday`. |
| `payCycle.start`, `end`              | instant                                     | The cycle is `[start, end)`; `end` is the next payday.                                            |
| `payCycle.lengthDays`, `elapsedDays` | integer                                     | `elapsedDays` never exceeds `lengthDays`.                                                         |
| `payCycle.progressBasisPoints`       | integer                                     | 0 on payday, approaching 10000 the day before the next.                                           |
| `figures[]`                          | list, always these seven keys in this order | Each is money (`valueCents`) or a count (`count`); the other is null.                             |
| `inflow`, `spent`, `left_to_spend`   | cents                                       | Since the cycle started; since ever when there is no cycle. `spent` is a positive magnitude.      |
| `uncategorized`                      | count                                       | Transactions waiting to be filed.                                                                 |
| `safe_per_day`                       | cents \| null                               | `left_to_spend` over the days left in the cycle. Null without a cycle.                            |
| `net_worth`                          | cents                                       | Every in-net-worth asset less every debt, at today's values.                                      |
| `days_to_payday`                     | count \| null                               | Null without a cycle.                                                                             |
| `uncategorized.count`                | integer                                     | The backlog, again, beside the age of its oldest row.                                             |
| `uncategorized.oldestPostedAt`       | instant \| null                             |                                                                                                   |
| `overspent[]`                        | list                                        | Every line below zero, with its (negative) balance. Usually empty.                                |
| `spendingByGrouping.since`           | instant \| null                             | Where the window starts: the cycle start.                                                         |
| `spendingByGrouping.cycleMissing`    | boolean                                     | True when no cycle has run yet, in which case `entries` is empty rather than everything.          |
| `spendingByGrouping.entries[]`       | list                                        | Spend per grouping this cycle, largest first. `key` is the grouping id, or `ungrouped`.           |
| `spending[]`                         | list                                        | One entry per active delegation, in the Budget page's order, for its pace bar.                    |
| `spending[].id`                      | string                                      | The delegation's id, as in `/api/read/budget`'s `delegations[].id`.                               |
| `spending[].spentCents`              | cents                                       | Spent from the line since the payday (the last press without one). A magnitude, never negative.   |

## `GET /api/read/transactions`

The register, newest first, a page at a time. Built for finding one purchase —
"Start a record" in Possessions — and reading it whole.

| Parameter    | Type          | Meaning                                                                                                                          |
| ------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `search`     | string, ≤ 200 | Words in the description, the account, a line's name, or the household's own name for the merchant. A bare `42.10` is an amount. |
| `accountId`  | id            | One account, as in `/api/read/budget`'s `accounts[].id` — or any account, in or off the budget.                                  |
| `sign`       | `in` \| `out` | Money in (refunds, income) or money out (purchases).                                                                             |
| `dateFrom`   | instant       | Posted at or after this.                                                                                                         |
| `dateBefore` | instant       | Posted strictly before this.                                                                                                     |
| `limit`      | integer 1–100 | Rows per page. 50 when absent.                                                                                                   |
| `offset`     | integer ≥ 0   | Rows to skip. 0 when absent.                                                                                                     |

Archived rows are never listed.

```json
{
  "asOf": "2026-10-07T14:00:00.000Z",
  "transactions": [
    {
      "id": "b81e…",
      "postedAt": "2026-09-14T15:00:00.000Z",
      "amountCents": "-64999",
      "description": "BESTBUY 00012 ONLINE",
      "merchantName": "Best Buy",
      "pending": false,
      "kind": "normal",
      "archivedAt": null,
      "account": { "id": "7a90…", "name": "Rewards Visa", "type": "debt" },
      "allocations": [{ "delegationId": "5d7a…", "name": "Household", "amountCents": "-64999" }]
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

| Field                                | Type                               | Meaning                                                                                                                     |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `transactions[]`                     | list                               | Newest first. Rows posted at the same instant keep one order from page to page.                                             |
| `transactions[].postedAt`            | instant                            | When it posted.                                                                                                             |
| `transactions[].amountCents`         | cents                              | **Signed from the household's side.** A purchase is negative on a card and on checking alike; a refund is positive.         |
| `transactions[].description`         | string                             | What the bank called it, or what was typed for a manual row.                                                                |
| `transactions[].merchantName`        | string \| null                     | The household's own name for the merchant. Null keeps the bank's — show `description`.                                      |
| `transactions[].pending`             | boolean                            | Not yet posted by the bank. Its amount and date may still change.                                                           |
| `transactions[].kind`                | `normal` \| `income` \| `transfer` | A purchase or refund is `normal`. A transfer — a card payment among them — moves money between accounts and is no purchase. |
| `transactions[].archivedAt`          | instant \| null                    | Always null in the list. Set only when a row is read by its id after it was withdrawn.                                      |
| `transactions[].account`             | `{id, name, type}`                 | `name` is the short name where the household gave one. `type` is `asset` or `debt`.                                         |
| `transactions[].allocations[]`       | list                               | The lines it was filed to. Empty while uncategorized; more than one when split.                                             |
| `allocations[].delegationId`, `name` | string                             | As in `/api/read/budget`'s `delegations[]`. The name resolves even for a line since archived.                               |
| `allocations[].amountCents`          | cents                              | Its share of the row, signed as the row is. The shares sum to `amountCents`.                                                |
| `total`                              | integer                            | Every matching row, not just this page.                                                                                     |

## `GET /api/read/transactions/:id`

One row, in the same shape, as `{"transaction": {…}}`. **Archived rows are
answered here too**, with `archivedAt` set: a record that points at a purchase
keeps resolving after the purchase is withdrawn from the register. An id that
is no transaction is a 404 `not_found`; one that is not a uuid is a 400.

## What this is not

There is no write route and no route that takes a body. The register is here to
find and read a purchase, not to work it: categorizing, splitting and the page's
other filters stay on the page. Anything Eventide needs that is not here is a
change to this document first.
