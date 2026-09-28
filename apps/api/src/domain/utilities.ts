import { CYCLES_PER_YEAR, suggestedPerCycleCents, sumCents, type Cents } from '@budget/shared';
import { addMonthsToKey, localMonthKey, startOfLocalDay } from './calendar.js';
import type { Db } from '../db/client.js';
import { getBudgetSettings } from './settings.js';

/**
 * The Utilities page.
 *
 * The owner does this arithmetic by hand today: what does the water bill average
 * over a year, and what is that per paycheck? Showing it is the entire point of
 * the page — §9.3 says so outright. How many paychecks a year that is comes
 * from the household's pay cadence on Settings → Budget. It **suggests only** and never writes an
 * amount to delegate, because a bill that averages $118 is not the same as a
 * decision to fund it at $118.
 *
 * Spend is read from **allocations**, not from delegation events. That excludes
 * `adjust` events for free, which is required: an adjustment is a correction to
 * a balance, not money spent on water, and letting one into an average would
 * quietly move the suggestion.
 */

export interface MonthlySpend {
  /** First day of the month, midnight UTC. */
  readonly month: Date;
  /** A positive magnitude. Refunds within the month reduce it. */
  readonly spendCents: Cents;
  /** False for the month still in progress, which is not a full month of bills. */
  readonly complete: boolean;
}

export interface UtilitySummary {
  readonly delegationId: string;
  readonly name: string;
  readonly groupingName: string | null;
  readonly groupingColor: string | null;
  readonly amountToDelegateCents: Cents | null;
  readonly months: readonly MonthlySpend[];
  /**
   * Mean over the **complete** months only. Including the current partial month
   * would make the average collapse on the second of every month and recover by
   * the thirtieth, which is worse than useless for a number meant to be compared
   * against a standing amount.
   */
  readonly averageCents: Cents;
  /**
   * The monthly average spread over a year's paychecks, at the household's
   * configured cadence. Advice, never auto-written.
   */
  readonly suggestedPerCycleCents: Cents;
  /**
   * The last twelve complete months against the twelve before, in basis points.
   * Null when there is not enough history to say, which is not the same as flat.
   */
  readonly trendBasisPoints: number | null;
}

export interface UtilitiesView {
  readonly summaries: readonly UtilitySummary[];
  /**
   * How many paychecks a year the suggestion was divided by.
   *
   * Returned rather than left for the interface to look up, so the figure and
   * the sentence explaining it cannot disagree — a page saying "over 26" beside
   * a number computed from 24 is worse than either alone.
   */
  readonly cyclesPerYear: number;
}

const MONTHS_SHOWN = 12;

/**
 * How far back the trend looks: the last twelve complete months against the
 * twelve before them.
 *
 * Twelve against twelve rather than six against six, because these bills are
 * seasonal. Electricity in July against electricity in January is summer against
 * winter, which is weather rather than a trend — and a tile that flagged every
 * air-conditioned household every June would be one nobody reads by August. A
 * full year on each side cancels the season out and leaves the thing worth
 * knowing: it costs more than it used to.
 */
const TREND_MONTHS = 24;

/**
 * The 12 month buckets ending with the one `now` falls in — **in the household's
 * zone**.
 *
 * This is where the UTC reading was most wrong. A charge at eight in the evening
 * on the last of the month is already the first of the next in UTC, so it landed
 * in the following month's average and the suggestion drawn from it was off by
 * that spend in both directions. See ADR 037.
 */
function monthWindow(now: Date, timeZone: string, length = MONTHS_SHOWN): Date[] {
  const current = localMonthKey(now, timeZone);
  return Array.from({ length }, (_unused, index) => addMonthsToKey(current, index - (length - 1)));
}

/**
 * Which way a bill is going, in basis points, or null.
 *
 * Null when there are not two full years of complete months behind it, or when
 * the earlier year spent nothing. A household eight months in has no year to
 * compare against, and a confident 0% would say something false — the tile says
 * it does not know yet instead.
 */
function trendBasisPoints(months: readonly MonthlySpend[]): number | null {
  const complete = months.filter((entry) => entry.complete);
  if (complete.length < TREND_MONTHS - 1) return null;

  const recent = complete.slice(-MONTHS_SHOWN);
  const earlier = complete.slice(-MONTHS_SHOWN * 2, -MONTHS_SHOWN);
  if (recent.length < MONTHS_SHOWN || earlier.length < MONTHS_SHOWN) return null;

  const before = sumCents(earlier.map((entry) => entry.spendCents));
  if (before <= 0n) return null;

  const after = sumCents(recent.map((entry) => entry.spendCents));
  return Number(((after - before) * 10_000n) / before);
}

