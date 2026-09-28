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
 * this line is set to delegate enough to make its next date?** That is a comparison
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

/** The last day of a month, in the UTC calendar these date keys are filed in. */
function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * A date key `count` months on, keeping the end of the month.
 *
 * The rule that matters is the one plain month arithmetic gets wrong. A bill due
 * on **the last day of April** is due on the last day of October, not on the
 * 30th of it — and a target anchored on the 31st of January would otherwise
 * arrive on the 3rd of March, which is a date nobody chose. So an anchor that is
 * the last day of its month stays the last day of every month it lands in, and
 * any other day is clamped rather than allowed to roll over.
 */
export function addMonthsToDayKey(key: Date, count: number): Date {
  const year = key.getUTCFullYear();
  const month = key.getUTCMonth();
  const day = key.getUTCDate();
  const wasLastDay = day === lastDayOf(year, month);

  const targetMonth = month + count;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = lastDayOf(targetYear, normalizedMonth);

  return new Date(
    Date.UTC(targetYear, normalizedMonth, wasLastDay ? lastDay : Math.min(day, lastDay)),
  );
}

/**
 * The occurrence a target is currently working towards.
 *
 * The stored date is an **anchor** — one occurrence of the series — rather than
 * a deadline, so a target that comes round again does not go stale the moment it
 * passes. Home insurance due on the last day of April and again on the last day
 * of October is one target with a six-month interval, and the reading always
 * looks at the next one still ahead.
 *
 * On the day itself the date is still ahead: money is due *that* day, and rolling
 * to the next occurrence at midnight would tell somebody they have six months to
 * find it on the morning it is wanted.
 */
export function nextOccurrence(anchor: Date, intervalMonths: number | null, today: Date): Date {
  if (intervalMonths === null || intervalMonths <= 0) return anchor;

  let occurrence = anchor;

  // Backwards as well as forwards: an anchor entered in the future is still one
  // occurrence of the series, and the household may well be closer to an earlier
  // one. Somebody recording "the last day of October" in September means this
  // October, not next.
  while (addMonthsToDayKey(occurrence, -intervalMonths).getTime() >= today.getTime()) {
    occurrence = addMonthsToDayKey(occurrence, -intervalMonths);
  }
  while (occurrence.getTime() < today.getTime()) {
    occurrence = addMonthsToDayKey(occurrence, intervalMonths);
  }

  return occurrence;
}

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
  /**
   * The occurrence being worked towards — the anchor itself for a one-off, and
   * the next one still ahead for a target that repeats. Null when there is no
   * date at all.
   */
  readonly targetDate: Date | null;
  /** How often it comes round, in months. Null for a one-off. */
  readonly intervalMonths: number | null;
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
  /** One occurrence of the date, not necessarily the next one. */
  readonly targetDate: Date | null;
  /** How often it comes round, in months. Null for a one-off. */
  readonly targetIntervalMonths?: number | null | undefined;
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
  if (days < 0) return 0;
  // The day itself still counts as one: money is due that day, and reporting
  // zero paychecks left would show the whole shortfall as "already too late"
  // on the morning it is actually wanted.
  if (days === 0) return 1;

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

  const intervalMonths = row.targetIntervalMonths ?? null;
  /*
   * The occurrence being worked towards, which for a repeating target is the
   * next one still ahead rather than the anchor that was typed. Everything
   * below is about that date, so it is resolved once, here.
   */
  const occurrence =
    row.targetDate === null ? null : nextOccurrence(row.targetDate, intervalMonths, today);

  const shortfall = row.targetCents - row.balanceCents;

  if (shortfall <= 0n) {
    return {
      targetCents: row.targetCents,
      targetDate: occurrence,
      intervalMonths,
      shortfallCents: 0n,
      cyclesRemaining: null,
      neededPerCycleCents: null,
      status: 'met',
    };
  }

  if (occurrence === null) {
    return {
      targetCents: row.targetCents,
      targetDate: null,
      intervalMonths: null,
      shortfallCents: shortfall,
      cyclesRemaining: null,
      neededPerCycleCents: null,
      status: 'standing',
    };
  }

  const cycles = cyclesUntil(occurrence, today, cadence);

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
    targetDate: occurrence,
    intervalMonths,
    shortfallCents: shortfall,
    cyclesRemaining: cycles === 0 ? 0 : cycles,
    neededPerCycleCents: perCycle,
    status: perCycle > delegating ? 'behind' : 'on_track',
  };
}
