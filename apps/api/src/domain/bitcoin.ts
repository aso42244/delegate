import { bitcoinValueCents, type Cents } from '@budget/shared';
import { asDayKey, localDayKey } from './calendar.js';
import type { Db } from '../db/client.js';
import { ValidationError } from './errors.js';

/**
 * The Bitcoin price feed.
 *
 * Bitcoin is held as a **quantity** — satoshis on the account — and its worth is
 * that quantity times the price on the date being displayed. Storing a dollar
 * value would freeze a number that moves by the minute and would make every
 * historical point on the net worth chart wrong.
 *
 * Two things follow, and they are the whole design:
 *
 * 1. **A daily close is cached.** The net worth chart must use the price that
 *    actually applied on each date, not today's price applied backwards.
 * 2. **An unreachable feed holds the last known price and says so.** Never a
 *    zero, never a blank — a holding that silently reads $0 is worse than one
 *    that reads yesterday's number with a staleness flag, because the first
 *    looks like an answer.
 */

/** Both endpoints are keyless and free. One primary, one fallback — §8. */
export interface PriceProvider {
  readonly name: string;
  /** The current spot price of one Bitcoin, in cents. */
  fetchSpotPriceCents(): Promise<Cents>;
}

/** A price that arrived as a decimal string of dollars, e.g. "104812.37". */
function dollarsToCents(text: string, source: string): Cents {
  const match = /^(\d+)(?:\.(\d{1,}))?$/.exec(text.trim());
  if (!match) {
    throw new ValidationError('bitcoin_price_unreadable', `${source} returned an unusable price`);
  }

  const whole = BigInt(match[1] ?? '0');
  // Truncated rather than rounded past two places: a sub-cent fraction of a
  // Bitcoin price is noise, and rounding it would imply a precision the feed
  // does not have.
  const fraction = (match[2] ?? '').padEnd(2, '0').slice(0, 2);
  return whole * 100n + BigInt(fraction);
}

/** A number of dollars, as JSON gives it. Bounded before it becomes money. */
function numberDollarsToCents(value: unknown, source: string): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError('bitcoin_price_unreadable', `${source} returned an unusable price`);
  }
  // Via a fixed-place string rather than `value * 100`: multiplying a float by
  // 100 is exactly how a price becomes wrong by a cent.
  return dollarsToCents(value.toFixed(2), source);
}

const FETCH_TIMEOUT_MS = 10_000;

async function getJson(url: string, source: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ValidationError('bitcoin_price_unavailable', `${source} answered ${response.status}`);
  }
  return response.json();
}

export class CoinGeckoPriceProvider implements PriceProvider {
  readonly name = 'coingecko';

  async fetchSpotPriceCents(): Promise<Cents> {
    const body = await getJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      this.name,
    );
    const price = (body as { bitcoin?: { usd?: unknown } })?.bitcoin?.usd;
    return numberDollarsToCents(price, this.name);
  }
}

export class CoinbasePriceProvider implements PriceProvider {
  readonly name = 'coinbase';

  async fetchSpotPriceCents(): Promise<Cents> {
    const body = await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot', this.name);
    const amount = (body as { data?: { amount?: unknown } })?.data?.amount;
    if (typeof amount !== 'string') {
      throw new ValidationError(
        'bitcoin_price_unreadable',
        `${this.name} returned an unusable price`,
      );
    }
    // Coinbase sends a decimal string, which is exactly right for money and is
    // taken as-is rather than through a float.
    return dollarsToCents(amount, this.name);
  }
}

export function providerByName(name: string): PriceProvider {
  switch (name) {
    case 'coingecko':
      return new CoinGeckoPriceProvider();
    case 'coinbase':
      return new CoinbasePriceProvider();
    default:
      throw new ValidationError(
        'bitcoin_price_provider_unknown',
        `No Bitcoin price provider named "${name}". Known: coingecko, coinbase.`,
      );
  }
}

/**
 * The date a price is filed under: the household's day, not UTC's.
 *
 * The fetch runs hourly, so an evening reading is already tomorrow in UTC and
 * would be filed a day ahead — leaving today without a close and tomorrow with
 * one recorded before it happened. See ADR 037.
 */
export function priceDateOf(now: Date, timeZone: string): Date {
  return localDayKey(now, timeZone);
}

export interface RecordPriceResult {
  readonly priceDate: Date;
  readonly priceCents: Cents;
  readonly source: string;
  readonly closesSettled: number;
}

