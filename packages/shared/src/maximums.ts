import type { Cents } from './money.js';

/**
 * The most a line is allowed to hold, and what that does to the next press.
 *
 * A target says what a line is saving towards and never writes anything — ADR
 * 047, and the whole of that decision is that the amount to delegate stays the
 * household's. A **maximum** is the other half of the same sentence, and it is
 * the half that does write: a line capped at $400, set to receive $200 and
 * already holding $275, takes $125 on the next press rather than $200.
 *
 * The $75 is not moved anywhere and no second line receives it. It simply stays
 * undelegated, which is the figure at the top of the page — `To delegate
 * $75.00` — and therefore available for whatever that payday actually needs.
 * That is the point of the feature: a line that is full stops taking money, and
 * the money it stops taking is offered back rather than hidden.
 *
 * **It caps the balance, not the amount.** What the household typed stays
 * exactly what they typed, on the row and in the database, and what a press
 * moves is whatever of it still fits. So a maximum needs no undoing when the
 * line is spent down: the next press puts the full amount in again by itself.
 *
 * **Only Delegate is capped.** A transfer, a refund or a manual adjustment may
 * take a line past its maximum and none of them is refused. Those are not
 * distributions, and a cap that silently rejected a refund would be losing
 * money to enforce a preference.
 *
 * Shared rather than living in the API for the reason the target arithmetic is:
 * the dialog that sets a maximum shows what the next press would do, live,
 * before anything is saved. Two copies of that would be two answers.
 */

export interface MaximumInput {
  readonly balanceCents: Cents;
  /** Null is not zero: an ad-hoc line, which receives nothing either way. */
  readonly amountToDelegateCents: Cents | null;
  readonly maxBalanceCents: Cents | null;
}

/**
 * What a maximum is doing to the next press.
 *
 * `room` is a maximum that is not in the way — the whole amount still fits.
 * `partial` is the case the feature exists for, where some of it fits. `full`
 * is a line that will receive nothing at all.
 */
export type MaximumStatus = 'room' | 'partial' | 'full';

export interface MaximumProgress {
  readonly maxBalanceCents: Cents;
  /** What still fits before the maximum. Zero once the line is at or over it. */
  readonly roomCents: Cents;
  /** What the next press would actually move in. */
  readonly delegatingCents: Cents;
  /** What the maximum holds back on that press. Zero when it is not in the way. */
  readonly withheldCents: Cents;
  readonly status: MaximumStatus;
}

/**
 * What a press actually moves into one line.
 *
 * The single answer both the run and every reading of it go through, so a
 * dialog cannot promise a figure the ledger then disagrees with.
 *
 * A null amount is an ad-hoc line and moves nothing, maximum or not. A negative
 * one takes money **out**, which a maximum has nothing to say about: a cap is
 * about not putting too much in, and refusing a withdrawal because the line is
 * already full would be the opposite of what it says.
 */
export function amountThatFits(row: MaximumInput): Cents {
  const amount = row.amountToDelegateCents ?? 0n;
  if (row.maxBalanceCents === null || amount <= 0n) return amount;

  const room = row.maxBalanceCents - row.balanceCents;
  if (room <= 0n) return 0n;
  return room < amount ? room : amount;
}

/** The reading for one line, or null where there is no maximum — nearly every row. */
export function maximumProgress(row: MaximumInput): MaximumProgress | null {
  if (row.maxBalanceCents === null || row.maxBalanceCents <= 0n) return null;

  const amount = row.amountToDelegateCents ?? 0n;
  const delegating = amountThatFits(row);
  const withheld = amount - delegating;

  // Negative room is a line already past its maximum — by a transfer, a refund
  // or an adjustment, none of which this refuses. It has no room, and saying so
  // as a negative number would invite somebody to add it up with something.
  const room = row.maxBalanceCents - row.balanceCents;

  return {
    maxBalanceCents: row.maxBalanceCents,
    roomCents: room > 0n ? room : 0n,
    delegatingCents: delegating,
    withheldCents: withheld,
    status: withheld <= 0n ? 'room' : delegating <= 0n ? 'full' : 'partial',
  };
}
