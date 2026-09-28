import type { Db } from '../db/client.js';
import { NotFoundError } from './errors.js';
import { markEventsReversed } from './ledger.js';

/**
 * Pending transaction lifecycle.
 *
 * A pending transaction affects delegations immediately once categorized — the
 * owner wants his envelopes to reflect money that is already gone, not money the
 * bank has finished settling. That makes two outcomes possible on the next sync,
 * and both must be exact:
 *
 *   1. It posted. Carry the categorization onto the posted row and retire the
 *      pending one, without the spend landing twice.
 *   2. It vanished without posting. Back its effect out completely.
 *
 * Neither is expressible against a bare stored balance, which is the reason
 * delegation balances are a ledger.
 */

/** Default window for treating a posted row as the settled form of a pending one. */
export const PENDING_MATCH_WINDOW_DAYS = 5;

export interface PendingMatchCandidate {
  readonly pendingTransactionId: string;
  readonly postedTransactionId: string;
  readonly amountCents: bigint;
  readonly dayGap: number;
}

/**
 * Finds pending rows whose settled counterpart has arrived: same account, exactly
 * the same amount, within the window. Exact amount matching is deliberate —
 * a tip adjusted at settlement produces a different amount, and silently pairing
 * those would corrupt a balance. Those surface as an ordinary uncategorized
 * transaction instead, which is recoverable.
 */
export async function findPostedMatchesForPending(
  db: Db,
  options: {
    readonly windowDays?: number;
    /**
     * Restricts matching to specific pending rows. Sync passes the ones that
     * disappeared from the feed: a row the bank still reports as pending must
     * not be retired just because a same-amount posted row happens to sit
     * nearby.
     */
    readonly pendingTransactionIds?: readonly string[];
  } = {},
): Promise<PendingMatchCandidate[]> {
  const windowDays = options.windowDays ?? PENDING_MATCH_WINDOW_DAYS;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  if (options.pendingTransactionIds?.length === 0) return [];

  const pendingRows = await db.transaction.findMany({
    where: {
      pending: true,
      archivedAt: null,
      ...(options.pendingTransactionIds ? { id: { in: [...options.pendingTransactionIds] } } : {}),
    },
    select: { id: true, accountId: true, amountCents: true, postedAt: true },
    orderBy: { postedAt: 'asc' },
  });
  if (pendingRows.length === 0) return [];

  const matches: PendingMatchCandidate[] = [];
  const claimed = new Set<string>();

  for (const pending of pendingRows) {
    const posted = await db.transaction.findFirst({
      where: {
        id: { notIn: [pending.id, ...claimed] },
        accountId: pending.accountId,
        amountCents: pending.amountCents,
        pending: false,
        archivedAt: null,
        postedAt: {
          gte: new Date(pending.postedAt.getTime() - windowMs),
          lte: new Date(pending.postedAt.getTime() + windowMs),
        },
      },
      select: { id: true, postedAt: true },
      orderBy: { postedAt: 'asc' },
    });
    if (!posted) continue;

    claimed.add(posted.id);
    matches.push({
      pendingTransactionId: pending.id,
      postedTransactionId: posted.id,
      amountCents: pending.amountCents,
      dayGap: Math.round(
        Math.abs(posted.postedAt.getTime() - pending.postedAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
    });
  }

  return matches;
}

/**
 * Moves a pending transaction's categorization onto its posted counterpart.
 *
 * The pending row's events are reversed and the same allocations are re-created
 * against the posted row, so the net effect on every envelope is zero — the spend
 * was already counted while pending and stays counted exactly once. The pending
 * row is archived rather than deleted, so its history remains resolvable.
 */
export async function carryPendingCategorizationToPosted(
  db: Db,
  pendingTransactionId: string,
  postedTransactionId: string,
  options: { readonly actorId?: string | null; readonly now?: Date } = {},
): Promise<{ carriedAllocationCount: number }> {
  const now = options.now ?? new Date();

  const pending = await db.transaction.findUnique({
    where: { id: pendingTransactionId },
    select: {
      id: true,
      allocations: { select: { delegationId: true, amountCents: true } },
    },
  });
  if (!pending) throw new NotFoundError('Transaction', pendingTransactionId);

  const posted = await db.transaction.findUnique({
    where: { id: postedTransactionId },
    select: { id: true, amountCents: true, kind: true },
  });
  if (!posted) throw new NotFoundError('Transaction', postedTransactionId);

  const allocations = pending.allocations.map((allocation) => ({
    delegationId: allocation.delegationId,
    amountCents: allocation.amountCents,
  }));

  // Retire the pending row first: reversing its events and clearing its
  // allocations before re-creating them on the posted row means the envelope is
  // never momentarily double-charged, even if this transaction is retried.
  await markEventsReversed(db, { transactionId: pendingTransactionId }, now);
  await db.transactionAllocation.deleteMany({ where: { transactionId: pendingTransactionId } });
  await db.transaction.update({
    where: { id: pendingTransactionId },
    data: { archivedAt: now, pending: false },
  });

  if (allocations.length > 0) {
    // Imported here to keep the module graph acyclic: allocations.ts does not
    // know about pending handling, only the reverse.
    const { setAllocations } = await import('./allocations.js');
    await setAllocations(db, postedTransactionId, allocations, {
      actorId: options.actorId ?? null,
    });
  }

  return { carriedAllocationCount: allocations.length };
}

/**
 * A pending transaction that disappeared without posting. Reverse every event it
 * caused and archive it — the money never actually left, so the envelope must
 * read exactly what it read before the transaction appeared.
 */
export async function reversePendingTransaction(
  db: Db,
  transactionId: string,
  options: { readonly now?: Date } = {},
): Promise<{ reversedCount: number }> {
  const now = options.now ?? new Date();

  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);

  const { reversedCount } = await markEventsReversed(db, { transactionId }, now);
  await db.transactionAllocation.deleteMany({ where: { transactionId } });
  await db.transaction.update({
    where: { id: transactionId },
    data: { archivedAt: now },
  });

  return { reversedCount };
}