export async function buildUtilities(
  db: Db,
  timeZone: string,
  now: Date = new Date(),
): Promise<UtilitiesView> {
  const { payCadence } = await getBudgetSettings(db);
  const cyclesPerYear = CYCLES_PER_YEAR[payCadence];

  return {
    summaries: await buildUtilitySummaries(db, cyclesPerYear, timeZone, now),
    cyclesPerYear,
  };
}

export async function buildUtilitySummaries(
  db: Db,
  cyclesPerYear: number,
  timeZone: string,
  now: Date = new Date(),
): Promise<UtilitySummary[]> {
  // Two years back for the trend; the page and the tiles draw the last twelve.
  const months = monthWindow(now, timeZone, TREND_MONTHS);
  const currentMonth = localMonthKey(now, timeZone);
  const firstMonth = months[0] ?? currentMonth;
  // The window is filtered on a timestamp column, so the boundary has to be the
  // instant that month begins here — not midnight UTC on the same date.
  const windowStart = startOfLocalDay(firstMonth, timeZone);

  const delegations = await db.delegation.findMany({
    // Archived utilities still appear in historical views — §6.9.
    where: { isUtility: true },
    select: {
      id: true,
      name: true,
      amountToDelegateCents: true,
      archivedAt: true,
      grouping: { select: { name: true, color: true } },
    },
    orderBy: { name: 'asc' },
  });
  if (delegations.length === 0) return [];

  const allocations = await db.transactionAllocation.findMany({
    where: {
      delegationId: { in: delegations.map((delegation) => delegation.id) },
      transaction: {
        archivedAt: null,
        // Income and confirmed transfers are not spending on a utility.
        kind: 'normal',
        postedAt: { gte: windowStart },
      },
    },
    select: {
      delegationId: true,
      amountCents: true,
      transaction: { select: { postedAt: true } },
    },
  });

  return delegations.map((delegation) => {
    const mine = allocations.filter((allocation) => allocation.delegationId === delegation.id);

    const monthly = months.map((month): MonthlySpend => {
      /*
       * `postedAt` is an instant and `month` is a date key, so the bounds have
       * to be the instants the month spans here. Comparing the instant against
       * the key directly is the same conflation that put an evening spend in the
       * following month — it just did it at the edge of the month rather than
       * the edge of the window.
       */
      const from = startOfLocalDay(month, timeZone);
      const to = startOfLocalDay(addMonthsToKey(month, 1), timeZone);
      const inMonth = mine.filter(
        (allocation) =>
          allocation.transaction.postedAt >= from && allocation.transaction.postedAt < to,
      );

      // Spending is stored negative, so the magnitude is the negation. A refund
      // inside the month is positive and reduces it, which is correct.
      const net = sumCents(inMonth.map((allocation) => allocation.amountCents));
      return {
        month,
        spendCents: -net,
        complete: month.getTime() !== currentMonth.getTime(),
      };
    });

    /*
     * The complete months **of the twelve shown**, which is not the same as the
     * last twelve complete months of twenty-four.
     *
     * The longer window exists only for the trend. Taking twelve complete months
     * out of it reaches back past the year the page draws and, on a household
     * whose history is shorter than the window, changes the divisor — eleven
     * months of bills averaged over twelve. That moves the suggestion without
     * anything about the household having changed.
     */
    const shown = monthly.slice(-MONTHS_SHOWN);
    const complete = shown.filter((entry) => entry.complete);
    const averageCents =
      complete.length === 0
        ? 0n
        : sumCents(complete.map((entry) => entry.spendCents)) / BigInt(complete.length);

    return {
      delegationId: delegation.id,
      name: delegation.archivedAt ? `${delegation.name} (archived)` : delegation.name,
      groupingName: delegation.grouping?.name ?? null,
      groupingColor: delegation.grouping?.color ?? null,
      amountToDelegateCents: delegation.amountToDelegateCents,
      // The window fetched is two years; what anything draws is the last twelve.
      months: shown,
      averageCents,
      suggestedPerCycleCents: suggestedPerCycleCents(averageCents, cyclesPerYear),
      trendBasisPoints: trendBasisPoints(monthly),
    };
  });
}
