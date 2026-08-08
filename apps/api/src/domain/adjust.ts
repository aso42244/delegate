import type { Cents } from '@budget/shared';
import { newUuid } from '../db/ids.js';
import type { Db } from '../db/client.js';
import { NotFoundError } from './errors.js';
import { appendEvent } from './ledger.js';

/**
 * Manual adjustment, and the go-live Reconcile screen.
 *
 * An adjustment records a *delta*, never an absolute. Editing Grocery from $650
 * to $675 writes an `adjust` event of +$25. Storing the absolute would destroy
 * the property the ledger exists for: that any single effect can be backed out
 * without disturbing the others.
 *
 * `adjust` events never appear on the Transactions page and are excluded from all
 * spending math — the journal is for categorization, not auditing. They are
 * visible only in per-line history.
 */

export interface AdjustToTargetInput {
  readonly delegationId: string;
  /** The balance the owner wants the line to read. */
  readonly targetBalanceCents: Cents;
  readonly actorId?: string | null;
  readonly batchId?: string | null;
}

/**
 * Adjusts a line to a target balance by writing the difference as a delta.
 * Returns null when the line already reads the target — a zero-delta event would
 * add a history entry that says nothing happened.
 */
export async function adjustDelegationToTarget(
  db: Db,
  input: AdjustToTargetInput,
): Promise<{ eventId: string; deltaCents: Cents; balanceCents: Cents } | null> {
  const delegation = await db.delegation.findUnique({
    where: { id: input.delegationId },
    select: { id: true, balanceCents: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', input.delegationId);

  const deltaCents = input.targetBalanceCents - delegation.balanceCents;
  if (deltaCents === 0n) return null;

  const { eventId, balanceCents } = await appendEvent(db, {
    delegationId: input.delegationId,
    deltaCents,
    eventType: 'adjust',
    actorId: input.actorId ?? null,
    batchId: input.batchId ?? null,
  });

  return { eventId, deltaCents, balanceCents };
}

/** Applies a known delta directly, for "add $25 to this line". */
export async function adjustDelegationByDelta(
  db: Db,
  input: {
    readonly delegationId: string;
    readonly deltaCents: Cents;
    readonly actorId?: string | null;
    readonly batchId?: string | null;
  },
): Promise<{ eventId: string; balanceCents: Cents } | null> {
  if (input.deltaCents === 0n) return null;
  return appendEvent(db, {
    delegationId: input.delegationId,
    deltaCents: input.deltaCents,
    eventType: 'adjust',
    actorId: input.actorId ?? null,
    batchId: input.batchId ?? null,
  });
}

export interface ReconcileLine {
  readonly delegationId: string;
  readonly actualBalanceCents: Cents;
}

export interface ReconcileResult {
  readonly batchId: string;
  readonly adjustedCount: number;
  readonly unchangedCount: number;
  readonly totalDeltaCents: Cents;
}

/**
 * Go-live reconciliation: sixty corrections as one screen and one commit.
 *
 * At go-live the owner has backfilled and categorized twelve months of history,
 * which drives balances deeply negative — Grocery may read −$9,000 when its true
 * balance is $725. That is deliberate: it buys full history and accurate day-one
 * numbers. This writes every correction as an `adjust` delta in a single batch,
 * so the whole reconciliation is one identifiable event group in history.
 *
 * Must be called inside a transaction. Half a reconciliation is worse than none.
 */
export async function reconcileToActual(
  db: Db,
  lines: readonly ReconcileLine[],
  options: { readonly actorId?: string | null; readonly goLiveAt?: Date } = {},
): Promise<ReconcileResult> {
  const batchId = newUuid();
  let adjustedCount = 0;
  let totalDeltaCents: Cents = 0n;

  for (const line of lines) {
    const result = await adjustDelegationToTarget(db, {
      delegationId: line.delegationId,
      targetBalanceCents: line.actualBalanceCents,
      actorId: options.actorId ?? null,
      batchId,
    });
    if (result) {
      adjustedCount += 1;
      totalDeltaCents += result.deltaCents;
    }
  }

  // Stamping go-live lets later views distinguish backfilled history from live
  // activity without inspecting individual events.
  if (options.goLiveAt) {
    await db.budgetSettings.update({
      where: { id: 1 },
      data: { goLiveAt: options.goLiveAt },
    });
  }

  return {
    batchId,
    adjustedCount,
    unchangedCount: lines.length - adjustedCount,
    totalDeltaCents,
  };
}
