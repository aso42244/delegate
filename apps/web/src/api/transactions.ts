import type { TransactionKind } from '@budget/shared';
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
  /** The outstanding check this payment settled, if it settled one. */
  readonly settledCheckNumber: string | null;
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly type: 'asset' | 'debt';
    /** False for an account that is in net worth only — an IRA, a brokerage. */
    readonly inBudget: boolean;
  };
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

/**
 * Where this merchant went the last few times.
 *
 * Advice only: the counts travel with it so the row can show `14 of 15` rather
 * than assert a delegation with nothing behind it.
 */
export interface SuggestionDto {
  readonly transactionId: string;
  readonly delegationId: string;
  readonly delegationName: string;
  readonly matchCount: number;
  readonly totalCount: number;
}

/** Two rows that look like one charge. Advice: nothing is archived until asked. */
export interface DuplicateSideDto {
  readonly id: string;
  readonly accountName: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly description: string;
  /** Archiving this one puts money back in an envelope; the other does not. */
  readonly categorized: boolean;
}

export interface DuplicateCandidateDto {
  readonly original: DuplicateSideDto;
  readonly copy: DuplicateSideDto;
  readonly daysApart: number;
  /** The re-import signature: two feed rows for one charge, with different ids. */
  readonly differentExternalIds: boolean;
  /**
   * `reimport` — two rows the bank sent, after an institution was reconnected.
   * `standby` — a row typed in while the feed was behind, against the feed's own
   * row for the same charge now that it has arrived.
   */
  readonly reason: 'reimport' | 'standby';
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

  /**
   * Re-labels what a row *is*. Income and transfers allocate to nothing, so the
   * server refuses the change while the row still carries a categorization —
   * clear it first.
   */
  /**
   * Takes a transaction out of the register.
   *
   * Archive, never delete — nothing here is hard-deleted. The server reverses
   * any envelope movement it caused and, for a manual row, backs its amount out
   * of the account balance; a synced account's balance comes from the feed and
   * is left alone.
   */
  archive: (transactionId: string) =>
    api.post<{ ok: boolean }>(`/api/transactions/${transactionId}/archive`),

  setKind: (transactionId: string, kind: TransactionKind) =>
    api.patch<void>(`/api/transactions/${transactionId}`, { kind }),

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

  /**
   * A suggested delegation for every uncategorized row with enough history
   * behind it, in one call rather than one per row.
   */
  suggestions: () =>
    api.get<{ suggestions: readonly SuggestionDto[] }>('/api/transactions/suggestions'),

  /** Read-only. Archiving is a separate, deliberate press. */
  duplicates: () =>
    api.get<{ candidates: readonly DuplicateCandidateDto[] }>('/api/transactions/duplicates'),

  /**
   * "These two are not the same charge", kept.
   *
   * Recorded against the pair rather than against a row: both stay eligible to
   * be proposed against anything else.
   */
  dismissDuplicate: (firstId: string, secondId: string) =>
    api.post<{ ok: boolean }>('/api/transactions/duplicates/dismiss', { firstId, secondId }),

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
  bulkArchive: (transactionIds: readonly string[]) =>
    api.post<{ archived: number; failures: { transactionId: string; reason: string }[] }>(
      '/api/transactions/bulk-archive',
      { transactionIds },
    ),
};
