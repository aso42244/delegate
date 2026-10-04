import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ValidationError } from './errors.js';

/**
 * Brokerage positions, their purchase lots, and the S&P 500 they are judged
 * against (ADR 080).
 *
 * **The feed says what is held; the household says when it was bought.** A
 * SimpleFIN holding carries shares, market value and a total cost basis per
 * position, and nothing about the individual purchases. Those are lots, entered
 * by hand where the household wants them, and each lot is held to the feed: the
 * lots of a position should add up to its shares and its cost basis, to the
 * share and to the cent, and the page says when they do not.
 *
 * **Shares are millionths, money is cents, and neither is ever a float.** A
 * share count is not money, so it is not cents — `sharesMicros` is the count
 * times a million, which holds every fractional share a brokerage reports.
 *
 * **The comparison is from the actual date.** A lot bought on 3 March is judged
 * against what the same dollars in SPY on 3 March would be worth today, from
 * dividend-adjusted closes. A flat average return would flatter a lot bought
 * at a peak and punish one bought in a dip, which is the opposite of the
 * question somebody asks of their own purchases.
 */

/** Shares are stored as millionths of a share. */
export const SHARE_SCALE = 1_000_000n;

/** The index purchases are compared against. One, deliberately: ADR 080. */
export const BENCHMARK_SYMBOL = 'SPY';

/** "12.5" or "0.003451" as millionths of a share; refuses more precision than that. */
export function parseShares(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    throw new ValidationError(
      'shares_unreadable',
      'Shares must be a number with at most six decimal places',
    );
  }
  return BigInt(match[1] ?? '0') * SHARE_SCALE + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** Millionths of a share back to "12.5", trailing zeros trimmed. */
