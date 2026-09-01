/**
 * Which months of a utility's window belong on its chart.
 *
 * Three rules, and the middle one is the reason this is a function rather than
 * two `slice` calls inline:
 *
 * - **Leading empty months go.** They are not history, they are the absence of
 *   it — a delegation made in June has no April. Drawn, they were invisible
 *   columns holding open half the chart, so the bars sat squashed against the
 *   right edge of the card with a blank left half.
 * - **Interior empty months stay.** A month between two bills with nothing in it
 *   is a fact about the utility, and dropping it would compress the gap out of
 *   the series and quietly redraw the history.
 * - **A trailing empty month goes only if it is incomplete.** The window runs to
 *   the current month, which usually has no bill in it yet. A *completed* month
 *   with no bill is the same fact as an interior one and stays.
 */

export interface ChartMonth {
  readonly spendCents: string;
  readonly complete: boolean;
}

export function visibleMonths<T extends ChartMonth>(months: readonly T[]): T[] {
  const values = months.map((month) => BigInt(month.spendCents));

  const first = values.findIndex((value) => value > 0n);
  // Nothing anywhere: the caller draws no chart at all, so the range is empty.
  if (first === -1) return [];

  const last = months.length - 1;
  const dropTrailing = values[last] === 0n && months[last]?.complete === false;

  return months.slice(first, dropTrailing ? last : months.length);
}
