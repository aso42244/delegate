import { api } from './client.js';

/** Month in review (ADR 078). Cents are decimal strings — ADR 002. */

export interface MonthLineDto {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  readonly archived: boolean;
  readonly delegatedCents: string;
  readonly spentCents: string;
  readonly leftCents: string;
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
  readonly lines: readonly MonthLineDto[];
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
