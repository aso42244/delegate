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
 * The 12 month buckets ending with the one `now` falls in — **in the household's
 * zone**.
 *
 * This is where the UTC reading was most wrong. A charge at eight in the evening
 * on the last of the month is already the first of the next in UTC, so it landed
 * in the following month's average and the suggestion drawn from it was off by
 * that spend in both directions. See ADR 037.
 */
function monthWindow(now: Date, timeZone: string): Date[] {
  const current = localMonthKey(now, timeZone);
  return Array.from({ length: MONTHS_SHOWN }, (_, index) =>
    addMonthsToKey(current, index - (MONTHS_SHOWN - 1)),
  );
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
  const months = monthWindow(now, timeZone);
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

    const complete = monthly.filter((entry) => entry.complete);
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
      months: monthly,
      averageCents,
      suggestedPerCycleCents: suggestedPerCycleCents(averageCents, cyclesPerYear),
    };
  });
}
