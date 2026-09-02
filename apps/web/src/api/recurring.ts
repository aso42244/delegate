import { api } from './client.js';

/** The Bills page. Cents are decimal strings — ADR 002. */

/**
 * What a bill is doing right now.
 *
 * `lapsed` is the one worth understanding: a bill so far past due that it has
 * probably stopped rather than slipped. It is shown and never announced, so a
 * cancelled service does not shout for ever.
 */
export type BillStatus = 'expected' | 'due' | 'overdue' | 'lapsed';

export interface BillDto {
  readonly key: string;
  readonly name: string;
  readonly cadence: string;
  readonly intervalDays: number;
  readonly occurrences: number;
  readonly typicalAmountCents: string;
  readonly lastAmountCents: string;
  readonly lastPostedAt: string;
  readonly expectedNextAt: string;
  readonly status: BillStatus;
  readonly daysLate: number;
  readonly delegationId: string | null;
  readonly delegationName: string | null;
  readonly accountName: string | null;
}

export const recurringApi = {
  list: () => api.get<{ bills: readonly BillDto[] }>('/api/recurring'),
};
