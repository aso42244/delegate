import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';
import { computeBudgetIdentity } from './identity.js';
import { appendEvent } from './ledger.js';

/**
 * Manual adjustment.
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

/**
 * Moving the budget's difference into or out of one line.
 *
 * The reading at the top of the Budget page is money that has landed and not
 * been handed to an envelope (positive), or envelopes holding more than exists
 * (negative). Closing it meant reading the figure, opening the row menu,
 * choosing Manually adjust, and typing the number in by hand — arithmetic the
 * page had already done.
 *
 * This is that same manual adjustment with the amount computed rather than
 * typed. Deliberately the same `adjust` event: it is one, and inventing a
 * second kind would split the history of a line between two words for the same
 * act.
 *
 * **The difference is recomputed here rather than trusted from the caller.**
 * "All of it" has to mean all of it at the moment it is applied — an hourly
 * sync between the page rendering and the button being pressed would otherwise
 * move a figure the client had already decided.
 */
export type AbsorbMode = 'all' | 'zero_line' | 'custom';

export interface AbsorbInput {
  readonly delegationId: string;
  readonly mode: AbsorbMode;
  /** Required for `custom`, ignored otherwise. A positive magnitude. */
  readonly amountCents?: Cents | undefined;
  readonly actorId?: string | null;
}

export interface AbsorbResult {
  readonly deltaCents: Cents;
  readonly balanceCents: Cents;
  readonly differenceCents: Cents;
}

export async function absorbDifference(db: Db, input: AbsorbInput): Promise<AbsorbResult> {
  const identity = await computeBudgetIdentity(db);
  const difference = identity.differenceCents;

  if (difference === 0n) {
    throw new ValidationError('nothing_to_move', 'The budget is already balanced to the cent.');
  }

  const delegation = await db.delegation.findUnique({
    where: { id: input.delegationId },
    select: { id: true, name: true, kind: true, balanceCents: true, archivedAt: true },
  });
  if (!delegation || delegation.archivedAt) {
    throw new NotFoundError('Delegation', input.delegationId);
  }

  /*
   * An outstanding check is not an envelope to move money into. It holds a
   * specific sum written on a specific cheque, and it is settled by matching
   * the payment that cashes it — adjusting one would make the two disagree.
   */
  if (delegation.kind === 'check') {
    throw new ValidationError(
      'check_not_adjustable',
      'An outstanding check is settled by matching the payment that cashes it, not by moving money into it.',
    );
  }

  const balance = delegation.balanceCents;
  const deltaCents =
    difference > 0n
      ? surplusDelta(difference, balance, input)
      : deficitDelta(-difference, balance, input);

  await adjustDelegationByDelta(db, {
    delegationId: delegation.id,
    deltaCents,
    actorId: input.actorId ?? null,
  });

  return {
    deltaCents,
    balanceCents: balance + deltaCents,
    differenceCents: (await computeBudgetIdentity(db)).differenceCents,
  };
}

/** Money going into the line. */
function surplusDelta(surplus: Cents, balance: Cents, input: AbsorbInput): Cents {
  switch (input.mode) {
    case 'all':
      return surplus;

    case 'zero_line': {
      if (balance >= 0n) {
        throw new ValidationError(
          'line_not_over_spent',
          'That line is not over-spent, so there is nothing to bring back to zero.',
        );
      }
      if (surplus < -balance) {
        throw new ValidationError(
          'surplus_too_small',
          'There is not enough to delegate to bring that line back to zero.',
        );
      }
      return -balance;
    }

    case 'custom': {
      const amount = requireAmount(input.amountCents);
      if (amount > surplus) {
        throw new ValidationError(
          'more_than_available',
          'That is more than there is to delegate. Use Manually adjust to over-delegate on purpose.',
        );
      }
      return amount;
    }
  }
}

/** Money coming out of the line. */
function deficitDelta(shortfall: Cents, balance: Cents, input: AbsorbInput): Cents {
  switch (input.mode) {
    case 'all': {
      if (balance < shortfall) {
        throw new ValidationError(
          'line_too_small',
          'That line does not hold enough to cover the whole shortfall.',
        );
      }
      return -shortfall;
    }

    case 'zero_line': {
      if (balance <= 0n) {
        throw new ValidationError(
          'line_empty',
          'That line holds nothing to put against the shortfall.',
        );
      }
      if (balance >= shortfall) {
        throw new ValidationError(
          'line_covers_it',
          'That line can cover the whole shortfall, so emptying it would overshoot.',
        );
      }
      return -balance;
    }

    case 'custom': {
      const amount = requireAmount(input.amountCents);
      if (amount > shortfall) {
        throw new ValidationError(
          'more_than_needed',
          'That is more than the shortfall. Use Manually adjust to move more than is needed.',
        );
      }
      return -amount;
    }
  }
}

function requireAmount(amountCents: Cents | undefined): Cents {
  if (amountCents === undefined || amountCents <= 0n) {
    throw new ValidationError('amount_required', 'Enter an amount greater than zero.');
  }
  return amountCents;
}
