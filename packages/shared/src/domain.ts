/**
 * Domain vocabulary shared by the API and the UI.
 *
 * These string unions mirror the Prisma enums exactly. They live here so the
 * frontend never imports the Prisma client, and so a rename is a compile error
 * on both sides rather than a runtime surprise.
 */

export const ACCOUNT_TYPES = ['asset', 'debt'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SOURCES = ['simplefin', 'manual'] as const;
export type AccountSource = (typeof ACCOUNT_SOURCES)[number];

export const GROUPING_SECTIONS = ['assets', 'debts', 'delegations'] as const;
export type GroupingSection = (typeof GROUPING_SECTIONS)[number];

/**
 * `adjust` events are deliberately excluded from every spending calculation
 * and never appear on the Transactions page — the journal exists for
 * categorization, not auditing. They are visible only in per-line history.
 */
export const DELEGATION_EVENT_TYPES = ['delegate', 'categorize', 'transfer', 'adjust'] as const;
export type DelegationEventType = (typeof DELEGATION_EVENT_TYPES)[number];

export const TRANSACTION_KINDS = ['normal', 'income', 'transfer'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const RULE_MATCH_MODES = ['contains', 'starts_with', 'regex'] as const;
export type RuleMatchMode = (typeof RULE_MATCH_MODES)[number];

export const RULE_DIRECTIONS = ['any', 'debit', 'credit'] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

export const USER_ROLES = ['user', 'admin', 'super_admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

/**
 * The whole permission model: only user management is gated, and the Super
 * Admin cannot be modified by anyone else. There is no permission matrix.
 */
export function canManageUsers(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function canModifyUser(actorRole: UserRole, targetRole: UserRole): boolean {
  if (!canManageUsers(actorRole)) return false;
  if (targetRole === 'super_admin') return actorRole === 'super_admin';
  return true;
}

/** An account is stale when its confirmed balance has aged past its own interval. */
export function isBalanceStale(
  balanceAsOf: Date | null,
  stalenessIntervalDays: number | null,
  now: Date = new Date(),
): boolean {
  if (stalenessIntervalDays === null || balanceAsOf === null) return false;
  const elapsedMs = now.getTime() - balanceAsOf.getTime();
  return elapsedMs > stalenessIntervalDays * 24 * 60 * 60 * 1000;
}

/**
 * The Utilities page suggestion: a monthly average spread over 26 biweekly
 * cycles a year. Rounded to the nearest cent; it is advice, never auto-written.
 */
export function suggestedPerCycleCents(monthlyAverageCents: bigint): bigint {
  const numerator = monthlyAverageCents * 12n;
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  // Round half away from zero: floor((|n| + 13) / 26).
  return sign * ((magnitude + 13n) / 26n);
}

export const CYCLES_PER_YEAR = 26;
