import type { Cents } from '@budget/shared';
import type { DelegationEventType, Prisma } from '@prisma/client';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';

/**
 * The delegation event ledger.
 *
 * Every function here writes events *and* updates the cached
 * `delegations.balance_cents` inside the caller's transaction. The cache is an
 * optimization; `delegation_events` is the truth. `recomputeAllBalances` rebuilds
 * the cache from events and must always agree with it — there is an integration
 * test asserting exactly that.
 *
 * Nothing in this file mutates or deletes an existing event. Backing something
 * out means stamping `reversed_at`, which is why balances can be derived at any
 * point in time and why Delegate can be undone hours later without disturbing
 * unrelated work.
 */

export interface AppendEventInput {
  readonly delegationId: string;
  readonly deltaCents: Cents;
  readonly eventType: DelegationEventType;
  readonly actorId?: string | null;
  readonly batchId?: string | null;
  readonly transactionId?: string | null;
  readonly delegateRunId?: string | null;
  readonly delegationTransferId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * Appends one event and moves the cached balance by the same delta.
 *
 * The balance update is a relative `increment`, not a read-then-write of an
 * absolute value: two concurrent categorizations of different transactions
 * against the same envelope must both land, and `increment` lets Postgres
 * serialize them on the row lock rather than losing one to a stale read.
 */
export async function appendEvent(
  db: Db,
  input: AppendEventInput,
): Promise<{ eventId: string; balanceCents: Cents }> {
  const delegation = await db.delegation.findUnique({
    where: { id: input.delegationId },
    select: { id: true, archivedAt: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', input.delegationId);

  // Archived lines are resolvable for history but must not accept new movement.
  // Reversal is exempt: it goes through markEventsReversed, not this path.
  if (delegation.archivedAt !== null) {
    throw new ValidationError(
      'delegation_archived',
      'This delegation is archived and cannot take new events',
      { delegationId: input.delegationId },
    );
  }

  const event = await db.delegationEvent.create({
    data: {
      delegationId: input.delegationId,
      deltaCents: input.deltaCents,
      eventType: input.eventType,
      actorId: input.actorId ?? null,
      batchId: input.batchId ?? null,
      transactionId: input.transactionId ?? null,
      delegateRunId: input.delegateRunId ?? null,
      delegationTransferId: input.delegationTransferId ?? null,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
    select: { id: true },
  });

  const updated = await db.delegation.update({
    where: { id: input.delegationId },
    data: { balanceCents: { increment: input.deltaCents } },
    select: { balanceCents: true },
  });

  return { eventId: event.id, balanceCents: updated.balanceCents };
}

/** Appends many events in one pass. Used by Delegate, Reconcile and splits. */
export async function appendEvents(db: Db, inputs: readonly AppendEventInput[]): Promise<string[]> {
  const ids: string[] = [];
  for (const input of inputs) {
    const { eventId } = await appendEvent(db, input);
    ids.push(eventId);
  }
  return ids;
}

/**
 * Reverses events by stamping `reversed_at` and applying the opposite delta to
 * the cache. Already-reversed events are skipped, which makes reversal
 * idempotent — a retried sync that reverses the same vanished pending
 * transaction twice must not double-credit the envelope.
 */
export async function markEventsReversed(
  db: Db,
  where: Prisma.DelegationEventWhereInput,
  reversedAt: Date = new Date(),
): Promise<{ reversedCount: number }> {
  const events = await db.delegationEvent.findMany({
    where: { ...where, reversedAt: null },
    select: { id: true, delegationId: true, deltaCents: true },
  });
  if (events.length === 0) return { reversedCount: 0 };

  await db.delegationEvent.updateMany({
    where: { id: { in: events.map((event) => event.id) } },
    data: { reversedAt },
  });

  // Collapse to one update per delegation: a Delegate batch touches ~60 lines
  // and an undo should not issue 60 separate round trips per line.
  const deltaByDelegation = new Map<string, Cents>();
  for (const event of events) {
    deltaByDelegation.set(
      event.delegationId,
      (deltaByDelegation.get(event.delegationId) ?? 0n) - event.deltaCents,
    );
  }
  for (const [delegationId, delta] of deltaByDelegation) {
    await db.delegation.update({
      where: { id: delegationId },
      data: { balanceCents: { increment: delta } },
    });
  }

  return { reversedCount: events.length };
}

/** The authoritative balance for one line, computed from events. */
export async function computeBalanceFromEvents(db: Db, delegationId: string): Promise<Cents> {
  const result = await db.delegationEvent.aggregate({
    where: { delegationId, reversedAt: null },
    _sum: { deltaCents: true },
  });
  return result._sum.deltaCents ?? 0n;
}

export interface RecomputeResult {
  readonly checked: number;
  readonly corrected: number;
  readonly corrections: ReadonlyArray<{
    readonly delegationId: string;
    readonly name: string;
    readonly cachedCents: Cents;
    readonly actualCents: Cents;
  }>;
}

/**
 * Rebuilds every cached balance from the event stream. Exposed as the
 * `recompute-balances` CLI command.
 *
 * Archived delegations are included: their cache should still be correct, and a
 * silent discrepancy on an archived line would resurface if it were restored.
 */
export async function recomputeAllBalances(db: Db): Promise<RecomputeResult> {
  const delegations = await db.delegation.findMany({
    select: { id: true, name: true, balanceCents: true },
    orderBy: { name: 'asc' },
  });

  const sums = await db.delegationEvent.groupBy({
    by: ['delegationId'],
    where: { reversedAt: null },
    _sum: { deltaCents: true },
  });
  const actualById = new Map(sums.map((row) => [row.delegationId, row._sum.deltaCents ?? 0n]));

  const corrections: Array<{
    delegationId: string;
    name: string;
    cachedCents: Cents;
    actualCents: Cents;
  }> = [];

  for (const delegation of delegations) {
    const actualCents = actualById.get(delegation.id) ?? 0n;
    if (actualCents === delegation.balanceCents) continue;

    corrections.push({
      delegationId: delegation.id,
      name: delegation.name,
      cachedCents: delegation.balanceCents,
      actualCents,
    });
    await db.delegation.update({
      where: { id: delegation.id },
      data: { balanceCents: actualCents },
    });
  }

  return { checked: delegations.length, corrected: corrections.length, corrections };
}
