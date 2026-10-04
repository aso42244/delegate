import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { addMonthsToKey, localDayKey, localMonthKey, startOfLocalDay } from './calendar.js';
import { findRecurringBills } from './recurring.js';

/**
 * A month, read back from the ledger at the moment it is looked at (ADR 078).
 *
 * **Nothing here is stored.** Every figure is a query over rows that already
 * exist — transactions, allocations, delegation events, nightly snapshots — so
 * a charge categorized late, or a row archived, changes the month it belongs to
 * the next time the month is opened. A stored report would be a second copy of
 * the ledger that could disagree with it, and this application has exactly one.
 *
 * **The budget's accounts only.** Came in and Went out count rows on in-budget
 * accounts, the same accounts the identity sums. An IRA's purchases are net
 * worth, not spending, and the net worth section below is where they show.
 */

export interface MonthLine {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  readonly archived: boolean;
  /** What Delegate presses put into the line during the month. */
  readonly delegatedCents: Cents;
  /** Ordinary spending filed to it in the month, net of refunds. A magnitude. */
  readonly spentCents: Cents;
  /** Delegated less spent. Negative is a line that spent more than it was given. */
  readonly leftCents: Cents;
}

export type BillMove =
  /** Charged a different amount from usual. */
  | {
      readonly kind: 'moved';
      readonly amountCents: Cents;
      readonly typicalCents: Cents;
      readonly changeBasisPoints: number;
      readonly day: Date;
    }
  /** Its first charge ever landed this month. */
  | { readonly kind: 'new'; readonly amountCents: Cents; readonly day: Date }
  /** Due this month, and nothing came. */
  | { readonly kind: 'missed'; readonly typicalCents: Cents; readonly expectedDay: Date };

export interface MonthBill {
  readonly key: string;
  readonly name: string;
  readonly delegationId: string | null;
  readonly move: BillMove;
}

export interface MonthNetWorth {
  /** The snapshot dates read, which are the month's edges or the nearest before. */
  readonly startDate: Date;
  readonly endDate: Date;
  readonly startCents: Cents;
  readonly endCents: Cents;
  /** Assets other than Bitcoin, end less start. */
  readonly otherAssetsChangeCents: Cents;
  /** Bitcoin at its price, end less start — quantity and price together. */
  readonly bitcoinChangeCents: Cents;
  /** Debts at the start less debts at the end: positive is paid down. */
  readonly debtsPaidDownCents: Cents;
}

export interface MonthReview {
  /** The first day of the month, as a date key. */
  readonly month: Date;
  /** The instants it spans in the household's zone, `before` exclusive. */
  readonly from: Date;
  readonly before: Date;
  readonly cameInCents: Cents;
  readonly wentOutCents: Cents;
  readonly previous: { readonly cameInCents: Cents; readonly wentOutCents: Cents } | null;
  readonly lines: readonly MonthLine[];
  /** Ordinary spending nobody has filed yet, net. Part of Went out, in no line. */
  readonly uncategorizedCents: Cents;
  readonly bills: readonly MonthBill[];
  /** Null until the nightly snapshots cover both edges of the month. */
  readonly netWorth: MonthNetWorth | null;
}

/** Below this, a bill is "the same as usual": a few cents of tax is not a move. */
const MOVE_FLOOR_CENTS = 100n;
/** And a change smaller than this share of the typical charge is not one either. */
const MOVE_BASIS_POINTS = 1000;
/** Only a bill that comes about monthly or more often can be said to have missed a month. */
const MISSABLE_INTERVAL_DAYS = 35;

/** The months a review can open: from the first transaction to the last finished month. */
export async function reviewableMonths(
  db: Db,
  timeZone: string,
  now: Date = new Date(),
): Promise<{ readonly first: Date | null; readonly last: Date }> {
  const last = addMonthsToKey(localMonthKey(now, timeZone), -1);
  const earliest = await db.transaction.findFirst({
    where: { archivedAt: null },
    orderBy: { postedAt: 'asc' },
    select: { postedAt: true },
  });
  const first = earliest === null ? null : localMonthKey(earliest.postedAt, timeZone);
  return { first: first !== null && first > last ? last : first, last };
}

