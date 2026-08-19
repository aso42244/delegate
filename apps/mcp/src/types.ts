/**
 * The shapes Delegate returns, narrowed to what the tools actually read.
 *
 * Hand-written rather than imported from the API workspace on purpose: this is
 * a client of an HTTP contract, and a type that comes from the server's own
 * source would make a breaking change to that contract compile cleanly.
 */

export interface BudgetRowDto {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: string;
  readonly amountToDelegateCents: string | null;
  readonly isUtility: boolean;
  readonly notes: string | null;
  readonly type: string | null;
  readonly kind: string | null;
}

export interface BudgetGroupingDto {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: string;
  readonly amountToDelegateCents: string | null;
  readonly rows: readonly BudgetRowDto[];
}

export interface BudgetSectionDto {
  readonly section: string;
  readonly groupings: readonly BudgetGroupingDto[];
  readonly ungrouped: readonly BudgetRowDto[];
  readonly totalBalanceCents: string;
  readonly totalAmountToDelegateCents: string | null;
}

export interface BudgetDto {
  readonly assets: BudgetSectionDto;
  readonly debts: BudgetSectionDto;
  readonly delegations: BudgetSectionDto;
  readonly identity: {
    readonly assetsCents: string;
    readonly debtsCents: string;
    readonly delegationsCents: string;
    readonly pendingCents: string;
    readonly differenceCents: string;
    readonly toleranceCents: string;
    readonly status: string;
  };
  readonly cycleStartedAt: string | null;
}

export interface AccountDto {
  readonly id: string;
  readonly name: string;
  readonly nickname: string | null;
  readonly type: string;
  readonly source: string;
  readonly balanceCents: string;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: string | null;
  readonly bitcoinSats: string | null;
  readonly managedAs: string;
  readonly archivedAt: string | null;
}

export interface TransactionDto {
  readonly id: string;
  readonly postedAt: string;
  readonly amountCents: string;
  readonly description: string;
  readonly pending: boolean;
  readonly kind: string;
  readonly archivedAt: string | null;
  readonly account: { readonly id: string; readonly name: string; readonly type: string };
  readonly allocations: readonly {
    readonly delegationId: string;
    readonly amountCents: string;
    readonly delegation: { readonly id: string; readonly name: string } | null;
  }[];
}

export interface TransactionListDto {
  readonly transactions: readonly TransactionDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SpendingEntryDto {
  readonly key: string;
  readonly name: string;
  readonly spendCents: string;
}

export interface InsightsDto {
  readonly window: string;
  readonly asset_debt_composition: {
    readonly totalAssetsCents: string;
    readonly totalDebtsCents: string;
    readonly netCents: string;
  };
  readonly spending_by_grouping: {
    readonly since: string | null;
    readonly entries: readonly SpendingEntryDto[];
  };
  readonly spending_by_delegation: {
    readonly since: string | null;
    readonly entries: readonly SpendingEntryDto[];
  };
  readonly delegations_negative: readonly {
    readonly id: string;
    readonly name: string;
    readonly balanceCents: string;
  }[];
  readonly uncategorized_backlog: {
    readonly count: number;
    readonly oldestPostedAt: string | null;
  };
  readonly income_vs_spending: readonly {
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly incomeCents: string;
    readonly spendingCents: string;
    readonly surplusCents: string;
    readonly partial: boolean;
  }[];
}

export interface RuleDto {
  readonly id: string;
  readonly name: string | null;
  readonly matchMode: string;
  readonly matchValue: string;
  readonly delegationId: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly direction: string;
}

export interface AppInfoDto {
  readonly appName: string;
  readonly tokenScope: 'read' | 'read_write' | null;
}

export interface SyncStatusDto {
  readonly configured: boolean;
  readonly syncing: boolean;
  readonly failing: boolean;
  readonly lastSyncAt: string | null;
  readonly connectedAt: string | null;
  readonly credentialProblem: string | null;
}
