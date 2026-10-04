# 080. Brokerage positions from the feed, lots by hand, judged against the S&P 500

**Status:** accepted
**Date:** 2026-10-04

## Context

Delegate tracked Bitcoin as purchases with a cost basis and nothing else as an
investment: a brokerage account was a balance. The household asked for its
brokerage positions too, with true purchase lots held to the penny and each
purchase judged against an index from the date it was made — not a flat
average return, which flatters a purchase at a peak and punishes one in a dip.

SimpleFIN reports, for brokerages whose bridge supports it, a `holdings` list
per account: symbol, shares, market value and a total cost basis. It does not
report individual purchases.

## Decision

**The feed says what is held; the household says when it was bought.**

- **Positions come from the feed.** Each sync upserts an account's holdings
  into `positions`, matched on the feed's holding id or the symbol. A holding
  the feed stops reporting is archived, never deleted, and comes back as the
  same row — lots and all — if it is reported again. A holding that cannot be
  read is skipped; it never fails the sync. Only USD.
- **Lots are entered by hand** in Settings → Holdings → Brokerage: the date,
  the shares, and the whole cost with fees. Corrected in place, archived rather
  than deleted.
- **Each position is held to the feed.** The page says whether its lots add up
  to the feed's shares to the millionth and its cost basis to the cent, and by
  how much they do not.
- **The benchmark is the S&P 500, through SPY's dividend-adjusted closes.** A
  lot is compared with what its cost, put into SPY at the close on or before
  its purchase date, is worth at the latest close. The closes come keylessly
  from Yahoo's chart endpoint behind a swappable provider, fetched each
  weekday evening (`INDEX_PRICE_CRON`) or on demand from the card. Only SPY is
  ever asked for — never a ticker the household holds.
- **The closes are refetched as one span.** An adjusted close is rescaled
  backwards on every dividend, so closes fetched months apart are on different
  scales. Each fetch replaces every close from the earliest lot onward.
- **Shares are millionths of a share in BIGINT, money is cents in BIGINT.** A
  lot's value is its share of the position's market value, rounded half away
  from zero.
- An Overview tile, **Investments against the S&P 500**, shows each position's
  value and its recorded purchases against the index.

## Consequences

- The position's value is the feed's, so it is as current as the last sync.
  The account balance is unchanged — it already includes the holdings — so
  net worth does not double count them.
- A position whose lots do not cover it compares only the shares that are
  covered, and says so.
- Yahoo's endpoint is unofficial. If it stops answering, the closes already
  stored stand, the card shows the date of the newest, and a different provider
  can be put behind the same interface.
- Positions without a feed (a brokerage whose bridge does not report holdings)
  are not supported yet; they would need a hand-entered position and a price
  per ticker, which is the leak this design avoids.
