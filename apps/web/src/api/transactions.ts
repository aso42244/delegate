import { api } from './client.js';

/** The Transactions page's data. Cents are decimal strings — ADR 002. */

export interface AllocationDto {
  readonly id: string;
  readonly delegationId: string;
  readonly amountCents: string;
  readonly delegation: {
    readonly id: string;
    readonly name: string;
    readonly archivedAt: string | null;
  };
}

export interface TransactionDto {
  readonly id: string;
  readonly accountId: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly description: string;
  readonly descriptionRaw: string;
  readonly pending: boolean;
  readonly kind: 'normal' | 'income' | 'transfer';
  readonly archivedAt: string | null;
  /** Set once a pair is confirmed; both halves point at each other. */
  readonly pairedTransactionId: string | null;
  readonly account: { readonly id: string; readonly name: string; readonly type: 'asset' | 'debt' };
  readonly allocations: readonly AllocationDto[];
}

export interface TransactionListDto {
  readonly transactions: readonly TransactionDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * `| undefined` is explicit because `exactOptionalPropertyTypes` is on: clearing
 * a filter sets the key to undefined rather than removing it, and a bare
 * optional would reject that.
 */
export interface TransactionFilters {
  readonly search?: string | undefined;
  readonly accountId?: string | undefined;
  readonly delegationId?: string | undefined;
  readonly kind?: string | undefined;
  readonly uncategorized?: boolean | undefined;
  readonly pending?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

function toQuery(filters: TransactionFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    // A false boolean is meaningful for `pending` and `uncategorized` — it means
    // "only categorized" — so only undefined and empty strings are dropped.
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export interface CreateTransactionInput {
  readonly accountId: string;
  /** Signed cents: negative is money out of the account. */
  readonly amountCents: string;
  readonly description: string;
  readonly postedAt: string;
  readonly kind: 'normal' | 'income' | 'transfer';
}

export interface PairSideDto {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly description: string;
}

export interface PairCandidateDto {
  readonly outflow: PairSideDto;
  readonly inflow: PairSideDto;
  readonly daysApart: number;
}

export const transactionsApi = {
  list: (filters: TransactionFilters = {}) =>
    api.get<TransactionListDto>(`/api/transactions${toQuery(filters)}`),

  create: (input: CreateTransactionInput) =>
    api.post<{ transaction: { id: string } }>('/api/transactions', input),

  categorize: (transactionId: string, delegationId: string) =>
    api.post<{ allocationCount: number }>(`/api/transactions/${transactionId}/categorize`, {
      delegationId,
    }),

  /**
   * A split with exact amounts. The server rejects a set that does not sum to
   * the transaction, so a cent can never be lost or invented here.
   */
  setAllocations: (
    transactionId: string,
    allocations: readonly { delegationId: string; amountCents: string }[],
  ) =>
    api.post<{ allocationCount: number }>(`/api/transactions/${transactionId}/categorize`, {
      allocations,
    }),

  /** Splits evenly across several delegations; the server holds the remainder cent. */
  split: (transactionId: string, delegationIds: readonly string[]) =>
    api.post<{ allocationCount: number }>(`/api/transactions/${transactionId}/categorize`, {
      delegationIds,
    }),

  uncategorize: (transactionId: string) =>
    api.post<{ reversedEventCount: number }>(`/api/transactions/${transactionId}/uncategorize`),

  /** Suggestions only — §7: wrong automatic pairing is worse than no pairing. */
  pairCandidates: () =>
    api.get<{ candidates: readonly PairCandidateDto[] }>('/api/transactions/pair-candidates'),

  pair: (firstId: string, secondId: string) =>
    api.post<{ ok: boolean }>('/api/transactions/pair', { firstId, secondId }),

  unpair: (transactionId: string) =>
    api.post<{ ok: boolean }>(`/api/transactions/${transactionId}/unpair`),

  bulkCategorize: (transactionIds: readonly string[], delegationId: string) =>
    api.post<{ categorized: number; failures: { transactionId: string; reason: string }[] }>(
      '/api/transactions/bulk-categorize',
      { transactionIds, delegationId },
    ),
};
