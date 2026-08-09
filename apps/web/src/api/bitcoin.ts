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
    api.get<{ price: BitcoinPriceDto | null; holdings: readonly BitcoinHoldingDto[] }>(
      '/api/bitcoin',
    ),

  setHolding: (accountId: string, sats: string | null) =>
    api.patch<{ ok: boolean }>(`/api/accounts/${accountId}/bitcoin`, { sats }),

  refresh: () =>
    api.post<{ updated: boolean; priceCents?: string; source?: string }>('/api/bitcoin/refresh'),
};

export const valuationsApi = {
  list: (accountId: string) =>
    api.get<{ valuations: readonly ValuationDto[] }>(`/api/accounts/${accountId}/valuations`),

  record: (accountId: string, input: { valueCents: string; asOf: string; note?: string | null }) =>
    api.post<{ id: string; isCurrent: boolean }>(`/api/accounts/${accountId}/valuations`, input),

  equity: (accountId: string) =>
    api.get<{ equity: EquityDto | null }>(`/api/accounts/${accountId}/equity`),
};
