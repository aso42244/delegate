import { api } from './client.js';

/** The Bills page. Cents are decimal strings — ADR 002. */

/**
 * What a bill is doing right now.
 *
 * `lapsed` is the one worth understanding: a bill so far past due that it has
 * probably stopped rather than slipped. It is shown and never announced, so a
 * cancelled service does not shout for ever.
 *
 * `arrived` means the charge is in the register and has not settled. It exists
 * because a bill that has plainly been paid must never read as overdue.
 */
export type BillStatus = 'expected' | 'arrived' | 'due' | 'overdue' | 'lapsed';

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
  /** When the unsettled charge arrived. Set on an `arrived` bill, null otherwise. */
  readonly pendingSince: string | null;
  /** How many charges were attached to this bill by hand. */
  readonly linkedCount: number;
  readonly delegationId: string | null;
  readonly delegationName: string | null;
  readonly accountName: string | null;
}

/** A charge that could be the one a bill is waiting for. */
export interface LinkCandidateDto {
  readonly id: string;
  readonly description: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly pending: boolean;
  readonly accountName: string;
  /** Attaching it here takes it off whatever bill it is on now. */
  readonly linkedElsewhere: boolean;
}

/** A charge already attached to a bill by hand. */
export interface BillLinkDto {
  readonly transactionId: string;
  readonly description: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly pending: boolean;
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

  /**
   * Charges that could be the one this bill is waiting for, nearest what was
   * expected first. A search reaches the whole register; without one the offer
   * is the window around the expected date.
   */
  linkCandidates: (input: {
    expectedNextAt: string;
    typicalAmountCents: string;
    search?: string;
  }) => {
    const params = new URLSearchParams({
      expectedNextAt: input.expectedNextAt,
      typicalAmountCents: input.typicalAmountCents,
    });
    if (input.search !== undefined && input.search !== '') params.set('search', input.search);
    return api.get<{ candidates: readonly LinkCandidateDto[] }>(
      `/api/recurring/link-candidates?${params.toString()}`,
    );
  },

  links: (key: string) =>
    api.get<{ links: readonly BillLinkDto[] }>(
      `/api/recurring/links?key=${encodeURIComponent(key)}`,
    ),

  /** "That charge is this bill." Moves the last-seen date, never the cadence. */
  link: (key: string, transactionId: string) =>
    api.post<{ ok: boolean }>('/api/recurring/links', { key, transactionId }),

  unlink: (transactionId: string) =>
    api.post<{ ok: boolean }>('/api/recurring/unlink', { transactionId }),
};
