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

/**
 * The curated palette a grouping colour is chosen from.
 *
 * A fixed list rather than a colour picker, and deliberately: §11 asks that
 * grouping colour "must not be in your face", and an arbitrary picker is how a
 * dense financial table ends up with a magenta row. Every delegation inside a
 * grouping inherits its colour — there is no per-delegation colour.
 */
export const GROUPING_COLORS = [
  { value: '#46A171', name: 'Green' },
  { value: '#2783DE', name: 'Blue' },
  { value: '#D5803B', name: 'Orange' },
  { value: '#8B63B8', name: 'Purple' },
  { value: '#7D7A75', name: 'Grey' },
] as const;

export type GroupingColor = (typeof GROUPING_COLORS)[number]['value'];

export function isGroupingColor(value: string): value is GroupingColor {
  return GROUPING_COLORS.some((color) => color.value === value);
}

/**
 * Any `#RRGGBB`, not only the five presets.
 *
 * The presets are a starting point rather than the whole vocabulary — someone
 * matching a grouping to a colour they already think in should not have to pick
 * the nearest of five. The format is fixed because the tint below reads the
 * three channels out of it by position; three-digit shorthand and named colours
 * are refused rather than guessed at.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Upper-cased so two spellings of one colour compare equal. */
export function normalizeHexColor(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The row tint for a grouping colour, as an `rgb()` with alpha.
 *
 * Faint on purpose. The grouping header takes a soft tint and its children an
 * even fainter one, so near-black text keeps well past the 4.5:1 the design
 * requires — at these alphas over white the ratio stays above 10:1, which is the
 * point of expressing colour as a tint rather than a fill.
 */
export function groupingTint(color: string | null, depth: 'header' | 'row'): string | undefined {
  // Any valid hex, not only a preset: the palette is a shortcut, not a limit.
  if (color === null || !isHexColor(color)) return undefined;

  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const alpha = depth === 'header' ? 0.1 : 0.04;

  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

/**
 * How an Insights tile may be drawn.
 *
 * Per widget, because which charts suit which data is a fact about the widget:
 * a ranked breakdown reads as bars or as a donut, and neither of those says
 * anything useful about a single number. The first entry is the default.
 *
 * Shared so the server can validate a stored choice without knowing how any of
 * it is drawn.
 */
export const INSIGHT_DISPLAYS = {
  asset_debt_composition: ['list', 'donut'],
  spending_by_grouping: ['bars', 'donut'],
  spending_by_delegation: ['bars', 'donut'],
  income_vs_spending: ['list', 'bars'],
  cycle_surplus: ['list', 'bars'],
  net_worth_over_time: ['line', 'area', 'bars'],
  credit_card_trend: ['line', 'area', 'bars'],
  home_equity_over_time: ['line', 'area', 'bars'],

  // One shape each, deliberately. A donut of a single number says nothing, and
  // a list of two figures per row is already the clearest form it has. An
  // option that made a tile worse would not be a choice worth offering.
  delegations_negative: ['list'],
  uncategorized_backlog: ['number'],
  utilities_vs_delegated: ['list'],
  bitcoin_value_over_time: ['number'],
} as const satisfies Record<string, readonly string[]>;

export type InsightWidgetKey = keyof typeof INSIGHT_DISPLAYS;
export type InsightDisplay = (typeof INSIGHT_DISPLAYS)[InsightWidgetKey][number];

/** The display a tile uses when nothing has been chosen. */
export function defaultInsightDisplay(widget: InsightWidgetKey): InsightDisplay {
  return INSIGHT_DISPLAYS[widget][0];
}

/** Whether this widget can be drawn that way. An unknown pair is refused. */
export function isInsightDisplay(widget: string, display: string): boolean {
  const options: readonly string[] | undefined = INSIGHT_DISPLAYS[widget as InsightWidgetKey];
  return options !== undefined && options.includes(display);
}
