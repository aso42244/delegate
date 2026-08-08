import type { Cents } from '@budget/shared';
import { newUuid } from '../db/ids.js';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';
import { appendEvent } from './ledger.js';

/**
 * Envelope-to-envelope transfers.
 *
 * Two paired `transfer` events that net to zero, so the budget identity is
 * unchanged — which is correct, because no account balance moved. Nothing real
 * left the household; money was re-labelled.
 *
 * This deliberately writes no transaction row. See ADR 004: a transaction needs
 * an account, an envelope transfer has none, and a transaction carrying
 * allocations would move the same delegations a second time. Envelope transfers
 * are surfaced through the "Envelope transfers" filter on the Transactions page
 * and in per-line history, and are excluded from all spending math.
 */

export interface TransferInput {
  readonly fromDelegationId: string;
  readonly toDelegationId: string;
  /** A positive magnitude. Direction comes from the two ids. */
  readonly amountCents: Cents;
  readonly actorId?: string | null;
}

export interface TransferResult {
  readonly transferId: string;
  readonly batchId: string;
  readonly fromBalanceCents: Cents;
  readonly toBalanceCents: Cents;
}

export async function transferBetweenDelegations(
  db: Db,
  input: TransferInput,
): Promise<TransferResult> {
  if (input.amountCents <= 0n) {
    throw new ValidationError(
      'transfer_amount_not_positive',
      'A transfer amount must be greater than zero; swap the two lines to reverse the direction',
    );
  }
  if (input.fromDelegationId === input.toDelegationId) {
    throw new ValidationError(
      'transfer_same_delegation',
      'A transfer needs two different delegations',
    );
  }

  const lines = await db.delegation.findMany({
    where: { id: { in: [input.fromDelegationId, input.toDelegationId] } },
    select: { id: true, archivedAt: true },
  });
  for (const id of [input.fromDelegationId, input.toDelegationId]) {
    if (!lines.some((line) => line.id === id)) throw new NotFoundError('Delegation', id);
  }

  const batchId = newUuid();
  const transfer = await db.delegationTransfer.create({
    data: {
      fromDelegationId: input.fromDelegationId,
      toDelegationId: input.toDelegationId,
      amountCents: input.amountCents,
      batchId,
      actorId: input.actorId ?? null,
    },
    select: { id: true },
  });

  // The source may go negative. That is allowed and intentional — the owner
  // routinely borrows from one envelope knowing he will square it up next cycle.
  const from = await appendEvent(db, {
    delegationId: input.fromDelegationId,
    deltaCents: -input.amountCents,
    eventType: 'transfer',
    batchId,
    delegationTransferId: transfer.id,
    actorId: input.actorId ?? null,
  });
  const to = await appendEvent(db, {
    delegationId: input.toDelegationId,
    deltaCents: input.amountCents,
    eventType: 'transfer',
    batchId,
    delegationTransferId: transfer.id,
    actorId: input.actorId ?? null,
  });

  return {
    transferId: transfer.id,
    batchId,
    fromBalanceCents: from.balanceCents,
    toBalanceCents: to.balanceCents,
  };
}
