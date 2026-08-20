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

/**
 * Who may change household-wide settings.
 *
 * The same answer as user management, deliberately, rather than a second role
 * dimension to keep in step. What these settings control is not cosmetic: one of
 * them decides whether two-factor authentication is required of everyone, and
 * another decides whether the budget answers requests arriving from outside the
 * house. An ordinary account being able to switch either off would make the
 * strongest protections here worth exactly as much as the weakest session.
 */
export function canManageSettings(role: UserRole): boolean {
  return canManageUsers(role);
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
 * How often the household is paid.
 *
 * A cycle in this system is one Delegate press to the next, and nothing
 * schedules it — the owner presses it when the money lands. So this does not
 * make Delegate run itself. It is the divisor: it says how many of those
 * presses a year is, which is what turns a monthly average into a per-paycheck
 * figure on the Utilities page.
 *
 * "Twice a month" covers both the 1st-and-15th pattern and the
 * 15th-and-last-day one. They are the same 24 payments a year, and naming it by
 * a pair of dates would make half of the households it fits think it did not.
 */
export const PAY_CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export type PayCadence = (typeof PAY_CADENCES)[number];

export const DEFAULT_PAY_CADENCE: PayCadence = 'biweekly';

/** Payments a year, which is the only thing the arithmetic needs. */
export const CYCLES_PER_YEAR: Record<PayCadence, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/**
 * How each one is written on screen.
 *
 * The count is part of the label rather than a footnote. "Biweekly" is
 * genuinely ambiguous in English — it is used for both twice a week and every
 * two weeks — and a household picking the wrong one gets a suggestion that is
 * out by a factor of four with nothing on screen to reveal it.
 */
export const PAY_CADENCE_LABELS: Record<PayCadence, string> = {
  weekly: 'Weekly — 52 a year',
  biweekly: 'Every two weeks — 26 a year',
  semimonthly: 'Twice a month — 24 a year',
  monthly: 'Monthly — 12 a year',
};

export function isPayCadence(value: string): value is PayCadence {
  return (PAY_CADENCES as readonly string[]).includes(value);
}

/**
 * The Utilities page suggestion: a monthly average spread over a year's
 * paychecks. Advice, never auto-written.
 *
 * Integer throughout, and rounded half away from zero. The doubling is what
 * lets that rounding stay exact for an odd number of cycles as well as an even
 * one — `+ cycles` over `2 * cycles` is "+ a half", without ever forming a
 * half.
 */
export function suggestedPerCycleCents(monthlyAverageCents: bigint, cyclesPerYear: number): bigint {
  const cycles = BigInt(cyclesPerYear);
  const numerator = monthlyAverageCents * 12n * 2n;
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  return sign * ((magnitude + cycles) / (cycles * 2n));
}

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
  bitcoin_value_over_time: ['line', 'area', 'bars'],

  // One shape each, deliberately. A donut of a single number says nothing, and
  // a list of two figures per row is already the clearest form it has. An
  // option that made a tile worse would not be a choice worth offering.
  delegations_negative: ['list'],
  uncategorized_backlog: ['number'],
  utilities_vs_delegated: ['list'],
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
