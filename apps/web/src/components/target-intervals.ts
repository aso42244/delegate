/**
 * How often a target comes round.
 *
 * The six that households actually use, plus anything else typed in months. A
 * bill due on the last day of April and again on the last day of October is one
 * target repeating every six months — a single date could record the April one
 * and then went stale the moment it passed, leaving somebody to retype the same
 * target twice a year.
 *
 * Months rather than days, because that is the unit these use and because "the
 * last day of April" recurs on "the last day of October", which no number of
 * days expresses.
 */

export const INTERVAL_CHOICES = [
  { months: 1, label: 'Every month' },
  { months: 2, label: 'Every 2 months' },
  { months: 3, label: 'Every 3 months' },
  { months: 4, label: 'Every 4 months' },
  { months: 6, label: 'Every 6 months' },
  { months: 12, label: 'Every year' },
] as const;

/** Lower case, for the middle of a sentence: "…by Oct 31, every 6 months —". */
export const INTERVAL_LABELS: Record<number, string> = Object.fromEntries(
  INTERVAL_CHOICES.map((choice) => [choice.months, choice.label.toLowerCase()]),
);

/** What the widest bound the API accepts is, so the dialog can say so. */
export const MAX_INTERVAL_MONTHS = 120;
