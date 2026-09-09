import { addMonthsToDayKey, type PayCadence } from '@budget/shared';
import { asDayKey, localDayKey } from './calendar.js';

/**
 * The pay cycle: where the household is between one payday and the next.
 *
 * **Money still moves on Delegate presses.** Nothing here schedules a run, and
 * no amount is ever written because a date passed. What this adds is the other
 * half of the question the budget page has never been able to answer: not "how
 * much is left" but "how much is left *for how long*". A line that has spent
 * 90% of its money is fine on the last day of a cycle and alarming on the
 * second.
 *
 * That reading needs a dated schedule, and `payCadence` alone could not give
 * one — it is a divisor, deliberately, and says how many paychecks a year
 * arrive rather than when. **One anchor date turns it into a schedule**:
 * `nextPaydayOn` plus the cadence generates every boundary before and after it.
 *
 * ## Stepping
 *
 * Weekly, fortnightly and monthly are exact. Seven days, fourteen days, and the
 * same day of the following month via `addMonthsToDayKey` — the helper recurring
 * targets already use, which clamps a 31st into a month that has no 31st and
 * keeps an end-of-month anchor on the end of the month. Shared rather than
 * rewritten, so a payday and a target that fall on the last day of April cannot
 * disagree about when they come round again.
 *
 * **Semi-monthly is the awkward one and is honest about it.** Twenty-four
 * paydays a year means exactly two per month, so it cannot be a fixed number of
 * days — stepping fifteen at a time drifts five days over a year. It is instead
 * two days of the month, derived from the anchor: the anchor's own day, and its
 * partner fifteen days away, wrapped into the same month. An anchor on the 15th
 * gives the 15th and the 30th; an anchor on the 1st gives the 1st and the 16th.
 *
 * A household paid on the 1st and the 15th — fourteen days apart, not fifteen —
 * therefore sees its second boundary land a day late. That is a real
 * inaccuracy, it moves the tick by about seven percent of a cycle, and it is
 * accepted rather than hidden: the alternative is storing two anchor dates to
 * serve one cadence out of four. If it ever matters, the fix is a second date
 * rather than cleverer arithmetic.
 */

export interface PayCycle {
  /** The payday this cycle began on. */
  readonly start: Date;
  /** The next payday. The cycle is `[start, end)`. */
  readonly end: Date;
  readonly lengthDays: number;
  /** Whole days from `start` to today, never past `lengthDays`. */
  readonly elapsedDays: number;
  /** 0 on payday, approaching 1 the day before the next. */
  readonly progress: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(key: Date, count: number): Date {
  return asDayKey(new Date(key.getTime() + count * DAY_MS));
}

/** The last day of the month a key falls in, so a partner day can be clamped. */
function daysInMonth(key: Date): number {
  return new Date(Date.UTC(key.getUTCFullYear(), key.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Semi-monthly's two days of the month, from the anchor's own day. */
function semimonthlyDays(anchor: Date): [number, number] {
  const day = anchor.getUTCDate();
  const partner = day > 15 ? day - 15 : day + 15;
  return day < partner ? [day, partner] : [partner, day];
}

/** The payday immediately after `key`, for a cadence that steps in whole days. */
function nextByDays(anchor: Date, step: number, key: Date): Date {
  // Whole steps from the anchor, in either direction: the anchor is a date the
  // household named, not necessarily one in the future.
  const delta = Math.floor((key.getTime() - anchor.getTime()) / DAY_MS);
  const steps = Math.floor(delta / step) + 1;
  return addDays(anchor, steps * step);
}

function nextSemimonthly(anchor: Date, key: Date): Date {
  const [first, second] = semimonthlyDays(anchor);
  const year = key.getUTCFullYear();
  const month = key.getUTCMonth();

  // The two candidates in this month, then the first of the next — one of them
  // is always strictly after `key`.
  const candidates = [
    new Date(Date.UTC(year, month, Math.min(first, daysInMonth(key)))),
    new Date(Date.UTC(year, month, Math.min(second, daysInMonth(key)))),
    new Date(Date.UTC(year, month + 1, first)),
  ];
  return candidates.find((candidate) => candidate.getTime() > key.getTime()) ?? candidates[2]!;
}

function nextMonthly(anchor: Date, key: Date): Date {
  let months =
    (key.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (key.getUTCMonth() - anchor.getUTCMonth());
  let candidate = addMonthsToDayKey(anchor, months);
  // Walk rather than solve: clamping a 31st into February means the arithmetic
  // is not reversible, so the only safe answer is to step until it passes.
  while (candidate.getTime() <= key.getTime()) {
    months += 1;
    candidate = addMonthsToDayKey(anchor, months);
  }
  while (addMonthsToDayKey(anchor, months - 1).getTime() > key.getTime()) {
    months -= 1;
    candidate = addMonthsToDayKey(anchor, months);
  }
  return candidate;
}

/** The next payday strictly after `key`. */
export function nextPayday(anchor: Date, cadence: PayCadence, key: Date): Date {
  switch (cadence) {
    case 'weekly':
      return nextByDays(anchor, 7, key);
    case 'biweekly':
      return nextByDays(anchor, 14, key);
    case 'semimonthly':
      return nextSemimonthly(anchor, key);
    case 'monthly':
      return nextMonthly(anchor, key);
  }
}

/** The payday on or before `key` — the day the current cycle began. */
export function currentPaydayStart(anchor: Date, cadence: PayCadence, key: Date): Date {
  // One step back from the next one. Expressed this way rather than with a
  // second set of formulas so the two boundaries cannot disagree about where a
  // cycle divides — which is the whole reason a cycle has a length at all.
  const next = nextPayday(anchor, cadence, key);
  switch (cadence) {
    case 'weekly':
      return addDays(next, -7);
    case 'biweekly':
      return addDays(next, -14);
    case 'semimonthly': {
      const [first, second] = semimonthlyDays(anchor);
      const day = next.getUTCDate();
      if (day === Math.min(first, daysInMonth(next))) {
        // The earlier of the two days, so the previous boundary is last month's
        // later one.
        const previousMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() - 1, 1));
        return new Date(
          Date.UTC(
            previousMonth.getUTCFullYear(),
            previousMonth.getUTCMonth(),
            Math.min(second, daysInMonth(previousMonth)),
          ),
        );
      }
      return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), first));
    }
    case 'monthly':
      return addMonthsToDayKey(next, -1);
  }
}

/**
 * Where today sits between one payday and the next.
 *
 * Null when no anchor has been set. That is deliberately not a default: a tick
 * drawn from a guessed schedule would be a confident marker in the wrong place,
 * and every reading on the page is judged against it.
 */
export function payCycleAt(
  anchor: Date | null,
  cadence: PayCadence,
  now: Date,
  timeZone: string,
): PayCycle | null {
  if (anchor === null) return null;

  const today = localDayKey(now, timeZone);
  const start = currentPaydayStart(asDayKey(anchor), cadence, today);
  const end = nextPayday(asDayKey(anchor), cadence, today);

  const lengthDays = Math.max(Math.round((end.getTime() - start.getTime()) / DAY_MS), 1);
  const elapsedDays = Math.min(
    Math.max(Math.round((today.getTime() - start.getTime()) / DAY_MS), 0),
    lengthDays,
  );

  return { start, end, lengthDays, elapsedDays, progress: elapsedDays / lengthDays };
}
