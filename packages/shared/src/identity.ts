/**
 * The budget identity.
 *
 *   SUM(in-budget assets)
 *     − SUM(in-budget debts)
 *     − SUM(delegation balances)
 *     + SUM(categorized pending transactions)
 *
 * This is a point-in-time calculation and a health indicator, not an invariant
 * enforced by double-entry bookkeeping. A positive result is money that has
 * landed in an account but has not yet been handed to an envelope — which is
 * exactly the "available to delegate" figure, so income needs no special
 * machinery anywhere in the system.
 *
 * Debt balances are stored as positive magnitudes (a $500 card balance is
 * 50000, not -50000) and subtracted here. See docs/architecture.md.
 *
 * The pending term exists because the two sides of a pending charge move at
 * different times. Categorizing it takes the money out of its envelope at once —
 * deliberately, because the money is gone — while the account balance is the
 * institution's *settled* balance and will not include it for another day or
 * three. Without this term the first three lines are simply out of step by the
 * amount of the charge, and the page reports money to delegate that has already
 * been spent. See ADR 020.
 */

import { type Cents, ZERO_CENTS, absCents, formatCents } from './money.js';

export const DEFAULT_IDENTITY_TOLERANCE_CENTS: Cents = 500n; // $5.00

export type IdentityStatus = 'to_delegate' | 'balanced' | 'over_delegated';

export interface IdentityInput {
  readonly assetsCents: Cents;
  readonly debtsCents: Cents;
  readonly delegationsCents: Cents;
  /**
   * Signed sum of categorized pending transactions: negative for a spend, which
   * is the ordinary case. Defaults to zero so every existing caller is unchanged.
   */
  readonly pendingCents?: Cents;
  /** Difference within ±tolerance reads as "Balanced". Configurable in Settings. */
  readonly toleranceCents?: Cents;
}

export interface IdentityResult {
  readonly assetsCents: Cents;
  readonly debtsCents: Cents;
  readonly delegationsCents: Cents;
  readonly pendingCents: Cents;
  readonly differenceCents: Cents;
  readonly toleranceCents: Cents;
  readonly status: IdentityStatus;
}

export function computeIdentity(input: IdentityInput): IdentityResult {
  const {
    assetsCents,
    debtsCents,
    delegationsCents,
    pendingCents = ZERO_CENTS,
    toleranceCents = DEFAULT_IDENTITY_TOLERANCE_CENTS,
  } = input;

  // Added, not subtracted: a pending spend is already negative. The account
  // balance is short by exactly this, so adding it back puts the first three
  // terms on the same footing as each other.
  const differenceCents = assetsCents - debtsCents - delegationsCents + pendingCents;

  return {
    assetsCents,
    debtsCents,
    delegationsCents,
    pendingCents,
    differenceCents,
    toleranceCents,
    status: classifyIdentity(differenceCents, toleranceCents),
  };
}

export function classifyIdentity(differenceCents: Cents, toleranceCents: Cents): IdentityStatus {
  if (absCents(differenceCents) <= absCents(toleranceCents)) return 'balanced';
  return differenceCents > ZERO_CENTS ? 'to_delegate' : 'over_delegated';
}

/** The label rendered on the bottom row of the Budget page. */
export function formatIdentityLabel(result: IdentityResult): string {
  switch (result.status) {
    case 'balanced':
      return 'Balanced';
    case 'to_delegate':
      return `${formatCents(result.differenceCents)} to delegate`;
    case 'over_delegated':
      return `${formatCents(absCents(result.differenceCents))} over-delegated`;
  }
}
