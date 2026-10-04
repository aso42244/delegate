import type { Cents, TransactionKind } from '@budget/shared';
import type { Prisma } from '@prisma/client';
import type { Db } from '../db/client.js';
import { applyTransactionToAccountBalance } from './accounts.js';
import { markEventsReversed } from './ledger.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Manual transactions, and the query behind the Transactions page.
 *
 * Imported rows are owned by `sync.ts`; this covers what the owner types in
 * himself and how the journal is read back.
 */

export interface TransactionQuery {
  readonly search?: string | undefined;
  readonly accountId?: string | undefined;
  readonly delegationId?: string | undefined;
  /**
   * Allocated to a delegation in this grouping, or `none` for a delegation in
   * no grouping — the rows behind one bar of Spending by grouping.
   */
  readonly groupingId?: string | undefined;
  readonly kind?: TransactionKind | undefined;
  /** Money in (`in`, above zero) or money out (`out`, below it). */
  readonly sign?: 'in' | 'out' | undefined;
  /** What delivered it: the bank feed, or a person typing it in. */
  readonly source?: 'simplefin' | 'manual' | undefined;
  /**
   * Strictly before this instant. The end of a range that is itself the start
   * of the next — a cycle ends where the next press begins — so `dateTo`'s
   * inclusive bound would count a row on the boundary twice.
   */
  readonly dateBefore?: Date | undefined;
  readonly dateFrom?: Date | undefined;
  readonly dateTo?: Date | undefined;
  readonly uncategorized?: boolean | undefined;
  readonly pending?: boolean | undefined;
  /** Archived rows are hidden unless asked for; they are history, not journal. */
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

export function buildTransactionWhere(query: TransactionQuery): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {};

  if (!query.includeArchived) where.archivedAt = null;
  if (query.accountId) where.accountId = query.accountId;
  if (query.kind) where.kind = query.kind;
  if (query.pending !== undefined) where.pending = query.pending;
  if (query.sign === 'in') where.amountCents = { gt: 0 };
  if (query.sign === 'out') where.amountCents = { lt: 0 };
  if (query.source) where.source = query.source;

  if (query.dateFrom || query.dateTo || query.dateBefore) {
    where.postedAt = {
      ...(query.dateFrom ? { gte: query.dateFrom } : {}),
      ...(query.dateTo ? { lte: query.dateTo } : {}),
      ...(query.dateBefore ? { lt: query.dateBefore } : {}),
    };
  }

  /**
   * "Uncategorized" is the highest-traffic filter on the page: it is the working
   * queue for the backlog. It means **waiting for a decision**, not merely
   * lacking allocations.
   *
   * Income and confirmed transfers allocate to nothing *by design* — income
   * arrives and is distributed by Delegate, and a movement between two owned
   * accounts is not spending. Filtering on allocations alone left both in the
   * queue permanently: every payroll deposit and every confirmed credit card
   * payment, uncloseable, for as long as the budget exists.
   *
   * **An out-of-budget account's rows are the same case**, and were missed when
   * this was written. The identity sums `in_budget` accounts only, so a row on
   * one it does not sum cannot be categorized at all — `setAllocations` refuses
   * it, because moving a delegation while no balance moves with it puts the
   * reading out by the full amount. A Roth IRA's purchases would therefore sit
   * in the queue for ever, uncloseable, exactly as income did: five of them on
   * one afternoon, against an account whose whole point is that the budget does
   * not track it.
   *
   * They stay in the register, which is where somebody goes to see what an
   * account did. It is the *queue* they leave — the list of decisions waiting
   * to be made, none of which is one.
   *
   * Added through `AND` rather than by assigning `kind`, so an explicit kind
   * filter is not silently overwritten. Asking for uncategorized income is a
   * contradiction under this definition and correctly returns nothing.
   */
  if (query.uncategorized === true) {
    where.allocations = { none: {} };
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      { kind: 'normal' },
      { account: { inBudget: true } },
    ];
  }
  if (query.uncategorized === false) where.allocations = { some: {} };

  // A delegation filter means "allocated to this envelope", which for a split
  // transaction is any one of its allocations. A grouping filter is the same
  // one level up, and the two together mean both.
  const allocation = allocationFilter(query);
  if (allocation !== null) where.allocations = { some: allocation };

  if (query.search) {
    const search = query.search.trim();
    if (search !== '') {
      const conditions: Prisma.TransactionWhereInput[] = [
        { description: { contains: search, mode: 'insensitive' } },
        { descriptionRaw: { contains: search, mode: 'insensitive' } },
        { account: { name: { contains: search, mode: 'insensitive' } } },
        // Both, so searching either what is on screen or what the bank calls it
        // finds the row.
        { account: { nickname: { contains: search, mode: 'insensitive' } } },
        {
          allocations: {
            some: { delegation: { name: { contains: search, mode: 'insensitive' } } },
          },
        },
      ];

      // A bare number is searched as an amount too, in cents. Typing "42.10"
      // should find $42.10 whether it was money in or money out.
      const amount = parseSearchAmount(search);
      if (amount !== null) {
        conditions.push({ amountCents: amount }, { amountCents: -amount });
      }

      where.OR = conditions;
    }
  }

  return where;
}

