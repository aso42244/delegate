import type { PayCadence } from '@budget/shared';
import { api } from './client.js';

/** Settings → Budget, and the go-live Reconcile commit. Cents are strings — ADR 002. */

export interface BudgetSettingsDto {
  readonly undoWindowHours: number;
  readonly identityToleranceCents: string;
  /** Stamped by the first Reconcile commit, then never moved. */
  readonly goLiveAt: string | null;
  /** How often the household is paid. Divides the Utilities suggestion. */
  readonly payCadence: PayCadence;
  /** Payments a year at that cadence, resolved by the server. */
  readonly cyclesPerYear: number;
  /** Whether every account must have a second factor before it can be used. */
  readonly requireTotp: boolean;
  /** Whether a request over the onion address is answered at all. */
  readonly remoteOverTorEnabled: boolean;
  readonly remoteOverTorEnabledAt: string | null;
  /** Null until the Tor service has been started and made one. */
  readonly onionAddress: string | null;
}

export interface ReconcileResultDto {
  readonly batchId: string;
  readonly adjustedCount: number;
  readonly unchangedCount: number;
  readonly totalDeltaCents: string;
}

export interface ArchivedDto {
  readonly accounts: readonly {
    id: string;
    name: string;
    type: string;
    archivedAt: string | null;
  }[];
  readonly delegations: readonly { id: string; name: string; archivedAt: string | null }[];
  readonly groupings: readonly {
    id: string;
    name: string;
    section: string;
    archivedAt: string | null;
  }[];
}

export const archivedApi = {
  list: () => api.get<ArchivedDto>('/api/archived'),
};

export const settingsApi = {
  get: () => api.get<BudgetSettingsDto>('/api/settings'),

  update: (input: {
    undoWindowHours?: number;
    identityToleranceCents?: string;
    payCadence?: PayCadence;
    requireTotp?: boolean;
    remoteOverTorEnabled?: boolean;
  }) => api.patch<BudgetSettingsDto>('/api/settings', input),

  /** Every correction in one commit, sharing a batch. Not sixty separate writes. */
  reconcile: (lines: readonly { delegationId: string; actualBalanceCents: string }[]) =>
    api.post<ReconcileResultDto>('/api/budget/reconcile', { lines }),
};
