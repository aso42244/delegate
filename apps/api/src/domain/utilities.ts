import { suggestedPerCycleCents, sumCents, type Cents } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * The Utilities page.
 *
 * The owner does this arithmetic by hand today: what does the water bill average
 * over a year, and what is that per paycheck? Showing it is the entire point of
 * the page — §9.3 says so outright. It **suggests only** and never writes an
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
  /** monthly average × 12 ÷ 26. Advice, never auto-written. */
  readonly suggestedPerCycleCents: Cents;
}

const MONTHS_SHOWN = 12;

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

/** The 12 month buckets ending with the one `now` falls in. */
function monthWindow(now: Date): Date[] {
  const current = startOfMonth(now);
  return Array.from({ length: MONTHS_SHOWN }, (_, index) =>
    addMonths(current, index - (MONTHS_SHOWN - 1)),
  );
}

export async function buildUtilitySummaries(
  db: Db,
  now: Date = new Date(),
): Promise<UtilitySummary[]> {
  const months = monthWindow(now);
  const windowStart = months[0] ?? startOfMonth(now);
  const currentMonth = startOfMonth(now);

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
      const next = addMonths(month, 1);
      const inMonth = mine.filter(
        (allocation) =>
          allocation.transaction.postedAt >= month && allocation.transaction.postedAt < next,
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
      suggestedPerCycleCents: suggestedPerCycleCents(averageCents),
    };
  });
}