async function flow(
  db: Db,
  from: Date,
  before: Date,
): Promise<{ cameInCents: Cents; wentOutCents: Cents }> {
  const rows = await db.transaction.groupBy({
    by: ['kind'],
    where: {
      archivedAt: null,
      kind: { in: ['income', 'normal'] },
      account: { inBudget: true },
      postedAt: { gte: from, lt: before },
    },
    _sum: { amountCents: true },
  });
  const sum = (kind: string): Cents =>
    rows.find((row) => row.kind === kind)?._sum.amountCents ?? 0n;
  // Spending is stored negative; Went out is its magnitude, refunds netted.
  return { cameInCents: sum('income'), wentOutCents: -sum('normal') };
}

/**
 * Net worth on the last snapshot date at or before `key`.
 *
 * The totals come from the nightly aggregate, which is the figure the net worth
 * chart draws, so the two cannot disagree about a month's edges. Bitcoin is the
 * one split the aggregate does not keep: it is read from that date's account
 * rows, where a holding is the row that carries a quantity.
 */
async function worthOn(
  db: Db,
  key: Date,
): Promise<{ date: Date; assets: Cents; bitcoin: Cents; debts: Cents } | null> {
  const aggregate = await db.aggregateSnapshot.findFirst({
    where: { snapshotDate: { lte: key } },
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true, netWorthAssetsCents: true, netWorthDebtsCents: true },
  });
  if (aggregate === null) return null;

  const holdings = await db.accountSnapshot.aggregate({
    where: {
      inNetWorth: true,
      snapshotDate: aggregate.snapshotDate,
      accountType: 'asset',
      quantitySats: { not: null },
    },
    _sum: { balanceCents: true },
  });
  return {
    date: aggregate.snapshotDate,
    assets: aggregate.netWorthAssetsCents,
    bitcoin: holdings._sum.balanceCents ?? 0n,
    debts: aggregate.netWorthDebtsCents,
  };
}

