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

export interface WriteCheckInput {
  readonly checkNumber: string;
  readonly amountCents: string;
  readonly issuedAt: string;
  readonly memo?: string;
  readonly sourceDelegationId: string;
}

export const checksApi = {
  list: () => api.get<{ checks: OutstandingCheckDto[] }>('/api/checks'),

  write: (input: WriteCheckInput) => api.post<{ check: OutstandingCheckDto }>('/api/checks', input),

  /** The check will never be cashed; the money goes back where it came from. */
  void: (id: string) => api.post<{ ok: boolean }>(`/api/checks/${id}/void`),

  /** The manual path, when the automatic match could not resolve one. */
  match: (id: string, transactionId: string) =>
    api.post<{ checkId: string; transactionId: string; differenceCents: string }>(
      `/api/checks/${id}/match`,
      { transactionId },
    ),
};