/**
 * Records a spot price, and settles the close for any earlier day that never got
 * one.
 *
 * Settling here rather than on a separate midnight job is deliberate: a
 * container that was stopped overnight would miss that job entirely and leave a
 * permanent hole in the chart. Every hourly run repairing the day behind it is
 * self-healing, and needs no second schedule.
 *
 * A day the application was not running at all cannot be recovered from a spot
 * endpoint, so it stays absent and readers carry the previous close forward.
 */
export async function recordSpotPrice(
  db: Db,
  input: { readonly priceCents: Cents; readonly source: string; readonly timeZone: string },
  now: Date = new Date(),
): Promise<RecordPriceResult> {
  if (input.priceCents <= 0n) {
    throw new ValidationError('bitcoin_price_not_positive', 'A Bitcoin price must be positive.');
  }

  const priceDate = priceDateOf(now, input.timeZone);

  await db.bitcoinPrice.upsert({
    where: { priceDate_isClose: { priceDate, isClose: false } },
    create: { priceDate, priceCents: input.priceCents, source: input.source, isClose: false },
    update: { priceCents: input.priceCents, source: input.source, fetchedAt: now },
  });

  // The latest intraday price of a finished day becomes that day's close.
  const unsettled = await db.bitcoinPrice.findMany({
    where: { isClose: false, priceDate: { lt: priceDate } },
    select: { priceDate: true, priceCents: true, source: true },
  });

  let closesSettled = 0;
  for (const day of unsettled) {
    const existing = await db.bitcoinPrice.findUnique({
      where: { priceDate_isClose: { priceDate: day.priceDate, isClose: true } },
      select: { id: true },
    });
    if (existing) continue;

    await db.bitcoinPrice.create({
      data: {
        priceDate: day.priceDate,
        priceCents: day.priceCents,
        source: day.source,
        isClose: true,
      },
    });
    closesSettled += 1;
  }

  return { priceDate, priceCents: input.priceCents, source: input.source, closesSettled };
}

/**
 * Fetches from the primary provider and falls back to the second.
 *
 * Both are tried before giving up, and giving up is not an error the caller has
 * to handle specially: the price simply is not updated, and readers carry the
 * last known one forward and flag it stale.
 */
export async function fetchAndRecordPrice(
  db: Db,
  providers: readonly PriceProvider[],
  timeZone: string,
  now: Date = new Date(),
): Promise<RecordPriceResult | null> {
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      const priceCents = await provider.fetchSpotPriceCents();
      return await recordSpotPrice(db, { priceCents, source: provider.name, timeZone }, now);
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  if (failures.length > 0) {
    throw new ValidationError(
      'bitcoin_price_unavailable',
      `No Bitcoin price source answered. ${failures.join('; ')}`,
    );
  }
  return null;
}

export interface PriceReading {
  readonly priceCents: Cents;
  readonly priceDate: Date;
  readonly source: string;
  readonly fetchedAt: Date;
  /**
   * True when this is not the price for the date asked about but the most recent
   * one before it. The value is still shown — never a zero — and marked.
   */
  readonly stale: boolean;
}

/**
 * The most recent price of any kind, with no opinion about whether it is
 * current. Null before the first successful fetch.
 *
 * Separate from `latestPrice` because staleness is a question about *today*, and
 * today needs a zone. A caller that only wants to value a quantity — a
 * revaluation, the composition tile, the account list — would otherwise have to
 * carry a zone down through several layers to compute a flag it throws away, and
 * a parameter threaded for nothing is a parameter that eventually gets threaded
 * wrongly.
 */
export async function newestPrice(db: Db): Promise<Omit<PriceReading, 'stale'> | null> {
  return db.bitcoinPrice.findFirst({
    orderBy: [{ priceDate: 'desc' }, { isClose: 'asc' }],
    select: { priceCents: true, priceDate: true, source: true, fetchedAt: true },
  });
}

/**
 * The most recent price, and whether anybody has refreshed it today.
 *
 * "Today" is the household's day, not UTC's: an evening reading is already
 * tomorrow in UTC, and comparing against that would flag a price fetched
 * minutes ago as a day old. See ADR 037.
 */
