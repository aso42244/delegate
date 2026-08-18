import { api } from './client.js';

/** Bitcoin holdings and price, and property valuations. Cents are strings — ADR 002. */

export interface BitcoinPriceDto {
  readonly priceCents: string;
  readonly priceDate: string;
  readonly source: string;
  readonly fetchedAt: string;
  /** True when nobody could refresh it today. The value is still shown. */
  readonly stale: boolean;
}

export interface BitcoinHoldingDto {
  readonly id: string;
  readonly name: string;
  /** Satoshis, as a decimal string of whole units. */
  readonly sats: string;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  /** Null before any price has ever been fetched — never a zero. */
  readonly valueCents: string | null;
  readonly balanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
  /** When the budget figure was last written. Only in-budget holdings have one. */
  readonly revaluedAt: string | null;
}

export interface PropertyDto {
  readonly id: string;
  readonly name: string;
  readonly valueCents: string;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  /** The date the current figure is for. */
  readonly valuedAt: string | null;
  /** When someone last confirmed it, which is what staleness counts from. */
  readonly confirmedAt: string | null;
  readonly stalenessIntervalDays: number | null;
  readonly mortgage: {
    readonly id: string;
    readonly name: string;
    readonly balanceCents: string;
  } | null;
  /** Value minus what is owed on it. Computed on read, never stored. */
  readonly equityCents: string | null;
  readonly valuations: readonly ValuationDto[];
}

export interface ValuationDto {
  readonly id: string;
  readonly valueCents: string;
  readonly asOf: string;
  readonly note: string | null;
}

export interface EquityDto {
  readonly propertyValueCents: string;
  readonly mortgageBalanceCents: string;
  readonly equityCents: string;
}

export const bitcoinApi = {
  get: () =>
    api.get<{
      price: BitcoinPriceDto | null;
      holdings: readonly BitcoinHoldingDto[];
      /** False once someone has read what an in-budget holding does to the banner. */
      inBudgetWarningDue: boolean;
    }>('/api/bitcoin'),

  /** No account has to exist first — that is the point of this route. */
  create: (input: { name: string; sats?: string; inBudget?: boolean; inNetWorth?: boolean }) =>
    api.post<{ holding: { id: string } }>('/api/bitcoin/holdings', input),

  update: (
    id: string,
    input: { name?: string; sats?: string; inBudget?: boolean; inNetWorth?: boolean },
  ) => api.patch<{ ok: boolean }>(`/api/bitcoin/holdings/${id}`, input),

  acknowledgeInBudget: () => api.post<{ ok: boolean }>('/api/bitcoin/in-budget-acknowledgement'),

  refresh: () =>
    api.post<{ updated: boolean; priceCents?: string; source?: string }>('/api/bitcoin/refresh'),
};

export const propertiesApi = {
  list: () => api.get<{ properties: readonly PropertyDto[] }>('/api/properties'),

  create: (input: {
    name: string;
    valueCents: string;
    asOf: string;
    inBudget?: boolean;
    inNetWorth?: boolean;
    mortgageAccountId?: string | null;
  }) => api.post<{ property: { id: string } }>('/api/properties', input),

  update: (
    id: string,
    input: {
      name?: string;
      inBudget?: boolean;
      inNetWorth?: boolean;
      mortgageAccountId?: string | null;
    },
  ) => api.patch<{ ok: boolean }>(`/api/properties/${id}`, input),
};

export const valuationsApi = {
  list: (accountId: string) =>
    api.get<{ valuations: readonly ValuationDto[] }>(`/api/accounts/${accountId}/valuations`),

  record: (accountId: string, input: { valueCents: string; asOf: string; note?: string | null }) =>
    api.post<{ id: string; isCurrent: boolean }>(`/api/accounts/${accountId}/valuations`, input),

  equity: (accountId: string) =>
    api.get<{ equity: EquityDto | null }>(`/api/accounts/${accountId}/equity`),
};
