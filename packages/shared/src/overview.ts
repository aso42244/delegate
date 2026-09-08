/**
 * The Overview grid's width vocabulary.
 *
 * Four words, and they are `SettingsCard`'s four words rather than a second
 * scale invented for tiles — docs/ui-system.md §11 records why: a field's
 * `width` and a card's `span` were nearly given one name, and two vocabularies
 * under one idea is a trap for whoever reads it next. Six columns because three
 * cannot express "two side by side", and a half is not a whole number of thirds.
 *
 * Here in `@budget/shared` rather than on either side alone: the server refuses
 * a span it does not recognise and the client turns one into a column count, and
 * a list that lives in two places is a list that disagrees with itself.
 *
 * A phone has one column and ignores all of this. That is deliberate — the span
 * is a fact about the desktop grid, not about the tile, which is what lets one
 * stored arrangement serve both screens.
 */

export const OVERVIEW_SPANS = ['third', 'half', 'two-thirds', 'full'] as const;

export type OverviewSpan = (typeof OVERVIEW_SPANS)[number];

/** What a tile that has never been sized is. The width every card always had. */
export const DEFAULT_OVERVIEW_SPAN: OverviewSpan = 'full';

export function isOverviewSpan(value: string): value is OverviewSpan {
  return (OVERVIEW_SPANS as readonly string[]).includes(value);
}

/**
 * How many of the grid's six columns a span takes.
 *
 * The grid is six wide, so the mapping is exact and there is no rounding to
 * argue about: a third is two columns, a half is three, two-thirds is four.
 */
export const OVERVIEW_SPAN_COLUMNS: Record<OverviewSpan, number> = {
  third: 2,
  half: 3,
  'two-thirds': 4,
  full: 6,
};

/** What the size control cycles through, in the order a person would grow a tile. */
export function nextOverviewSpan(span: OverviewSpan): OverviewSpan {
  const index = OVERVIEW_SPANS.indexOf(span);
  return OVERVIEW_SPANS[(index + 1) % OVERVIEW_SPANS.length]!;
}
