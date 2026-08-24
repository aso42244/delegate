import { api } from './client.js';

/** Outstanding checks: money written but not yet cashed. Cents are strings — ADR 002. */

export interface OutstandingCheckDto {
  readonly id: string;
  readonly checkNumber: string;
  readonly memo: string | null;
  readonly issuedAt: string;
  readonly balanceCents: string;
  readonly sourceDelegationId: string | null;
  readonly sourceName: string | null;
}

/**
 * A check the bank appears to have cashed, waiting to be confirmed.
 *
 * Computed on demand and never stored, so it disappears the moment it stops
 * being true — either because it was confirmed, or because the transaction was
 * categorized as something else.
 */
export interface CheckMatchDto {
  readonly checkId: string;
  readonly checkNumber: string;
  readonly memo: string | null;
  readonly checkBalanceCents: string;
  readonly sourceName: string | null;
  readonly transactionId: string;
  readonly description: string;
  readonly amountCents: string;
  readonly postedAt: string;
  readonly accountName: string;
}

export interface WriteCheckInput {
  readonly checkNumber: string;
  readonly amountCents: string;
  readonly issuedAt: string;
  readonly memo?: string;
  readonly sourceDelegationId: string;
}

export const checksApi = {
  list: () => api.get<{ checks: OutstandingCheckDto[] }>('/api/checks'),

  /** Proposals only. Nothing is settled until `match` is called. */
  matches: () => api.get<{ matches: CheckMatchDto[] }>('/api/checks/matches'),

  write: (input: WriteCheckInput) => api.post<{ check: OutstandingCheckDto }>('/api/checks', input),

  /** The check will never be cashed; the money goes back where it came from. */
  void: (id: string) => api.post<{ ok: boolean }>(`/api/checks/${id}/void`),

  /** Settles a check. The only thing that does, and only a person calls it. */
  match: (id: string, transactionId: string) =>
    api.post<{ checkId: string; transactionId: string; differenceCents: string }>(
      `/api/checks/${id}/match`,
      { transactionId },
    ),
};
