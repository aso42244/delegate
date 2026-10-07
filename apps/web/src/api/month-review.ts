import { api } from './client.js';

/** Month in review (ADR 078). Cents are decimal strings — ADR 002. */

/** A line's or a grouping's month. */
export interface MonthFiguresDto {
  /** What it held when the month began. */
  readonly startCents: string;
  /** What Delegate presses put in. */
  readonly delegatedCents: string;
  /** Transfers in and out and adjustments, net. */
  readonly movedCents: string;
  /** Ordinary spending filed to it, net of refunds. A magnitude. */
  readonly spentCents: string;
  /** What it held when the month ended. */
  readonly endCents: string;
}

export interface MonthLineDto extends MonthFiguresDto {
  readonly delegationId: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface MonthGroupingDto extends MonthFiguresDto {
  /** Null is the lines in no grouping. */
  readonly id: string | null;
  readonly name: string;
  readonly color: string | null;
  readonly lines: readonly MonthLineDto[];
}

export type BillMoveDto =
  | {
      readonly kind: 'moved';
      readonly amountCents: string;
      readonly typicalCents: string;
      readonly changeBasisPoints: number;
      readonly day: string;
    }
  | { readonly kind: 'new'; readonly amountCents: string; readonly day: string }
  | { readonly kind: 'missed'; readonly typicalCents: string; readonly expectedDay: string };

export interface MonthBillDto {
  readonly key: string;
  readonly name: string;
  readonly delegationId: string | null;
  readonly move: BillMoveDto;
}

export interface MonthReviewDto {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The instants the month spans in the household's zone, `before` exclusive. */
  readonly from: string;
  readonly before: string;
  readonly previousMonth: string | null;
  readonly nextMonth: string | null;
  readonly cameInCents: string;
  readonly wentOutCents: string;
  readonly previous: { readonly cameInCents: string; readonly wentOutCents: string } | null;
  /** Every line, by grouping, in the budget's order. */
  readonly groupings: readonly MonthGroupingDto[];
  readonly uncategorizedCents: string;
  readonly bills: readonly MonthBillDto[];
  readonly netWorth: {
    readonly startDate: string;
    readonly endDate: string;
    readonly startCents: string;
    readonly endCents: string;
    readonly otherAssetsChangeCents: string;
    readonly bitcoinChangeCents: string;
    readonly debtsPaidDownCents: string;
  } | null;
}

export const monthReviewApi = {
  get: (month: string | null) =>
    api.get<MonthReviewDto>(`/api/month-review${month === null ? '' : `?month=${month}`}`),
};
