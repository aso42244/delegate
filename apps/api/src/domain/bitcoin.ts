import type { Cents } from '@budget/shared';
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

/** Midnight UTC for a moment — the date a price is filed under. */
export function priceDateOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
  input: { readonly priceCents: Cents; readonly source: string },
  now: Date = new Date(),
): Promise<RecordPriceResult> {
  if (input.priceCents <= 0n) {
    throw new ValidationError('bitcoin_price_not_positive', 'A Bitcoin price must be positive.');
  }

  const priceDate = priceDateOf(now);

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
  now: Date = new Date(),
): Promise<RecordPriceResult | null> {
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      const priceCents = await provider.fetchSpotPriceCents();
      return await recordSpotPrice(db, { priceCents, source: provider.name }, now);
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

/** The most recent price of any kind. Null before the first successful fetch. */
export async function latestPrice(db: Db, now: Date = new Date()): Promise<PriceReading | null> {
  const row = await db.bitcoinPrice.findFirst({
    orderBy: [{ priceDate: 'desc' }, { isClose: 'asc' }],
    select: { priceCents: true, priceDate: true, source: true, fetchedAt: true },
  });
  if (!row) return null;

  return {
    priceCents: row.priceCents,
    priceDate: row.priceDate,
    source: row.source,
    fetchedAt: row.fetchedAt,
    // A price from an earlier day is a price nobody has refreshed today.
    stale: row.priceDate.getTime() < priceDateOf(now).getTime(),
  };
}

/**
 * The price that applied on a date, for the net worth chart.
 *
 * Falls back to the most recent close before that date, marked stale. Today's
 * price is never applied to a historical date — that is the specific error this
 * whole table exists to prevent.
 */
export async function priceOnDate(db: Db, date: Date): Promise<PriceReading | null> {
  const priceDate = priceDateOf(date);

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