export function formatShares(micros: bigint): string {
  const whole = micros / SHARE_SCALE;
  const fraction = (micros % SHARE_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** Integer division rounded half away from zero, for money out of a ratio. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

export interface LotReading {
  readonly id: string;
  readonly purchasedOn: Date;
  readonly sharesMicros: bigint;
  readonly costCents: Cents;
  readonly note: string | null;
  /** The lot's share of the position's market value now. */
  readonly valueCents: Cents;
  readonly gainCents: Cents;
  /** The same cost, put into the benchmark on the purchase date, now. Null without prices for that date. */
  readonly benchmarkValueCents: Cents | null;
  /** Value less the benchmark's: positive is a purchase that beat the index. */
  readonly versusBenchmarkCents: Cents | null;
}

export interface PositionReading {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly symbol: string;
  readonly description: string | null;
  readonly sharesMicros: bigint;
  readonly marketValueCents: Cents;
  /** What the feed reports the whole position cost. Null where it does not say. */
  readonly feedCostBasisCents: Cents | null;
  readonly asOf: Date;
  readonly archived: boolean;
  readonly lots: readonly LotReading[];
  /** The lots summed, held against the feed's shares and cost basis. */
  readonly lotSharesMicros: bigint;
  readonly lotCostCents: Cents;
  /** `matched` when the lots are exactly the shares the feed reports. */
  readonly shareCoverage: 'none' | 'short' | 'matched' | 'over';
  /** Lot cost less the feed's cost basis. Zero is reconciled to the cent. */
  readonly costDifferenceCents: Cents | null;
}

export interface InvestmentsReading {
  readonly positions: readonly PositionReading[];
  readonly benchmark: {
    readonly symbol: string;
    /** The newest close held, and the day it is for. Null before any is fetched. */
    readonly latestDate: Date | null;
    readonly latestCloseCents: Cents | null;
  };
  /** Across every lot that has a benchmark figure. */
  readonly totals: {
    readonly marketValueCents: Cents;
    readonly lotCostCents: Cents;
    readonly lotValueCents: Cents;
    readonly benchmarkValueCents: Cents;
  };
}

export async function buildInvestments(db: Db): Promise<InvestmentsReading> {
  const [positions, latest] = await Promise.all([
    db.position.findMany({
      where: { archivedAt: null },
      orderBy: [{ marketValueCents: 'desc' }, { symbol: 'asc' }],
      select: {
        id: true,
        accountId: true,
        symbol: true,
        description: true,
        sharesMicros: true,
        marketValueCents: true,
        feedCostBasisCents: true,
        asOf: true,
        archivedAt: true,
        account: { select: { name: true, nickname: true } },
        lots: {
          where: { archivedAt: null },
          orderBy: { purchasedOn: 'asc' },
          select: { id: true, purchasedOn: true, sharesMicros: true, costCents: true, note: true },
        },
      },
    }),
    db.indexPrice.findFirst({
      where: { symbol: BENCHMARK_SYMBOL },
      orderBy: { priceDate: 'desc' },
      select: { priceDate: true, closeCents: true },
    }),
  ]);

  /*
   * The close on or before each purchase date — a lot bought on a Saturday is
   * judged from Friday's close, which is what the money would have bought.
   */
  const dates = [
    ...new Set(positions.flatMap((p) => p.lots.map((lot) => lot.purchasedOn.getTime()))),
  ];
  const closeOn = new Map<number, bigint>();
  await Promise.all(
    dates.map(async (time) => {
      const row = await db.indexPrice.findFirst({
        where: { symbol: BENCHMARK_SYMBOL, priceDate: { lte: new Date(time) } },
        orderBy: { priceDate: 'desc' },
        select: { closeCents: true },
      });
      if (row) closeOn.set(time, row.closeCents);
    }),
  );

  let marketValueCents = 0n;
  let lotCostCents = 0n;
  let lotValueCents = 0n;
  let benchmarkValueCents = 0n;

  const readings = positions.map((position): PositionReading => {
    marketValueCents += position.marketValueCents;
    const lots = position.lots.map((lot): LotReading => {
      const valueCents =
        position.sharesMicros === 0n
          ? 0n
          : divRound(position.marketValueCents * lot.sharesMicros, position.sharesMicros);
      const then = closeOn.get(lot.purchasedOn.getTime());
      const benchmark =
        then === undefined || latest === null
          ? null
          : divRound(lot.costCents * latest.closeCents, then);
      if (benchmark !== null) {
        lotCostCents += lot.costCents;
        lotValueCents += valueCents;
        benchmarkValueCents += benchmark;
      }
      return {
        id: lot.id,
        purchasedOn: lot.purchasedOn,
        sharesMicros: lot.sharesMicros,
        costCents: lot.costCents,
        note: lot.note,
        valueCents,
        gainCents: valueCents - lot.costCents,
        benchmarkValueCents: benchmark,
        versusBenchmarkCents: benchmark === null ? null : valueCents - benchmark,
      };
    });

    const lotShares = lots.reduce((sum, lot) => sum + lot.sharesMicros, 0n);
    const lotCost = lots.reduce((sum, lot) => sum + lot.costCents, 0n);
    return {
      id: position.id,
      accountId: position.accountId,
      accountName: position.account.nickname ?? position.account.name,
      symbol: position.symbol,
      description: position.description,
      sharesMicros: position.sharesMicros,
      marketValueCents: position.marketValueCents,
      feedCostBasisCents: position.feedCostBasisCents,
      asOf: position.asOf,
      archived: position.archivedAt !== null,
      lots,
      lotSharesMicros: lotShares,
      lotCostCents: lotCost,
      shareCoverage:
        lots.length === 0
          ? 'none'
          : lotShares === position.sharesMicros
            ? 'matched'
            : lotShares < position.sharesMicros
              ? 'short'
              : 'over',
      costDifferenceCents:
        position.feedCostBasisCents === null || lots.length === 0
          ? null
          : lotCost - position.feedCostBasisCents,
    };
  });

  return {
    positions: readings,
    benchmark: {
      symbol: BENCHMARK_SYMBOL,
      latestDate: latest?.priceDate ?? null,
      latestCloseCents: latest?.closeCents ?? null,
    },
    totals: { marketValueCents, lotCostCents, lotValueCents, benchmarkValueCents },
  };
}