/**
 * Which allocations a delegation or grouping filter selects, or null for none.
 *
 * The same predicate picks the rows and sums their shares, so the total under a
 * filtered register is the sum of exactly the allocations that put each row on
 * it — a split row counts the part that went to this line, never the whole.
 */
export function allocationFilter(
  query: TransactionQuery,
): Prisma.TransactionAllocationWhereInput | null {
  const filter: Prisma.TransactionAllocationWhereInput = {};
  if (query.delegationId) filter.delegationId = query.delegationId;
  if (query.groupingId) {
    filter.delegation = { groupingId: query.groupingId === 'none' ? null : query.groupingId };
  }
  return Object.keys(filter).length === 0 ? null : filter;
}

/** Reads "42.10", "$42.10" or "4210" as a magnitude in cents. Returns null if it is not a number. */
function parseSearchAmount(search: string): Cents | null {
  const match = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(search);
  if (!match) return null;

  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  return whole * 100n + fraction;
}

export const TRANSACTION_LIST_SELECT = {
  id: true,
  accountId: true,
  postedAt: true,
  amountCents: true,
  description: true,
  descriptionRaw: true,
  pending: true,
  kind: true,
  archivedAt: true,
  pairedTransactionId: true,
  // The check this payment settled, if it settled one. The number rather than
  // the id: the register shows a mark, and what a reader wants behind it is
  // "check 1062", not a uuid.
  settledCheck: { select: { checkNumber: true } },
  account: {
    select: { id: true, name: true, nickname: true, type: true, archivedAt: true, inBudget: true },
  },
  allocations: {
    select: {
      id: true,
      amountCents: true,
      delegationId: true,
      // Archived delegations still resolve, so history renders
      // "Grocery (archived)" rather than a dangling id.
      delegation: { select: { id: true, name: true, archivedAt: true, groupingId: true } },
    },
  },
} as const;

export async function listTransactions(
  db: Db,
  query: TransactionQuery = {},
): Promise<{
  transactions: Prisma.TransactionGetPayload<{ select: typeof TRANSACTION_LIST_SELECT }>[];
  total: number;
  /** Every matching row's amount, summed — not just this page's. */
  totalCents: Cents;
  /**
   * Under a delegation or grouping filter, the sum of the allocations that
   * matched — what the figure the register was opened from adds up. Null with
   * no such filter, where a row's whole amount is its share.
   */
  shareCents: Cents | null;
}> {
  const where = buildTransactionWhere(query);
  const take = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const allocation = allocationFilter(query);

  const [transactions, total, sum, share] = await Promise.all([
    db.transaction.findMany({
      where,
      select: TRANSACTION_LIST_SELECT,
      // Newest first, with id as a tiebreaker so paging cannot repeat or skip a
      // row when several share a timestamp — which backfilled rows often do.
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take,
      skip: query.offset ?? 0,
    }),
    db.transaction.count({ where }),
    db.transaction.aggregate({ where, _sum: { amountCents: true } }),
    allocation === null
      ? null
      : db.transactionAllocation.aggregate({
          where: { ...allocation, transaction: where },
          _sum: { amountCents: true },
        }),
  ]);

  return {
    transactions,
    total,
    totalCents: sum._sum.amountCents ?? 0n,
    shareCents: share === null ? null : (share._sum.amountCents ?? 0n),
  };
}

export interface CreateTransactionInput {
  readonly accountId: string;
  readonly amountCents: Cents;
  readonly description: string;
  readonly postedAt: Date;
  readonly kind?: TransactionKind;
}

