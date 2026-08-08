import { api } from './client.js';

/** Settings → Budget, and the go-live Reconcile commit. Cents are strings — ADR 002. */

export interface BudgetSettingsDto {
  readonly undoWindowHours: number;
  readonly identityToleranceCents: string;
  /** Stamped by the first Reconcile commit, then never moved. */
  readonly goLiveAt: string | null;
}

export interface ReconcileResultDto {
  readonly batchId: string;
  readonly adjustedCount: number;
  readonly unchangedCount: number;
  readonly totalDeltaCents: string;
}

export const settingsApi = {
  get: () => api.get<BudgetSettingsDto>('/api/settings'),

  update: (input: { undoWindowHours?: number; identityToleranceCents?: string }) =>
    api.patch<BudgetSettingsDto>('/api/settings', input),

  /** Every correction in one commit, sharing a batch. Not sixty separate writes. */
  reconcile: (lines: readonly { delegationId: string; actualBalanceCents: string }[]) =>
    api.post<ReconcileResultDto>('/api/budget/reconcile', { lines }),
};
