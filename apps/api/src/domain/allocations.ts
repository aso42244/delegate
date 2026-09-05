import { type Cents, splitEvenly, sumCents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';
import { appendEvent, markEventsReversed } from './ledger.js';

/**
 * Categorization: attaching a transaction to one or more delegations.
 *
 * An allocation row is *current state*; the `categorize` events it produces are
 * the history. Re-categorizing therefore replaces the allocation rows and
 * reverses the previous events rather than deleting them — which is why a
 * transaction can be re-categorized freely without corrupting a balance.
 *
 * A transaction with no allocations is inert: it moves no delegation at all.
 * That is what makes a 12-month backfill safe to import before any rules exist.
 */

export interface AllocationInput {
  readonly delegationId: string;
  readonly amountCents: Cents;
}

export interface SetAllocationsResult {
  readonly allocationCount: number;
  readonly reversedEventCount: number;
}

export async function setAllocations(
  db: Db,
  transactionId: string,
  allocations: readonly AllocationInput[],
  options: { readonly actorId?: string | null } = {},
): Promise<SetAllocationsResult> {
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      amountCents: true,
      kind: true,
      archivedAt: true,
      account: { select: { inBudget: true, name: true } },
    },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);
  if (transaction.archivedAt !== null) {
    throw new ValidationError(
      'transaction_archived',
      'This transaction is archived and cannot be categorized',
    );
  }

  // Income increases an asset and allocates to nothing; a confirmed pair is not
  // spending. Allowing allocations on either would double-count real money.
  if (transaction.kind !== 'normal' && allocations.length > 0) {
    throw new ValidationError(
      'allocations_not_allowed_for_kind',
      `A transaction of kind "${transaction.kind}" allocates to nothing`,
      { kind: transaction.kind },
    );
  }

  /*
   * An out-of-budget account's rows allocate to nothing, for the same reason
   * income does — and this one is arithmetic rather than judgement.
   *
   * The identity sums `in_budget` accounts only. Categorizing a row on an
   * account it does not sum moves a delegation while no balance moves with it,
   * so the reading goes wrong by the full amount and stays wrong: measured at
   * exactly −$200.00 on a $200 purchase inside a Roth IRA.
   *
   * What makes this worth refusing rather than warning about is that the money
   * has usually *already* been accounted for. A contribution leaves a current
   * account, and that outflow is the budget's record of it; the arrival in the
   * IRA is the same money seen from outside the budget. Categorizing the
   * arrival counts it twice.
   */
  if (!transaction.account.inBudget && allocations.length > 0) {
    throw new ValidationError(
      'allocations_not_allowed_off_budget',
      `${transaction.account.name} is not in the budget, so its transactions are not categorized. Money moving into it is spending from the account it left.`,
    );
  }

  if (allocations.length > 0) {
    const total = sumCents(allocations.map((allocation) => allocation.amountCents));
    if (total !== transaction.amountCents) {
      throw new ValidationError(
        'allocations_do_not_sum',
        'Allocations must sum to exactly the transaction amount',
        { expectedCents: transaction.amountCents.toString(), actualCents: total.toString() },
      );
    }
    if (allocations.some((allocation) => allocation.amountCents === 0n)) {
      throw new ValidationError('allocation_zero', 'An allocation cannot be for zero');
    }

    const ids = allocations.map((allocation) => allocation.delegationId);
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError(
        'allocation_duplicate_delegation',
        'A transaction cannot be allocated to the same delegation twice; combine the amounts',
      );
    }

    const live = await db.delegation.count({ where: { id: { in: ids }, archivedAt: null } });
    if (live !== new Set(ids).size) {
      throw new ValidationError(
        'allocation_delegation_unavailable',
        'Every delegation in a split must exist and not be archived',
      );
    }
  }

  // Reverse the old effect before writing the new one, so the net movement is
  // always the difference and never a double application.
  const { reversedCount } = await markEventsReversed(db, {
    transactionId,
    eventType: 'categorize',
  });

  // Allocation rows are replaceable current state; the reversed events above are
  // the durable record of what this transaction used to be categorized as.
  await db.transactionAllocation.deleteMany({ where: { transactionId } });

  for (const allocation of allocations) {
    await db.transactionAllocation.create({
      data: {
        transactionId,
        delegationId: allocation.delegationId,
        amountCents: allocation.amountCents,
      },
    });
    await appendEvent(db, {
      delegationId: allocation.delegationId,
      deltaCents: allocation.amountCents,
      eventType: 'categorize',
      transactionId,
      actorId: options.actorId ?? null,
    });
  }

  return { allocationCount: allocations.length, reversedEventCount: reversedCount };
}

/** Assigns the whole transaction to one delegation — the common case. */
export async function categorizeTransaction(
  db: Db,
  transactionId: string,
  delegationId: string,
  options: { readonly actorId?: string | null } = {},
): Promise<SetAllocationsResult> {
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { amountCents: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);

  return setAllocations(
    db,
    transactionId,
    [{ delegationId, amountCents: transaction.amountCents }],
    options,
  );
}

/** Makes a transaction inert again, reversing whatever it had moved. */
export async function clearAllocations(
  db: Db,
  transactionId: string,
): Promise<SetAllocationsResult> {
  return setAllocations(db, transactionId, []);
}

/**
 * Splits a transaction evenly across delegations. The remainder cent goes to the
 * first line, so the shares always sum to exactly the transaction amount — the
 * alternative is an allocation total that is one cent off and rejected.
 */
export async function splitTransactionEvenly(
  db: Db,
  transactionId: string,
  delegationIds: readonly string[],
  options: { readonly actorId?: string | null } = {},
): Promise<SetAllocationsResult> {
  if (delegationIds.length === 0) {
    throw new ValidationError('split_needs_delegations', 'A split needs at least one delegation');
  }
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { amountCents: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);

  const shares = splitEvenly(transaction.amountCents, delegationIds.length);
  const allocations = delegationIds.map((delegationId, index) => ({
    delegationId,
    amountCents: shares[index] ?? 0n,
  }));

  return setAllocations(db, transactionId, allocations, options);
}
