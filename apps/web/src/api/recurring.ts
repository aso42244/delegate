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
  /** The household's own name where they gave one, the bank's otherwise. */
  readonly name: string;
  /** What the bank calls it, always. Kept so a rename hides nothing. */
  readonly feedName: string;
  readonly renamed: boolean;
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

/** A merchant somebody has said is not a bill, and what it was called then. */
export interface HiddenBillDto {
  readonly key: string;
  readonly label: string;
}

export const recurringApi = {
  list: () =>
    api.get<{ bills: readonly BillDto[]; hidden: readonly HiddenBillDto[] }>('/api/recurring'),

  /**
   * What somebody says back about a detected bill: that it is not one, or that
   * it is called something else.
   *
   * Whatever is left out stays as it was — renaming must not put back a hidden
   * bill, and putting one back must not throw away its name.
   */
  override: (input: {
    key: string;
    label: string;
    hidden?: boolean;
    displayName?: string | null;
  }) => api.post<{ ok: boolean }>('/api/recurring/overrides', input),
};
