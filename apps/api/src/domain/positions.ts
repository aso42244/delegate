import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import type { FeedHolding } from '../simplefin/protocol.js';
import { localDayKey } from './calendar.js';
import { ValidationError } from './errors.js';
import { BENCHMARK_SYMBOL } from './investments.js';

/**
 * Where positions and the benchmark's prices come from (ADR 080).
 *
 * Positions arrive with the feed. A holding the feed stops reporting is
 * archived, never deleted: its lots stay attached, and a position sold and
 * bought back is the same row woken up rather than a stranger.
 */

/** Which feed holding a position is: the feed's own id where it sends one, else the symbol. */
function feedKeyOf(holding: FeedHolding): string {
  return holding.externalId ?? holding.symbol;
}

export async function syncHoldings(
  db: Db,
  accountId: string,
  holdings: readonly FeedHolding[],
  now: Date,
): Promise<{ upserted: number; archived: number }> {
  const seen = new Set<string>();
  for (const holding of holdings) {
    const feedKey = feedKeyOf(holding);
    seen.add(feedKey);
    await db.position.upsert({
      where: { accountId_feedKey: { accountId, feedKey } },
      create: {
        accountId,
        feedKey,
        symbol: holding.symbol,
        description: holding.description,
        sharesMicros: holding.sharesMicros,
        marketValueCents: holding.marketValueCents,
        feedCostBasisCents: holding.costBasisCents,
        asOf: now,
      },
      update: {
        symbol: holding.symbol,
        description: holding.description,
        sharesMicros: holding.sharesMicros,
        marketValueCents: holding.marketValueCents,
        feedCostBasisCents: holding.costBasisCents,
        asOf: now,
        archivedAt: null,
      },
    });
  }

  const gone = await db.position.updateMany({
    where: { accountId, archivedAt: null, feedKey: { notIn: [...seen] } },
    data: { archivedAt: now },
  });
  return { upserted: holdings.length, archived: gone.count };
}

/** One close, as a provider reports it. */
export interface IndexClose {
  /** The trading day, as a date key. */
  readonly date: Date;
  /** The dividend-adjusted close, in cents. */
  readonly closeCents: Cents;
}

export interface IndexPriceProvider {
  readonly name: string;
  /** Every adjusted close from `since` to now. */
  fetchCloses(symbol: string, since: Date): Promise<readonly IndexClose[]>;
}

/**
 * Yahoo's chart endpoint: keyless, daily, and dividend-adjusted.
 *
 * Unofficial, which is the honest cost of keyless. It is asked only for the
 * benchmark — never for a ticker the household holds — so nothing about what
 * is owned leaves the house. A failure keeps the closes already stored.
 */
export class YahooChartProvider implements IndexPriceProvider {
  readonly name = 'yahoo';

  async fetchCloses(symbol: string, since: Date): Promise<readonly IndexClose[]> {
    const period1 = Math.floor(since.getTime() / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit&includeAdjustedClose=true`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Delegate)' },
    });
    if (!response.ok) {
      throw new ValidationError(
        'index_price_unavailable',
        `${this.name} answered ${response.status}`,
      );
    }
    return parseYahooChart(await response.json());
  }
}

/** The chart's timestamps and adjusted closes, paired; a null close is a day without one. */
export function parseYahooChart(body: unknown): IndexClose[] {
  const result = (
    body as {
      chart?: {
        result?: {
          timestamp?: unknown;
          indicators?: { adjclose?: { adjclose?: unknown }[] };
        }[];
      };
    }
  )?.chart?.result?.[0];
  const stamps = result?.timestamp;
  const closes = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(stamps) || !Array.isArray(closes)) {
    throw new ValidationError('index_price_unreadable', 'yahoo returned no chart');
  }

  const out: IndexClose[] = [];
  const values = closes as readonly unknown[];
  (stamps as readonly unknown[]).forEach((stamp, index) => {
    const close = values[index];
    if (
      typeof stamp !== 'number' ||
      typeof close !== 'number' ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      return;
    }
    // The exchange's own day. A close stamped at the New York open is that
    // New York date wherever the household is.
    const date = localDayKey(new Date(stamp * 1000), 'America/New_York');
    // Through a fixed-place string rather than `close * 100`.
    const [whole, fraction = ''] = close.toFixed(2).split('.');
    out.push({ date, closeCents: BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) });
  });
  return out;
}

/**
 * Fetches the benchmark's closes and stores them, replacing what was there.
 *
 * **Every close from the earliest that matters, every time.** An adjusted
 * close is rescaled backwards whenever a dividend is paid, so a close stored in
 * March and one fetched in June are on different scales; mixing them would
 * misstate every comparison across the dividend. Refetching the whole span
 * keeps every stored close on one scale.
 */
export async function refreshBenchmark(
  db: Db,
  provider: IndexPriceProvider,
  now: Date = new Date(),
): Promise<{ stored: number }> {
  const earliestLot = await db.positionLot.findFirst({
    where: { archivedAt: null },
    orderBy: { purchasedOn: 'asc' },
    select: { purchasedOn: true },
  });
  const oneYearAgo = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
  const since =
    earliestLot === null || earliestLot.purchasedOn > oneYearAgo
      ? oneYearAgo
      : // A week before, so a lot bought on a holiday still finds the close before it.
        new Date(earliestLot.purchasedOn.getTime() - 7 * 24 * 60 * 60 * 1000);

  const closes = await provider.fetchCloses(BENCHMARK_SYMBOL, since);
  if (closes.length === 0) return { stored: 0 };

  // One at a time: a few hundred rows a night, and the `Db` a caller hands in
  // may itself be a transaction.
  for (const close of closes) {
    await db.indexPrice.upsert({
      where: { symbol_priceDate: { symbol: BENCHMARK_SYMBOL, priceDate: close.date } },
      create: {
        symbol: BENCHMARK_SYMBOL,
        priceDate: close.date,
        closeCents: close.closeCents,
        source: provider.name,
      },
      update: { closeCents: close.closeCents, source: provider.name, fetchedAt: now },
    });
  }
  return { stored: closes.length };
}
