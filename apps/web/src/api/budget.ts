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
  /** Which Settings tab owns this row — ADR 021. `none` is an ordinary account. */
  readonly managedAs: 'none' | 'bitcoin' | 'property';
  /** Accounts only; a delegation is neither. */
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  /** The date the feed put on this balance; null for a manual account. */
  readonly feedBalanceAsOf: string | null;
  readonly stalenessIntervalDays: number | null;
  /**
   * How much of `balanceCents` was typed in by hand while this account's feed
   * was behind. `'0'` on every row when nothing is in standby.
   */
  readonly standbyCents: string;
  /** `check` rows are outstanding checks: money written but not yet cashed. */
  readonly kind: 'envelope' | 'check';
  readonly checkNumber: string | null;
  readonly checkMemo: string | null;
  readonly checkIssuedAt: string | null;
  /**
   * What this line is saving towards, and the server's reading of whether it
   * will get there. Null on most rows.
   *
   * The verdict is not recomputed here. Whether a line makes its date depends on
   * the pay cadence and on which day it is in the household's zone, and a second
   * copy of that arithmetic is a second answer waiting to disagree.
   */
  readonly target: TargetDto | null;
}

/** A calendar day, `2026-12-27` — never an instant. See ADR 037. */
export interface TargetDto {
  readonly targetCents: string;
  /** The occurrence being worked towards, not the anchor that was typed. */
  readonly targetDate: string | null;
  /** Months between occurrences. Null for a one-off. */
  readonly intervalMonths: number | null;
  readonly shortfallCents: string;
  readonly cyclesRemaining: number | null;
  readonly neededPerCycleCents: string | null;
  readonly status: 'met' | 'on_track' | 'behind' | 'standing';
}

export interface BudgetGroupingDto {
  readonly id: string;
  readonly name: string;
  /** Where it sits among the other groupings of its section. */
  readonly position: number;
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
  /** Null clears the target. Clearing the amount clears the date with it. */
  readonly targetCents?: string | null;
  /** `2026-12-27`. Null makes it a standing target: keep this much here. */
  readonly targetDate?: string | null;
  /** Months between occurrences. Null is a one-off deadline. */
  readonly targetIntervalMonths?: number | null;
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

  /** The same, for an account. Assets and Debts are ordered lists now too. */
  placeAccount: (id: string, groupingId: string | null, orderedIds: readonly string[]) =>
    api.post<{ ok: boolean }>(`/api/accounts/${id}/place`, { groupingId, orderedIds }),

  /**
   * The order of one section's groupings, whole.
   *
   * A section at a time: the three are independent lists that share a table, and
   * reordering Assets must not renumber Delegations underneath somebody.
   */
  reorderGroupings: (section: 'assets' | 'debts' | 'delegations', groupingIds: readonly string[]) =>
    api.post<{ ok: boolean }>('/api/groupings/reorder', { section, groupingIds }),

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
