import { formatCents } from '@budget/shared';
import type { BudgetRowDto } from '../api/budget.js';
import { INTERVAL_LABELS } from './target-intervals.js';

/**
 * A target, in words.
 *
 * One place, because the same target is described on the Budget row's amount to
 * delegate, in its row menu, and on Settings → Delegations — and three phrasings
 * of one fact is three things to keep in step.
 *
 * **The verdict is never computed here.** It arrives with the row: whether a
 * line will make its date depends on the pay cadence and on which day it is in
 * the household's zone, and a second copy of that arithmetic is a second answer
 * waiting to disagree with the first.
 */

/** A date key — `2026-12-27` — read as the day it says, in no particular zone. */
function dayLabel(dayKey: string, withYear: boolean): string {
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(undefined, {
    // Without this the browser places midnight UTC in the reader's own zone and
    // shows the 26th to anybody west of it.
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** The whole sentence, for the figure the target is a judgement about. */
export function describeTarget(row: BudgetRowDto): string | null {
  const target = row.target;
  if (!target) return null;

  const goal = formatCents(BigInt(target.targetCents));
  const by = target.targetDate === null ? '' : ` by ${dayLabel(target.targetDate, true)}`;
  // How often it comes round, where it does. The date above is the next
  // occurrence, so without this the row would read as a one-off deadline.
  const repeats =
    target.intervalMonths === null
      ? ''
      : `, ${INTERVAL_LABELS[target.intervalMonths] ?? `every ${target.intervalMonths} months`}`;
  const needed = formatCents(BigInt(target.neededPerCycleCents ?? '0'));

  switch (target.status) {
    case 'met':
      return `Target ${goal}${by}${repeats} — reached.`;
    case 'standing':
      return `Target ${goal} — ${formatCents(BigInt(target.shortfallCents))} short, with no date to work to.`;
    case 'on_track':
      return `Target ${goal}${by}${repeats} — needs ${needed} a paycheck, and this line delegates at least that.`;
    case 'behind':
      return `Target ${goal}${by}${repeats} — needs ${needed} a paycheck, more than this line is set to delegate.`;
  }
}

/** The short form, for the one line a menu item's hint gets. */
export function summarizeTarget(row: BudgetRowDto): string {
  const target = row.target;
  if (!target) return '';

  const goal = formatCents(BigInt(target.targetCents));
  const by = target.targetDate === null ? '' : ` by ${dayLabel(target.targetDate, false)}`;

  const verdict =
    target.status === 'met'
      ? 'reached'
      : target.status === 'behind'
        ? 'not on course'
        : target.status === 'standing'
          ? `${formatCents(BigInt(target.shortfallCents))} short`
          : 'on course';

  return `${goal}${by} — ${verdict}.`;
}