export async function buildMonthReview(
  db: Db,
  options: { readonly month: Date; readonly timeZone: string },
  now: Date = new Date(),
): Promise<MonthReview> {
  const { month, timeZone } = options;
  const from = startOfLocalDay(month, timeZone);
  const before = startOfLocalDay(addMonthsToKey(month, 1), timeZone);
  const previousFrom = startOfLocalDay(addMonthsToKey(month, -1), timeZone);

  const [current, previous, hasPrevious, delegated, allocations, loose, bills, start, end] =
    await Promise.all([
      flow(db, from, before),
      flow(db, previousFrom, from),
      db.transaction.count({
        where: { archivedAt: null, postedAt: { gte: previousFrom, lt: from } },
      }),
      // Delegate presses only. A transfer between lines is the household moving
      // money it already gave, and an adjustment is a correction — neither is
      // what the line was given this month.
      db.delegationEvent.groupBy({
        by: ['delegationId'],
        where: {
          eventType: 'delegate',
          reversedAt: null,
          occurredAt: { gte: from, lt: before },
        },
        _sum: { deltaCents: true },
      }),
      db.transactionAllocation.groupBy({
        by: ['delegationId'],
        where: {
          transaction: {
            archivedAt: null,
            kind: 'normal',
            postedAt: { gte: from, lt: before },
          },
        },
        _sum: { amountCents: true },
      }),
      // The uncategorized queue's own predicate, over the month.
      db.transaction.aggregate({
        where: {
          archivedAt: null,
          kind: 'normal',
          allocations: { none: {} },
          account: { inBudget: true },
          postedAt: { gte: from, lt: before },
        },
        _sum: { amountCents: true },
      }),
      findRecurringBills(db, timeZone, now),
      // Snapshots are filed under the day they describe the end of: the last
      // day before the month, and the month's own last day.
      worthOn(db, new Date(month.getTime() - 24 * 60 * 60 * 1000)),
      worthOn(db, new Date(addMonthsToKey(month, 1).getTime() - 24 * 60 * 60 * 1000)),
    ]);

  const delegatedById = new Map(
    delegated.map((row) => [row.delegationId, row._sum.deltaCents ?? 0n]),
  );
  const spentById = new Map(
    allocations.map((row) => [row.delegationId, -(row._sum.amountCents ?? 0n)]),
  );
  const ids = [...new Set([...delegatedById.keys(), ...spentById.keys()])];
  const delegations = await db.delegation.findMany({
    // Every line that moved, archived and checks included: the lines have to
    // add up to Went out with the uncategorized row, and a cashed check is
    // spending like any other.
    where: { id: { in: ids } },
    select: { id: true, name: true, archivedAt: true, grouping: { select: { color: true } } },
  });

  const lines: MonthLine[] = delegations
    .map((delegation) => {
      const delegatedCents = delegatedById.get(delegation.id) ?? 0n;
      const spentCents = spentById.get(delegation.id) ?? 0n;
      return {
        delegationId: delegation.id,
        name: delegation.name,
        color: delegation.grouping?.color ?? null,
        archived: delegation.archivedAt !== null,
        delegatedCents,
        spentCents,
        leftCents: delegatedCents - spentCents,
      };
    })
    .filter((line) => line.delegatedCents !== 0n || line.spentCents !== 0n)
    /*
     * The lines that spent more than they were given first, worst first; then
     * the rest by what they spent. The question a month answers is "where did
     * it go further than planned", and that answer belongs at the top.
     */
    .sort((a, b) => {
      const overA = a.leftCents < 0n;
      const overB = b.leftCents < 0n;
      if (overA !== overB) return overA ? -1 : 1;
      if (overA) return a.leftCents < b.leftCents ? -1 : a.leftCents > b.leftCents ? 1 : 0;
      return b.spentCents > a.spentCents ? 1 : b.spentCents < a.spentCents ? -1 : 0;
    });

  const inMonth = (at: Date): boolean => at >= from && at < before;
  const moved: MonthBill[] = [];
  for (const bill of bills) {
    const charges = bill.charges.filter((charge) => inMonth(charge.postedAt));
    const oldest = bill.charges[bill.charges.length - 1];

    if (oldest !== undefined && inMonth(oldest.postedAt)) {
      moved.push({
        key: bill.key,
        name: bill.name,
        delegationId: bill.delegationId,
        move: {
          kind: 'new',
          amountCents: oldest.amountCents,
          day: localDayKey(oldest.postedAt, timeZone),
        },
      });
      continue;
    }

    const charge = charges[0];
    if (charge !== undefined) {
      const change = charge.amountCents - bill.typicalAmountCents;
      const magnitude = change < 0n ? -change : change;
      const basisPoints =
        bill.typicalAmountCents === 0n ? 0 : Number((change * 10_000n) / bill.typicalAmountCents);
      if (magnitude >= MOVE_FLOOR_CENTS && Math.abs(basisPoints) >= MOVE_BASIS_POINTS) {
        moved.push({
          key: bill.key,
          name: bill.name,
          delegationId: bill.delegationId,
          move: {
            kind: 'moved',
            amountCents: charge.amountCents,
            typicalCents: bill.typicalAmountCents,
            changeBasisPoints: basisPoints,
            day: localDayKey(charge.postedAt, timeZone),
          },
        });
      }
      continue;
    }

    /*
     * Nothing this month. Missed only for a bill that comes at least monthly,
     * had been arriving before the month began, and was due inside it.
     */
    if (bill.intervalDays > MISSABLE_INTERVAL_DAYS) continue;
    const lastBefore = bill.charges.find((entry) => entry.postedAt < from);
    if (lastBefore === undefined) continue;
    const expected = new Date(
      localDayKey(lastBefore.postedAt, timeZone).getTime() +
        bill.intervalDays * 24 * 60 * 60 * 1000,
    );
    if (expected < month || expected >= addMonthsToKey(month, 1)) continue;
    moved.push({
      key: bill.key,
      name: bill.name,
      delegationId: bill.delegationId,
      move: { kind: 'missed', typicalCents: bill.typicalAmountCents, expectedDay: expected },
    });
  }

  // The biggest moves first, then what is new, then what did not come.
  const rank = (bill: MonthBill): number =>
    bill.move.kind === 'moved' ? 0 : bill.move.kind === 'new' ? 1 : 2;
  moved.sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    if (a.move.kind === 'moved' && b.move.kind === 'moved') {
      return Math.abs(b.move.changeBasisPoints) - Math.abs(a.move.changeBasisPoints);
    }
    return a.name.localeCompare(b.name);
  });

  const netWorth: MonthNetWorth | null =
    start === null || end === null || end.date < month
      ? null
      : {
          startDate: start.date,
          endDate: end.date,
          startCents: start.assets - start.debts,
          endCents: end.assets - end.debts,
          otherAssetsChangeCents: end.assets - end.bitcoin - (start.assets - start.bitcoin),
          bitcoinChangeCents: end.bitcoin - start.bitcoin,
          debtsPaidDownCents: start.debts - end.debts,
        };

  return {
    month,
    from,
    before,
    cameInCents: current.cameInCents,
    wentOutCents: current.wentOutCents,
    previous: hasPrevious > 0 ? previous : null,
    lines,
    uncategorizedCents: -(loose._sum.amountCents ?? 0n),
    bills: moved,
    netWorth,
  };
}