export async function latestPrice(
  db: Db,
  timeZone: string,
  now: Date = new Date(),
): Promise<PriceReading | null> {
  const row = await newestPrice(db);
  if (!row) return null;

  // A price from an earlier day is a price nobody has refreshed today.
  return { ...row, stale: row.priceDate.getTime() < priceDateOf(now, timeZone).getTime() };
}

/**
 * The price that applied on a date, for the net worth chart.
 *
 * Falls back to the most recent close before that date, marked stale. Today's
 * price is never applied to a historical date — that is the specific error this
 * whole table exists to prevent.
 */
export async function priceOnDate(db: Db, date: Date): Promise<PriceReading | null> {
  // A date key, not an instant: the caller has already decided which day this
  // is, so normalising it needs no zone. See the note at the top of calendar.ts.
  const priceDate = asDayKey(date);

  const exact = await db.bitcoinPrice.findFirst({
    where: { priceDate },
    orderBy: { isClose: 'desc' },
    select: { priceCents: true, priceDate: true, source: true, fetchedAt: true },
  });
  if (exact) {
    return { ...exact, stale: false };
  }

  const earlier = await db.bitcoinPrice.findFirst({
    where: { priceDate: { lt: priceDate } },
    orderBy: [{ priceDate: 'desc' }, { isClose: 'desc' }],
    select: { priceCents: true, priceDate: true, source: true, fetchedAt: true },
  });
  if (!earlier) return null;

  return { ...earlier, stale: true };
}

/**
 * How long an in-budget holding's dollar figure is allowed to stand.
 *
 * The price is fetched hourly, but `balance_cents` is only rewritten daily. The
 * banner is a reading of the household's spending; one that moved with the
 * market all day would be a reading of the market instead, and "Balanced" would
 * stop meaning anything. The trade is stated in the warning shown the first time
 * a holding is put in the budget: the identity is balanced against a price up to
 * a day old.
 */
export const REVALUE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RevalueResult {
  readonly revalued: number;
}

/**
 * Writes the dollar value of in-budget Bitcoin holdings into `balance_cents`.
 *
 * Only in-budget ones, and this is the whole reason the column is touched at
 * all. The identity sums `balance_cents` directly, so a holding that counts
 * towards the budget must carry a figure there or it contributes zero — which
 * is what it used to do, silently, while every other screen showed the holding
 * at its real worth.
 *
 * A net-worth-only holding is left alone. Nothing sums `balance_cents` for those
 * — the net worth chart and the composition tile both derive quantity × price on
 * read — so writing one would be a second copy of a number that is already
 * computed correctly elsewhere.
 *
 * `force` is for the moments where a day-old figure would be visibly wrong: the
 * quantity just changed, or the holding was only now put in the budget.
 */
export async function revalueBitcoinHoldings(
  db: Db,
  options: { readonly force?: boolean; readonly accountId?: string } = {},
  now: Date = new Date(),
): Promise<RevalueResult> {
  // `newestPrice`, not `latestPrice`: what a quantity is worth does not depend
  // on whether the price is today's, and asking would drag a time zone through
  // every caller that moves a holding.
  const price = await newestPrice(db);
  // No price has ever been fetched. Leaving the previous figure in place is the
  // same rule the rest of this file follows: never a zero, never a blank.
  if (!price) return { revalued: 0 };

  const due = new Date(now.getTime() - REVALUE_AFTER_MS);

  const holdings = await db.account.findMany({
    where: {
      managedAs: 'bitcoin',
      inBudget: true,
      archivedAt: null,
      ...(options.accountId ? { id: options.accountId } : {}),
      ...(options.force
        ? {}
        : { OR: [{ bitcoinRevaluedAt: null }, { bitcoinRevaluedAt: { lt: due } }] }),
    },
    select: { id: true, bitcoinSats: true },
  });

  for (const holding of holdings) {
    await db.account.update({
      where: { id: holding.id },
      data: {
        balanceCents: bitcoinValueCents(holding.bitcoinSats ?? 0n, price.priceCents),
        bitcoinRevaluedAt: now,
      },
    });
  }

  return { revalued: holdings.length };
}

/**
 * Clears the dollar figure on a holding that no longer counts towards the budget.
 *
 * Left behind, it would keep contributing to the identity through
 * `balance_cents` after the toggle said it should not.
 */
export async function clearBudgetValue(db: Db, accountId: string): Promise<void> {
  await db.account.update({
    where: { id: accountId },
    data: { balanceCents: 0n, bitcoinRevaluedAt: null },
  });
}
