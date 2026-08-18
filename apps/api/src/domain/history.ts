import { bitcoinValueCents, sumCents, type Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { accountBalanceDelta } from './accounts.js';
import { priceOnDate } from './bitcoin.js';
import { earliestHoldingDate, satsOnDate } from './bitcoin-holdings.js';
import { valueOnDate } from './valuations.js';

/**
 * Balances over time, reconstructed from the ledger rather than stored.
 *
 * A balance on a date is today's balance minus everything that has moved since.
 * See [ADR 013](../../../docs/decisions/013-historical-balances-are-reconstructed-from-the-ledger.md)
 * — the short version is that snapshots would only start the day they shipped,
 * and the history worth looking at arrives with the backfill.
 *
 * The limit is honest and stated everywhere it matters: a series is exact back
 * to the earliest transaction held for that account and meaningless before it.
 * Drawing further back would produce a flat line at the oldest reconstructable
 * balance, which looks like data.
 */

export interface SeriesPoint {
  readonly date: Date;
  readonly valueCents: Cents;
}

export interface Series {
  readonly points: readonly SeriesPoint[];
  /** Where the history genuinely begins. Null when there is none at all. */
  readonly earliestKnown: Date | null;
  /**
   * True when the series had to be cut short because the ledger does not reach
   * as far back as the window asked for.
   */
  readonly truncated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Evenly spaced days ending today, oldest first. */
function sampleDates(days: number, now: Date): Date[] {
  const today = startOfDay(now);
  return Array.from(
    { length: days },
    (_, index) => new Date(today.getTime() - (days - 1 - index) * DAY_MS),
  );
}

interface AccountForHistory {
  readonly id: string;
  readonly type: 'asset' | 'debt';
  readonly balanceCents: Cents;
  readonly bitcoinSats: Cents | null;
  readonly source: string;
}

/**
 * What one account was worth on each sampled date.
 *
 * Three shapes, because three kinds of account carry their history differently:
 * a Bitcoin holding is a quantity times a price, a property is a series of
 * valuations, and everything else is today's balance rolled backwards through
 * its transactions.
 */
async function accountSeries(
  db: Db,
  account: AccountForHistory,
  dates: readonly Date[],
): Promise<{ values: Cents[]; earliest: Date | null }> {
  if (account.bitcoinSats !== null) {
    const values: Cents[] = [];
    for (const date of dates) {
      // The quantity held *on that date* against the price *on that date*.
      // This used to be today's quantity against each historical price, for
      // want of anywhere to read the quantity from — so a Bitcoin bought last
      // week appeared to have been held all year. The holdings ledger is where
      // it is read from now.
      const [price, sats] = await Promise.all([
        priceOnDate(db, date),
        satsOnDate(db, date, { accountId: account.id }),
      ]);
      values.push(price === null ? 0n : bitcoinValueCents(sats, price.priceCents));
    }

    // History starts at the later of the two things it needs: a quantity to
    // value, and a price to value it at. Claiming to know either before the
    // other would draw a line through nothing.
    const [firstPrice, firstHolding] = await Promise.all([
      db.bitcoinPrice.findFirst({ orderBy: { priceDate: 'asc' }, select: { priceDate: true } }),
      earliestHoldingDate(db, { accountId: account.id }),
    ]);
    const earliest =
      firstPrice && firstHolding
        ? firstPrice.priceDate > firstHolding
          ? firstPrice.priceDate
          : firstHolding
        : (firstPrice?.priceDate ?? firstHolding);

    return { values, earliest };
  }

  const valuationCount = await db.accountValuation.count({ where: { accountId: account.id } });
  if (valuationCount > 0) {
    const values: Cents[] = [];
    for (const date of dates) {
      values.push((await valueOnDate(db, account.id, date)) ?? 0n);
    }
    const first = await db.accountValuation.findFirst({
      where: { accountId: account.id },
      orderBy: { asOf: 'asc' },
      select: { asOf: true },
    });
    return { values, earliest: first?.asOf ?? null };
  }

  const transactions = await db.transaction.findMany({
    where: { accountId: account.id, archivedAt: null },
    select: { postedAt: true, amountCents: true },
    orderBy: { postedAt: 'asc' },
  });

  const earliest = transactions[0]?.postedAt ?? null;

  const values = dates.map((date) => {
    // Everything that moved strictly after this date, rolled back out.
    const since = transactions.filter((transaction) => transaction.postedAt > date);
    const moved = sumCents(
      since.map((transaction) => accountBalanceDelta(account.type, transaction.amountCents)),
    );
    return account.balanceCents - moved;
  });

  return { values, earliest };
}

async function accountsForHistory(db: Db, where: object): Promise<AccountForHistory[]> {
  const rows = await db.account.findMany({
    where: { archivedAt: null, ...where },
    select: { id: true, type: true, balanceCents: true, bitcoinSats: true, source: true },
  });
  return rows;
}

/**
 * Net worth over time: every account marked as counting towards it, including
 * the off-budget ones. Debts subtract.
 */
export async function netWorthSeries(db: Db, days = 180, now: Date = new Date()): Promise<Series> {
  const dates = sampleDates(days, now);
  const accounts = await accountsForHistory(db, { inNetWorth: true });
  if (accounts.length === 0) return { points: [], earliestKnown: null, truncated: false };

  const totals = dates.map(() => 0n);
  let earliestKnown: Date | null = null;

  for (const account of accounts) {
    const { values, earliest } = await accountSeries(db, account, dates);
    for (const [index, value] of values.entries()) {
      const sign = account.type === 'debt' ? -1n : 1n;
      totals[index] = (totals[index] ?? 0n) + sign * value;
    }
    if (earliest && (earliestKnown === null || earliest < earliestKnown)) {
      earliestKnown = earliest;
    }
  }

  return buildSeries(dates, totals, earliestKnown);
}

/** One account's balance over time — the credit card trend, and anything like it. */
export async function singleAccountSeries(
  db: Db,
  accountId: string,
  days = 180,
  now: Date = new Date(),
): Promise<Series> {
  const dates = sampleDates(days, now);
  const [account] = await accountsForHistory(db, { id: accountId });
  if (!account) return { points: [], earliestKnown: null, truncated: false };

  const { values, earliest } = await accountSeries(db, account, dates);
  return buildSeries(dates, values, earliest);
}

/** Property value less what is still owed, on each date. */
export async function equitySeries(
  db: Db,
  propertyAccountId: string,
  days = 180,
  now: Date = new Date(),
): Promise<Series> {
  const property = await db.account.findUnique({
    where: { id: propertyAccountId },
    select: { mortgageAccountId: true },
  });
  if (!property?.mortgageAccountId) return { points: [], earliestKnown: null, truncated: false };

  const [value, owed] = await Promise.all([
    singleAccountSeries(db, propertyAccountId, days, now),
    singleAccountSeries(db, property.mortgageAccountId, days, now),
  ]);

  // Aligned by date, never by index: the two series are truncated at their own
  // earliest history, so their arrays start on different days. Zipping them
  // positionally would subtract a mortgage balance from the wrong date and draw
  // an equity line that is confidently wrong.
  const owedByDate = new Map(owed.points.map((point) => [point.date.getTime(), point.valueCents]));
  const points = value.points
    .filter((point) => owedByDate.has(point.date.getTime()))
    .map((point) => ({
      date: point.date,
      valueCents: point.valueCents - (owedByDate.get(point.date.getTime()) ?? 0n),
    }));

  const earliest =
    value.earliestKnown && owed.earliestKnown
      ? value.earliestKnown > owed.earliestKnown
        ? value.earliestKnown
        : owed.earliestKnown
      : (value.earliestKnown ?? owed.earliestKnown);

  return { points, earliestKnown: earliest, truncated: value.truncated || owed.truncated };
}

/**
 * Cuts the series at the point history genuinely begins.
 *
 * Everything before that would be a flat line at the oldest reconstructable
 * balance, which reads as a fact and is not one.
 */
function buildSeries(
  dates: readonly Date[],
  values: readonly Cents[],
  earliestKnown: Date | null,
): Series {
  if (earliestKnown === null) {
    return { points: [], earliestKnown: null, truncated: dates.length > 0 };
  }

  const cutoff = startOfDay(earliestKnown);
  const points: SeriesPoint[] = [];
  let truncated = false;

  for (const [index, date] of dates.entries()) {
    if (date < cutoff) {
      truncated = true;
      continue;
    }
    points.push({ date, valueCents: values[index] ?? 0n });
  }

  return { points, earliestKnown, truncated };
}
