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

export type BitcoinEventType =
  'opening' | 'purchase' | 'sale' | 'transfer_in' | 'transfer_out' | 'adjustment';

export interface HoldingEventDto {
  readonly id: string;
  readonly occurredAt: string;
  /** Signed satoshis, as a decimal string. */
  readonly deltaSats: string;
  readonly eventType: BitcoinEventType;
  /** What one whole Bitcoin cost at the time. Null where it does not apply. */
  readonly priceCents: string | null;
  /** What this event's Bitcoin cost, so a row reads on its own. */
  readonly costCents: string | null;
  readonly note: string | null;
  /** Stamped rather than deleted, so a correction stays part of the history. */
  readonly reversedAt: string | null;
}

export interface HoldingHistoryDto {
  readonly events: readonly HoldingEventDto[];
  readonly costBasis: {
    readonly costCents: string;
    readonly basisSats: string;
    /** Held Bitcoin whose cost nobody knows. Not valued at zero. */
    readonly unpricedSats: string;
  };
  /** Against the priced portion only. Null before any price exists. */
  readonly unrealizedCents: string | null;
  readonly worthCents: string | null;
}

export const holdingEventsApi = {
  list: (accountId: string) =>
    api.get<HoldingHistoryDto>(`/api/bitcoin/holdings/${accountId}/events`),

  record: (
    accountId: string,
    input: {
      eventType: Exclude<BitcoinEventType, 'adjustment'>;
      sats: string;
      occurredAt: string;
      priceCents?: string | null;
      note?: string | null;
    },
  ) =>
    api.post<{ id: string; balanceSats: string }>(
      `/api/bitcoin/holdings/${accountId}/events`,
      input,
    ),

  reverse: (eventId: string) =>
    api.post<{ reversed: boolean }>(`/api/bitcoin/events/${eventId}/reverse`),
};

export interface WatchedWalletDto {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  /** The first receive address. The key itself is never returned. */
  readonly firstAddress: string;
  readonly gapLimit: number;
  readonly lastScannedAt: string | null;
  readonly lastError: string | null;
  readonly lastBalanceSats: string | null;
  readonly addressesSeen: number;
}

export const walletsApi = {
  list: (accountId: string) =>
    api.get<{ wallets: readonly WatchedWalletDto[] }>(`/api/bitcoin/holdings/${accountId}/wallets`),

  add: (accountId: string, input: { label: string; key: string; gapLimit?: number }) =>
    api.post<{ wallet: { id: string; firstAddress: string } }>(
      `/api/bitcoin/holdings/${accountId}/wallets`,
      input,
    ),

  scan: (walletId: string) =>
    api.post<{
      balanceSats: string;
      addressesChecked: number;
      used: number;
      recorded: boolean;
    }>(`/api/bitcoin/wallets/${walletId}/scan`),

  archive: (walletId: string) =>
    api.post<{ ok: boolean }>(`/api/bitcoin/wallets/${walletId}/archive`),
};

export interface NodeSettingsDto {
  readonly mode: 'none' | 'esplora';
  readonly baseUrl: string | null;
  readonly useTor: boolean;
  readonly reach: 'public' | 'lan' | 'tor' | null;
  readonly lastCheckedAt: string | null;
  readonly lastHeight: number | null;
  readonly lastError: string | null;
  readonly suggestions: readonly { label: string; url: string; note: string }[];
}

export const nodeApi = {
  get: () => api.get<NodeSettingsDto>('/api/bitcoin/node'),

  save: (input: { mode: 'none' | 'esplora'; baseUrl?: string | null; useTor?: boolean }) =>
    api.put<{ ok: boolean }>('/api/bitcoin/node', input),

  check: () =>
    api.post<{ ok: boolean; height: number | null; error: string | null }>(
      '/api/bitcoin/node/check',
    ),
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
