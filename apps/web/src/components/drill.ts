/**
 * Drill-through: a figure opens the register on exactly the rows it adds up.
 *
 * Every figure that sums transactions links here rather than building its own
 * query string, so the vocabulary is one list and the register reads the same
 * one back (ADR 077). The window is always an instant the server sent — never a
 * date computed in the browser, whose zone is not necessarily the household's,
 * and which would disagree with the figure it was opened from by the offset.
 */

/** The filters a link can carry. Each is one the register reads from its URL. */
export interface DrillFilters {
  readonly delegationId?: string;
  /** A grouping's id, or `none` for the delegations in no grouping. */
  readonly groupingId?: string;
  readonly kind?: 'normal' | 'income';
  readonly sign?: 'in' | 'out';
  readonly source?: 'simplefin' | 'manual';
  readonly uncategorized?: true;
  /** An instant from the server; null is "ever". */
  readonly dateFrom?: string | null;
  /** An instant from the server, exclusive. */
  readonly dateBefore?: string | null;
  /** A household-zone calendar day, `YYYY-MM-DD`. */
  readonly day?: string;
}

/** What the link was opened from, so the register can say whether it matches. */
export interface DrillFigure {
  /** "2 - Food on Spending by grouping". */
  readonly label: string;
  /** The figure as drawn, in cents. Compared by magnitude: spending is drawn positive. */
  readonly cents: bigint;
}

/** The URL keys, in the order they are written, so a link is stable. */
export const DRILL_KEYS = [
  'delegationId',
  'groupingId',
  'kind',
  'sign',
  'source',
  'uncategorized',
  'dateFrom',
  'dateBefore',
  'day',
] as const;

export function registerHref(filters: DrillFilters, figure?: DrillFigure): string {
  const params = new URLSearchParams();
  for (const key of DRILL_KEYS) {
    const value = filters[key];
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  if (figure) {
    params.set('figure', figure.label);
    params.set('expect', figure.cents.toString());
  }
  return `/transactions?${params.toString()}`;
}

/** Whether a register total is the figure it was opened from, to the cent. */
export function reconciles(totalCents: bigint, expectCents: bigint): boolean {
  const magnitude = (value: bigint): bigint => (value < 0n ? -value : value);
  return magnitude(totalCents) === magnitude(expectCents);
}