/**
 * Records a transaction the owner entered by hand.
 *
 * Imported rows do not go through here: a sync stamps the balance the
 * institution reports, which is authoritative.
 *
 * **Whether the stored balance moves depends on the account, not on the row.**
 * On a manual account — cash, a payment app, a wallet — the stored balance is the only
 * balance there is, and the row moves it. On a synced account it must not: that
 * column is the institution's figure and the next sync restamps it, so an
 * increment here survived until the next run and then vanished, which read as
 * the entry silently not working. Those rows are standby rows and are applied
 * where they are read instead — see `standby.ts`.
 */
export async function createManualTransaction(
  db: Db,
  input: CreateTransactionInput,
): Promise<{ id: string }> {
  if (input.description.trim() === '') {
    throw new ValidationError('empty_description', 'A transaction needs a description.');
  }

  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, archivedAt: true, source: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);
  if (account.archivedAt) {
    throw new ConflictError(
      'account_archived',
      'That account is archived, so a new transaction cannot be added to it.',
    );
  }

  const created = await db.transaction.create({
    data: {
      accountId: input.accountId,
      amountCents: input.amountCents,
      description: input.description.trim(),
      descriptionRaw: input.description.trim(),
      postedAt: input.postedAt,
      kind: input.kind ?? 'normal',
      source: 'manual',
      pending: false,
    },
    select: { id: true },
  });

  if (account.source === 'manual') {
    await applyTransactionToAccountBalance(db, input.accountId, input.amountCents, input.postedAt);
  }

  return created;
}

export interface UpdateTransactionInput {
  readonly description?: string | undefined;
  readonly postedAt?: Date | undefined;
  readonly kind?: TransactionKind | undefined;
}

/**
 * Edits the fields that carry no money.
 *
 * The amount is deliberately not editable: changing it would invalidate the
 * allocations that sum to it and the account balance derived from it. Archive
 * the row and enter it again instead.
 */
export async function updateTransaction(
  db: Db,
  id: string,
  input: UpdateTransactionInput,
): Promise<void> {
  const existing = await db.transaction.findUnique({
    where: { id },
    select: { id: true, kind: true, archivedAt: true, _count: { select: { allocations: true } } },
  });
  if (!existing) throw new NotFoundError('Transaction', id);
  if (existing.archivedAt) {
    throw new ConflictError('transaction_archived', 'That transaction is archived.');
  }

  // Income and confirmed transfers allocate to nothing, so re-labelling a
  // categorized row as either would leave allocations that must not exist.
  if (input.kind && input.kind !== 'normal' && existing._count.allocations > 0) {
    throw new ConflictError(
      'kind_change_requires_uncategorized',
      `A transaction of kind "${input.kind}" allocates to nothing. Clear its categorization first.`,
      { kind: input.kind },
    );
  }

  await db.transaction.update({
    where: { id },
    data: {
      ...(input.description === undefined ? {} : { description: input.description.trim() }),
      ...(input.postedAt === undefined ? {} : { postedAt: input.postedAt }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
    },
  });
}

/**
 * Archives a transaction, reversing whatever it moved.
 *
 * Nothing is hard-deleted. The delegation events it caused are reversed rather
 * than removed, so the envelope returns to what it read before — and the account
 * balance is backed out only where we applied it ourselves, which is a manual
 * row on a manual account. An imported row's balance comes from the institution
 * and is left for the next sync to correct; a standby row never wrote the stored
 * balance in the first place, and archiving it simply removes it from the
 * adjustment `standby.ts` computes on read.
 */
export async function archiveTransaction(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const existing = await db.transaction.findUnique({
    where: { id },
    select: {
      id: true,
      accountId: true,
      amountCents: true,
      source: true,
      archivedAt: true,
      account: { select: { source: true } },
    },
  });
  if (!existing) throw new NotFoundError('Transaction', id);
  if (existing.archivedAt) return;

  await markEventsReversed(db, { transactionId: id }, now);
  await db.transactionAllocation.deleteMany({ where: { transactionId: id } });
  await db.transaction.update({ where: { id }, data: { archivedAt: now } });

  if (existing.source === 'manual' && existing.account.source === 'manual') {
    await applyTransactionToAccountBalance(db, existing.accountId, -existing.amountCents, now);
  }
}
