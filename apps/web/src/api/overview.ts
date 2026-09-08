import type { OverviewSpan } from '@budget/shared';
import { api } from './client.js';

/**
 * Overview's two calls: the arrangement, and the data behind it.
 *
 * They are separate because they change for different reasons and at different
 * rates. Moving a tile rewrites the layout and must not refetch every figure on
 * the page; changing the period refetches the figures and must not touch the
 * arrangement. One combined call would do both every time.
 */

export interface OverviewTileDto {
  readonly key: string;
  readonly span: OverviewSpan;
  /** Which chart this tile is drawn as; null means the tile's own default. */
  readonly display: string | null;
}

export interface OverviewLayoutDto {
  /** Every tile this page can draw today. It grows a batch at a time. */
  readonly catalog: readonly string[];
  readonly spans: readonly OverviewSpan[];
  readonly tiles: readonly OverviewTileDto[];
}

/** Cents are decimal strings — ADR 002. Nothing here converts money to a number. */
export interface OverviewSpendingEntryDto {
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly spendCents: string;
}

export interface OverviewSpendingDto {
  readonly since: string | null;
  readonly cycleMissing: boolean;
  readonly entries: readonly OverviewSpendingEntryDto[];
}

export interface OverviewBacklogDto {
  readonly count: number;
  readonly oldestPostedAt: string | null;
}

export interface CompositionEntryDto {
  readonly name: string;
  readonly balanceCents: string;
  /** Basis points of the section total, so the split survives as an integer. */
  readonly shareBasisPoints: number;
}

export interface CompositionDto {
  readonly assets: readonly CompositionEntryDto[];
  readonly debts: readonly CompositionEntryDto[];
  readonly totalAssetsCents: string;
  readonly totalDebtsCents: string;
  readonly netCents: string;
}

export interface UtilityComparisonDto {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  readonly suggestedPerCycleCents: string;
  /** Null is an ad-hoc line with no standing amount, not one funded at zero. */
  readonly amountToDelegateCents: string | null;
}

export interface UtilitiesComparisonDto {
  readonly cyclesPerYear: number;
  readonly entries: readonly UtilityComparisonDto[];
}

export interface MoverDto {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  /** Signed: negative is a line that emptied over the window. */
  readonly changeCents: string;
}

export interface MoversDto {
  readonly cycleMissing: boolean;
  readonly entries: readonly MoverDto[];
}

export interface SeriesPointDto {
  readonly date: string;
  readonly provenance: string;
  readonly days?: number;
  /** Every other key is a money field, as a string of cents. */
  readonly [field: string]: string | number | undefined;
}

export interface AggregateDto {
  readonly bucket: string;
  readonly days: number;
  readonly earliest: string | null;
  readonly points: readonly SeriesPointDto[];
  /** Today, which no night has recorded yet. Drawn apart from the stored points. */
  readonly live: Readonly<Record<string, string>> | null;
}

export interface CompositionPointDto {
  readonly date: string;
  readonly provenance: string;
  readonly bitcoinCents: string;
  readonly otherAssetsCents: string;
  readonly debtsCents: string;
  /** Named fields above; the index signature is what the chart reads them by. */
  readonly [field: string]: string | number | undefined;
}

export interface CompositionSeriesDto {
  readonly days: number;
  readonly points: readonly CompositionPointDto[];
}

export interface EquityDto {
  readonly name: string | null;
  readonly days: number;
  readonly points: readonly SeriesPointDto[];
}

export interface TrajectoryDto {
  readonly points: readonly SeriesPointDto[];
  readonly payoffDate: string | null;
  /** "Not enough history" and "never pays off" are different answers. */
  readonly hasEnoughHistory: boolean;
}

/**
 * A key is absent when the tile is not on the page, which is not the same as a
 * tile with nothing in it — the first draws nothing, the second draws its empty
 * state.
 */
export interface OverviewDataDto {
  /** One aggregate series feeding three tiles — see the domain's comment. */
  readonly aggregate?: AggregateDto;
  readonly composition?: CompositionSeriesDto;
  readonly home_equity_over_time?: EquityDto;
  readonly debt_trajectory?: TrajectoryDto;
  readonly window: string;
  readonly spending_by_grouping?: OverviewSpendingDto;
  readonly spending_by_delegation?: OverviewSpendingDto;
  readonly asset_debt_composition?: CompositionDto;
  readonly utilities_vs_delegated?: UtilitiesComparisonDto;
  readonly delegation_movers?: MoversDto;
  readonly uncategorized_backlog?: OverviewBacklogDto;
}

export type LayoutSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly unknown?: readonly string[] }
  | { readonly ok: false; readonly badSpans?: readonly string[] }
  | { readonly ok: false; readonly duplicates?: readonly string[] };

export const overviewApi = {
  layout: () => api.get<OverviewLayoutDto>('/api/overview/layout'),

  data: (window: string) => api.get<OverviewDataDto>(`/api/overview?window=${window}`),

  /** The whole arrangement, never a partial one — see the route's comment. */
  saveLayout: (tiles: readonly OverviewTileDto[]) =>
    api.put<LayoutSaveResult>('/api/overview/layout', { tiles }),
};
