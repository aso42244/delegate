import { CYCLES_PER_YEAR } from './domain.js';
import type { PayCadence } from './domain.js';
import type { Cents } from './money.js';

/**
 * What a line is saving towards, and whether it will get there.
 *
 * The owner has been writing `"$2200, Dec 27"` into a delegation's notes and
 * doing the per-paycheck arithmetic in his head — the freeform column was left
 * that way on the understanding that structured fields would come later, and
 * this is the arithmetic those fields make possible.
 *
 * It answers one question, in the terms the household already uses: **is what
 * this line is set to delegate enough to make its date?** That is a comparison
 * between two numbers already on the Budget row — the amount to delegate, and
 * what the target needs per paycheck — which is why the answer belongs on that
 * row rather than on a page of its own.
 *
 * **Nothing here writes, and a target never moves an amount to delegate.** What
 * the household delegates each cycle is theirs to set and stays exactly what
 * they typed; a target only works out what that amount would have to be, and
 * says so when the two disagree. The dialog that sets one offers to apply the
 * figure in a single press, which is a decision somebody makes rather than one
 * this arithmetic makes for them — the same line the Utilities page draws
 * between a suggestion and a decision to fund.
 *
 * Shared rather than living in the API because the dialog that sets a target
 * has to show the same reading live, before anything is saved. Two copies of
 * this arithmetic would be two answers waiting to disagree — one on the row and
 * one in the box where somebody is deciding what to type.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a target is doing.
 *
 * `standing` is a target with no date — "keep $500 in this envelope" — which has
 * a shortfall but no schedule, so there is no per-paycheck figure to compare
 * anything against. It is deliberately not called `behind`: a line below a
 * standing target is not late, because nothing was due.
 */
export type TargetStatus = 'met' | 'on_track' | 'behind' | 'standing';

export interface TargetProgress {
  readonly targetCents: Cents;
  /** Null for a standing target. A date key: a decided day, needing no zone. */
  readonly targetDate: Date | null;
  /** What is still to be put in. Zero once the target is met. */
  readonly shortfallCents: Cents;
  /** Null without a date. Never zero — the last cycle to save in is still one. */
  readonly cyclesRemaining: number | null;
  /** What each remaining paycheck has to carry. Null without a date. */
  readonly neededPerCycleCents: Cents | null;
  readonly status: TargetStatus;
}

export interface TargetInput {
  readonly balanceCents: Cents;
  readonly amountToDelegateCents: Cents | null;
  readonly targetCents: Cents | null;
  readonly targetDate: Date | null;
}

/**
 * How many paychecks are left before the date.
 *
 * Floored, and never below one while the date is still ahead: a half cycle is
 * not a paycheck, and rounding one up would report a per-cycle figure that no
 * actual payday delivers. The bound at one is what makes the last stretch read
 * correctly — with four days to go there is one more chance to fund it, and the
 * needed figure should be the whole shortfall rather than a fraction of it.
 *
 * Zero once the date has passed, which is a different thing again and handled by
 * the caller: nothing is remaining, and the shortfall is due now.
 */
export function cyclesUntil(targetDate: Date, today: Date, cadence: PayCadence): number {
  const days = Math.floor((targetDate.getTime() - today.getTime()) / DAY_MS);
  if (days <= 0) return 0;

  const daysPerCycle = 365 / CYCLES_PER_YEAR[cadence];
  return Math.max(1, Math.floor(days / daysPerCycle));
}

/**
 * The reading for one line, or null where there is no target.
 *
 * `today` is a **date key** — the household's day, already decided by the caller
 * — and `targetDate` is one too, so this is plain calendar arithmetic and needs
 * no zone. ADR 037: if you are passing a zone to this function you have the
 * distinction backwards.
 */
export function targetProgress(
  row: TargetInput,
  cadence: PayCadence,
  today: Date,
): TargetProgress | null {
  if (row.targetCents === null || row.targetCents <= 0n) return null;

  const shortfall = row.targetCents - row.balanceCents;

  if (shortfall <= 0n) {
    return {
      targetCents: row.targetCents,
      targetDate: row.targetDate,
      shortfallCents: 0n,
      cyclesRemaining: null,
      neededPerCycleCents: null,
      status: 'met',
    };
  }

  if (row.targetDate === null) {
    return {
      targetCents: row.targetCents,
      targetDate: null,
      shortfallCents: shortfall,
      cyclesRemaining: null,
      neededPerCycleCents: null,
      status: 'standing',
    };
  }

  const cycles = cyclesUntil(row.targetDate, today, cadence);

  /*
   * Rounded up, always. A shortfall of $101 over two paychecks is $50.50 each,
   * and a line funded at $50 is fifty cents short on the day it matters —
   * which is exactly the kind of quiet miss this whole feature exists to
   * surface rather than create.
   */
  const perCycle = cycles === 0 ? shortfall : (shortfall + BigInt(cycles) - 1n) / BigInt(cycles);

  // Null is not zero on the amount to delegate — it means "ad hoc, add nothing
  // when Delegate is pressed" — and for this comparison both put nothing in.
  const delegating = row.amountToDelegateCents ?? 0n;

  return {
    targetCents: row.targetCents,
    targetDate: row.targetDate,
    shortfallCents: shortfall,
    cyclesRemaining: cycles === 0 ? 0 : cycles,
    neededPerCycleCents: perCycle,
    status: perCycle > delegating ? 'behind' : 'on_track',
  };
}
