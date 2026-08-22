import { api } from './client.js';

/**
 * The Budget page's data.
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
  /** Accounts only; null for a delegation, which is neither. */
  readonly type: 'asset' | 'debt' | null;
  /** Accounts only; a delegation is neither. */
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
  /** `check` rows are outstanding checks: money written but not yet cashed. */
  readonly kind: 'envelope' | 'check';
  readonly checkNumber: string | null;
  readonly checkMemo: string | null;
  readonly checkIssuedAt: string | null;
}

export interface BudgetGroupingDto {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly collapsed: boolean;
  /** Set on groupings the budget owns; only "outstanding-checks" today. */
  readonly systemKey: string | null;
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
    /** Categorized pending spend the account balances have not caught up with. */
    readonly pendingCents: string;
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

export type DelegationEventType = 'delegate' | 'categorize' | 'transfer' | 'adjust';

export interface DelegationEventDto {
  readonly id: string;
  readonly deltaCents: string;
  readonly eventType: DelegationEventType;
  readonly occurredAt: string;
  readonly reversedAt: string | null;
  readonly batchId: string | null;
  readonly actor: { readonly id: string; readonly username: string } | null;
}

export interface UpdateDelegationInput {
  readonly name?: string;
  readonly amountToDelegateCents?: string | null;
  readonly groupingId?: string | null;
  readonly isUtility?: boolean;
  readonly notes?: string | null;
}

export const budgetApi = {
  /**
   * Moves the reading at the top of the page into or out of one line.
   *
   * No amount for `all` or `zero_line`: the server works those out from the
   * identity as it stands when the request lands, so "all of it" cannot go
   * stale between the page rendering and the button being pressed.
   */
  absorb: (id: string, mode: 'all' | 'zero_line' | 'custom', amountCents?: string) =>
    api.post<{ deltaCents: string; balanceCents: string; differenceCents: string }>(
      `/api/delegations/${id}/absorb`,
      amountCents === undefined ? { mode } : { mode, amountCents },
    ),

  /**
   * Where a line sits, and which grouping it is in — one request, because
   * dragging a row does both. `orderedIds` is the destination grouping's full
   * membership afterwards, in order.
   */
  place: (id: string, groupingId: string | null, orderedIds: readonly string[]) =>
    api.post<BudgetViewDto>(`/api/delegations/${id}/place`, { groupingId, orderedIds }),

  view: () => api.get<BudgetViewDto>('/api/budget'),

  createDelegation: (name: string, amountToDelegateCents: string | null) =>
    api.post<{ delegation: { id: string } }>('/api/delegations', {
      name,
      amountToDelegateCents,
    }),

  updateDelegation: (id: string, input: UpdateDelegationInput) =>
    api.patch<{ ok: boolean }>(`/api/delegations/${id}`, input),

  /** Sends the target; the server records the difference as an `adjust` delta. */
  adjustDelegation: (id: string, targetBalanceCents: string) =>
    api.post<{ balanceCents: string }>(`/api/delegations/${id}/adjust`, { targetBalanceCents }),

  /**
   * Sends the movement itself. "Manually adjust this line" is a delta by
   * definition — the owner thinks "put another $25 in", not "make it $675".
   */
  adjustDelegationByDelta: (id: string, deltaCents: string) =>
    api.post<{ balanceCents: string }>(`/api/delegations/${id}/adjust`, { deltaCents }),

  archiveDelegation: (id: string) => api.post<{ ok: boolean }>(`/api/delegations/${id}/archive`),

  restoreDelegation: (id: string) => api.post<{ ok: boolean }>(`/api/delegations/${id}/restore`),

  /** Per-line history. The only place `adjust` events are ever visible. */
  delegationHistory: (id: string) =>
    api.get<{ events: readonly DelegationEventDto[] }>(`/api/delegations/${id}/history`),

  createGrouping: (name: string, section: 'assets' | 'debts' | 'delegations') =>
    api.post<{ grouping: { id: string } }>('/api/groupings', { name, section }),

  updateGrouping: (id: string, input: { name?: string; color?: string | null }) =>
    api.patch<{ ok: boolean }>(`/api/groupings/${id}`, input),

  setGroupingCollapsed: (id: string, collapsed: boolean) =>
    api.patch<{ ok: boolean }>(`/api/groupings/${id}`, { collapsed }),

  archiveGrouping: (id: string) => api.post<{ ok: boolean }>(`/api/groupings/${id}/archive`),

  restoreGrouping: (id: string) => api.post<{ ok: boolean }>(`/api/groupings/${id}/restore`),

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
