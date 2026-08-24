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
  readonly kind?: TransactionKind | undefined;
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

  if (query.dateFrom || query.dateTo) {
    where.postedAt = {
      ...(query.dateFrom ? { gte: query.dateFrom } : {}),
      ...(query.dateTo ? { lte: query.dateTo } : {}),
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
   * Added through `AND` rather than by assigning `kind`, so an explicit kind
   * filter is not silently overwritten. Asking for uncategorized income is a
   * contradiction under this definition and correctly returns nothing.
   */
  if (query.uncategorized === true) {
    where.allocations = { none: {} };
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { kind: 'normal' }];
  }
  if (query.uncategorized === false) where.allocations = { some: {} };

  // A delegation filter means "allocated to this envelope", which for a split
  // transaction is any one of its allocations.
  if (query.delegationId) where.allocations = { some: { delegationId: query.delegationId } };

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
  account: { select: { id: true, name: true, nickname: true, type: true, archivedAt: true } },
  allocations: {
    select: {
      id: true,
      amountCents: true,
      delegationId: true,
      // Archived delegations still resolve, so history renders
      // "Grocery (archived)" rather than a dangling id.
      delegation: { select: { id: true, name: true, archivedAt: true } },
    },
  },
} as const;

export async function listTransactions(
  db: Db,
  query: TransactionQuery = {},
): Promise<{
  transactions: Prisma.TransactionGetPayload<{ select: typeof TRANSACTION_LIST_SELECT }>[];
  total: number;
}> {
  const where = buildTransactionWhere(query);
  const take = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const [transactions, total] = await Promise.all([
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
  ]);

  return { transactions, total };
}

export interface CreateTransactionInput {
  readonly accountId: string;
  readonly amountCents: Cents;
  readonly description: string;
  readonly postedAt: Date;
  readonly kind?: TransactionKind;
}

/**
 * Records a transaction the owner entered by hand, and moves the account
 * balance to match.
 *
 * Imported rows do not go through here: a sync stamps the balance the
 * institution reports, which is authoritative. A manual row has no such source,
 * so the balance is adjusted by the amount entered.
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
    select: { id: true, archivedAt: true },
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

  await applyTransactionToAccountBalance(db, input.accountId, input.amountCents, input.postedAt);

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
 * balance is backed out for a manual row, whose balance effect we applied
 * ourselves. An imported row's balance comes from the institution, so it is left
 * for the next sync to correct.
 */
export async function archiveTransaction(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const existing = await db.transaction.findUnique({
    where: { id },
    select: { id: true, accountId: true, amountCents: true, source: true, archivedAt: true },
  });
  if (!existing) throw new NotFoundError('Transaction', id);
  if (existing.archivedAt) return;

  await markEventsReversed(db, { transactionId: id }, now);
  await db.transactionAllocation.deleteMany({ where: { transactionId: id } });
  await db.transaction.update({ where: { id }, data: { archivedAt: now } });

  if (existing.source === 'manual') {
    await applyTransactionToAccountBalance(db, existing.accountId, -existing.amountCents, now);
  }
}
