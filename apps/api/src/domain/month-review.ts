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
  /** Null for a line in no grouping. */
  readonly groupingId: string | null;
  /** What the line held when the month began. */
  readonly startCents: Cents;
  /** What Delegate presses put into the line during the month. */
  readonly delegatedCents: Cents;
  /** Transfers in and out, and adjustments, net: money moved rather than given. */
  readonly movedCents: Cents;
  /** Ordinary spending filed to it in the month, net of refunds. A magnitude. */
  readonly spentCents: Cents;
  /**
   * What it held when the month ended: start, plus what it was given and moved
   * in, less what it spent. Negative is a line that ran out.
   */
  readonly endCents: Cents;
}

/** A grouping of lines, in the budget's own order, with its lines' totals. */
export interface MonthGrouping {
  /** Null is the lines in no grouping. */
  readonly id: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly startCents: Cents;
  readonly delegatedCents: Cents;
  readonly movedCents: Cents;
  readonly spentCents: Cents;
  readonly endCents: Cents;
  readonly lines: readonly MonthLine[];
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
  /** Every line, by grouping, in the budget's order. */
  readonly groupings: readonly MonthGrouping[];
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

  const [
    current,
    previous,
    hasPrevious,
    [eventsBefore, eventsInMonth],
    [allocations, allocationsBefore],
    loose,
    bills,
    start,
    end,
  ] = await Promise.all([
    flow(db, from, before),
    flow(db, previousFrom, from),
    db.transaction.count({
      where: { archivedAt: null, postedAt: { gte: previousFrom, lt: from } },
    }),
    /*
     * Every ledger movement that is not spending, by line and type: before
     * the month, for where it started, and inside it, split into what Delegate
     * gave and what was moved or corrected.
     *
     * Spending is read from the allocations instead, dated by when the charge
     * posted rather than when it was filed — the same date the Spent figure
     * and its register link use. A live `categorize` event is exactly one
     * allocation (`setAllocations` reverses the old events as it replaces the
     * rows), so the two together are the line's balance at any date.
     */
    Promise.all([
      db.delegationEvent.groupBy({
        by: ['delegationId'],
        where: { eventType: { not: 'categorize' }, reversedAt: null, occurredAt: { lt: from } },
        _sum: { deltaCents: true },
      }),
      db.delegationEvent.groupBy({
        by: ['delegationId', 'eventType'],
        where: {
          eventType: { not: 'categorize' },
          reversedAt: null,
          occurredAt: { gte: from, lt: before },
        },
        _sum: { deltaCents: true },
      }),
    ]),
    Promise.all([
      db.transactionAllocation.groupBy({
        by: ['delegationId'],
        where: {
          transaction: { archivedAt: null, kind: 'normal', postedAt: { gte: from, lt: before } },
        },
        _sum: { amountCents: true },
      }),
      db.transactionAllocation.groupBy({
        by: ['delegationId'],
        where: { transaction: { archivedAt: null, kind: 'normal', postedAt: { lt: from } } },
        _sum: { amountCents: true },
      }),
    ]),
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

  const add = (map: Map<string, Cents>, id: string, cents: Cents): void => {
    map.set(id, (map.get(id) ?? 0n) + cents);
  };
  const startById = new Map<string, Cents>();
  const delegatedById = new Map<string, Cents>();
  const movedById = new Map<string, Cents>();
  const spentById = new Map<string, Cents>();

  for (const row of eventsBefore) add(startById, row.delegationId, row._sum.deltaCents ?? 0n);
  for (const row of allocationsBefore) {
    add(startById, row.delegationId, row._sum.amountCents ?? 0n);
  }
  // Inside the month: what Delegate gave, and what was moved or corrected.
  for (const row of eventsInMonth) {
    add(
      row.eventType === 'delegate' ? delegatedById : movedById,
      row.delegationId,
      row._sum.deltaCents ?? 0n,
    );
  }
  for (const row of allocations) add(spentById, row.delegationId, -(row._sum.amountCents ?? 0n));

  const ids = new Set<string>([
    ...startById.keys(),
    ...spentById.keys(),
    ...delegatedById.keys(),
    ...movedById.keys(),
  ]);
  const delegations = await db.delegation.findMany({
    // Every line that held or moved money, archived and checks included: the
    // lines have to add up to Went out with the uncategorized row, and a cashed
    // check is spending like any other.
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      name: true,
      archivedAt: true,
      position: true,
      grouping: { select: { id: true, name: true, color: true, position: true } },
    },
  });

  const lines: (MonthLine & {
    readonly position: number;
    readonly groupingName: string | null;
    readonly groupingPosition: number;
  })[] = delegations
    .map((delegation) => {
      const startCents = startById.get(delegation.id) ?? 0n;
      const delegatedCents = delegatedById.get(delegation.id) ?? 0n;
      const movedCents = movedById.get(delegation.id) ?? 0n;
      const spentCents = spentById.get(delegation.id) ?? 0n;
      return {
        delegationId: delegation.id,
        name: delegation.name,
        color: delegation.grouping?.color ?? null,
        archived: delegation.archivedAt !== null,
        groupingId: delegation.grouping?.id ?? null,
        groupingName: delegation.grouping?.name ?? null,
        groupingPosition: delegation.grouping?.position ?? Number.MAX_SAFE_INTEGER,
        position: delegation.position,
        startCents,
        delegatedCents,
        movedCents,
        spentCents,
        endCents: startCents + delegatedCents + movedCents - spentCents,
      };
    })
    // A line with nothing in it and nothing through it is not part of the month.
    .filter(
      (line) =>
        line.startCents !== 0n ||
        line.delegatedCents !== 0n ||
        line.movedCents !== 0n ||
        line.spentCents !== 0n,
    )
    // The budget's own order: grouping, then the line's place in it, then name.
    .sort(
      (a, b) =>
        a.groupingPosition - b.groupingPosition ||
        (a.groupingName ?? '').localeCompare(b.groupingName ?? '') ||
        a.position - b.position ||
        a.name.localeCompare(b.name),
    );

  const groupings: MonthGrouping[] = [];
  for (const line of lines) {
    let grouping = groupings[groupings.length - 1];
    if (grouping === undefined || grouping.id !== line.groupingId) {
      grouping = {
        id: line.groupingId,
        name: line.groupingName ?? 'No grouping',
        color: line.color,
        startCents: 0n,
        delegatedCents: 0n,
        movedCents: 0n,
        spentCents: 0n,
        endCents: 0n,
        lines: [],
      };
      groupings.push(grouping);
    }
    const {
      position: _position,
      groupingName: _name,
      groupingPosition: _groupingPosition,
      ...plain
    } = line;
    groupings[groupings.length - 1] = {
      ...grouping,
      startCents: grouping.startCents + line.startCents,
      delegatedCents: grouping.delegatedCents + line.delegatedCents,
      movedCents: grouping.movedCents + line.movedCents,
      spentCents: grouping.spentCents + line.spentCents,
      endCents: grouping.endCents + line.endCents,
      lines: [...grouping.lines, plain],
    };
  }

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
    groupings,
    uncategorizedCents: -(loose._sum.amountCents ?? 0n),
    bills: moved,
    netWorth,
  };
}
