import { api } from './client.js';

/** The account list. Cents are decimal strings — ADR 002. */

export interface AccountDto {
  readonly id: string;
  readonly name: string;
  /** Null when none is set; the full name is shown everywhere in that case. */
  readonly nickname: string | null;
  readonly type: 'asset' | 'debt';
  readonly source: 'simplefin' | 'manual';
  readonly balanceCents: string;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
  readonly groupingId: string | null;
  /** The mortgage secured against this property, if it is one. */
  readonly mortgageAccountId: string | null;
  /** Satoshis as a decimal string, or null when this account holds none. */
  readonly bitcoinSats: string | null;
  /** Which Settings tab owns this row. `none` is an ordinary account. */
  readonly managedAs: 'none' | 'bitcoin' | 'property';
  readonly archivedAt: string | null;
}

export interface UpdateAccountInput {
  readonly name?: string;
  /** Empty clears it. Shown wherever the full bank name does not fit. */
  readonly nickname?: string | null;
  readonly type?: 'asset' | 'debt';
  readonly inBudget?: boolean;
  readonly inNetWorth?: boolean;
  readonly stalenessIntervalDays?: number | null;
  readonly groupingId?: string | null;
  readonly needsReview?: boolean;
  /** Manual accounts only — a SimpleFIN balance is the institution's to state. */
  readonly balanceCents?: string;
  /** The mortgage secured against this property, if it is one. */
  readonly mortgageAccountId?: string | null;
}

export const accountsApi = {
  list: (includeArchived = false) =>
    api.get<{ accounts: readonly AccountDto[] }>(
      `/api/accounts${includeArchived ? '?includeArchived=true' : ''}`,
    ),

  create: (input: {
    name: string;
    type: 'asset' | 'debt';
    balanceCents: string;
    inBudget: boolean;
    inNetWorth: boolean;
    stalenessIntervalDays: number | null;
  }) => api.post<{ account: { id: string } }>('/api/accounts', input),

  update: (id: string, input: UpdateAccountInput) =>
    api.patch<{ ok: boolean }>(`/api/accounts/${id}`, input),

  archive: (id: string) => api.post<{ ok: boolean }>(`/api/accounts/${id}/archive`),
  restore: (id: string) => api.post<{ ok: boolean }>(`/api/accounts/${id}/restore`),
};
