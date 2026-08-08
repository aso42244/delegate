import { api } from './client.js';

/** The account list. Cents are decimal strings — ADR 002. */

export interface AccountDto {
  readonly id: string;
  readonly name: string;
  readonly type: 'asset' | 'debt';
  readonly source: 'simplefin' | 'manual';
  readonly balanceCents: string;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
  readonly groupingId: string | null;
  readonly archivedAt: string | null;
}

export const accountsApi = {
  list: () => api.get<{ accounts: readonly AccountDto[] }>('/api/accounts'),
};
