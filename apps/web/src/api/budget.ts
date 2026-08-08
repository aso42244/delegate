import { api } from './client.js';

/**
 * The Main Budget page's data.
 *
 * Every amount arrives as a decimal string of cents and is parsed to `bigint`
 * here, once, at the boundary. Nothing downstream sees a `number` — ADR 002.
 */

export interface BudgetRowDto {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: string;
  readonly amountToDelegateCents: string | null;
  readonly groupingId: string | null;
  readonly isUtility: boolean;
  readonly notes: string | null;
  readonly source: string | null;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
}

export interface BudgetGroupingDto {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly collapsed: boolean;
  readonly balanceCents: string;
  readonly amountToDelegateCents: string | null;
  readonly rows: readonly BudgetRowDto[];
}

export interface BudgetSectionDto {
  readonly section: 'assets' | 'debts' | 'delegations';
  readonly groupings: readonly BudgetGroupingDto[];
  readonly ungrouped: readonly BudgetRowDto[];
  readonly totalBalanceCents: string;
  readonly totalAmountToDelegateCents: string | null;
}

export type IdentityStatus = 'to_delegate' | 'balanced' | 'over_delegated';

export interface BudgetViewDto {
  readonly assets: BudgetSectionDto;
  readonly debts: BudgetSectionDto;
  readonly delegations: BudgetSectionDto;
  readonly identity: {
    readonly assetsCents: string;
    readonly debtsCents: string;
    readonly delegationsCents: string;
    readonly differenceCents: string;
    readonly toleranceCents: string;
    readonly status: IdentityStatus;
  };
  readonly cycleStartedAt: string | null;
}

export interface DelegatePreviewDto {
  readonly totalCents: string;
  readonly lineCount: number;
}

export interface UndoPreviewDto {
  readonly available: boolean;
  readonly runId?: string;
  readonly totalCents?: string;
  readonly lineCount?: number;
  readonly expiresAt?: string | null;
  readonly cycleStartAfterUndo?: string | null;
}

export const budgetApi = {
  view: () => api.get<BudgetViewDto>('/api/budget'),

  createDelegation: (name: string, amountToDelegateCents: string | null) =>
    api.post<{ delegation: { id: string } }>('/api/delegations', {
      name,
      amountToDelegateCents,
    }),

  updateDelegation: (
    id: string,
    input: { name?: string; amountToDelegateCents?: string | null; groupingId?: string | null },
  ) => api.patch<{ ok: boolean }>(`/api/delegations/${id}`, input),

  /** Sends the target; the server records the difference as an `adjust` delta. */
  adjustDelegation: (id: string, targetBalanceCents: string) =>
    api.post<{ balanceCents: string }>(`/api/delegations/${id}/adjust`, { targetBalanceCents }),

  createGrouping: (name: string, section: 'assets' | 'debts' | 'delegations') =>
    api.post<{ grouping: { id: string } }>('/api/groupings', { name, section }),

  setGroupingCollapsed: (id: string, collapsed: boolean) =>
    api.patch<{ ok: boolean }>(`/api/groupings/${id}`, { collapsed }),

  delegatePreview: () => api.get<DelegatePreviewDto>('/api/budget/delegate/preview'),
  delegate: () => api.post<{ runId: string; lineCount: number }>('/api/budget/delegate'),
  undoPreview: () => api.get<UndoPreviewDto>('/api/budget/delegate/undo-preview'),
  undoDelegate: (runId: string) =>
    api.post<{ reversedCount: number }>(`/api/budget/delegate/${runId}/undo`),

  transfer: (fromDelegationId: string, toDelegationId: string, amountCents: string) =>
    api.post<{ transferId: string }>('/api/budget/transfer', {
      fromDelegationId,
      toDelegationId,
      amountCents,
    }),
};
