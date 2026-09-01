import {
  suggestedMatchValue,
  type RuleDirection,
  type RuleMatchMode,
  type TransactionKind,
} from '@budget/shared';
import type { Db } from '../db/client.js';
import { categorizeTransaction } from './allocations.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { updateTransaction } from './transactions.js';

/**
 * Auto-categorization rules.
 *
 * Rules are ordered by priority and the first match wins — no scoring, no
 * combining. The owner needs to be able to look at a mis-categorized transaction
 * and know exactly which rule did it, which a "best match" scheme makes
 * impossible to reason about.
 *
 * A rule does one of two things. It **categorizes** — assigns a delegation — or
 * it **labels**: says the transaction is income, or a transfer between owned
 * accounts, both of which allocate to nothing by definition. Exactly one, held
 * by a check constraint rather than by convention.
 *
 * Labelling exists because the most predictable transaction a household has was
 * the one thing rules could not touch. A paycheck arrives from the same payer on
 * the same fortnight and lands as ordinary spending, so somebody marked it
 * income by hand, every fortnight, for ever.
 *
 * They are applied on import, and on demand to the existing backlog, which is
 * what makes categorizing months of history before go-live tractable at all.
 */

/**
 * A regex from the UI runs against every transaction in the backlog, and a
 * pathological pattern like `(a+)+$` backtracks forever — taking the whole
 * single-process application down with it, since Node has no way to interrupt a
 * running regex.
 *
 * Patterns are therefore length-bounded, compiled once up front so a broken one
 * fails at save time rather than mid-run, and matched against a truncated
 * description to bound the input as well.
 */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_MATCHED_DESCRIPTION_LENGTH = 500;

/** Rejects nested unbounded quantifiers, the classic catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\)|\[[^\]]*\][^)]*)[+*]/;

export interface RuleMatcher {
  readonly matchMode: RuleMatchMode;
  readonly matchValue: string;
  readonly amountMinCents?: bigint | null;
  readonly amountMaxCents?: bigint | null;
  readonly accountId?: string | null;
  readonly direction?: RuleDirection;
}

export interface MatchableTransaction {
  readonly description: string;
  readonly descriptionRaw: string;
  readonly amountCents: bigint;
  readonly accountId: string;
}

export function assertPatternAcceptable(matchMode: RuleMatchMode, matchValue: string): void {
  if (matchValue.trim() === '') {
    throw new ValidationError('empty_match_value', 'A rule needs something to match on.');
  }
  if (matchValue.length > MAX_PATTERN_LENGTH) {
    throw new ValidationError(
      'match_value_too_long',
      `A match value must be at most ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  if (matchMode !== 'regex') return;

  if (NESTED_QUANTIFIER.test(matchValue)) {
    throw new ValidationError(
      'unsafe_pattern',
      'That pattern nests repeats (for example "(a+)+"), which can hang while matching. Rewrite it more simply, or use "contains".',
    );
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(matchValue, 'i');
  } catch {
    throw new ValidationError('invalid_pattern', 'That is not a valid regular expression.');
  }

  assertNotCatastrophic(pattern);
}

/**
 * The work a pattern may do against hostile input before it is refused.
 *
 * A sane pattern finishes every rung of the ladder below in microseconds; a
 * catastrophic one blows past this on one of them. Twenty-five milliseconds is
 * far above the first and far below the second, so a slow machine cannot move a
 * pattern from one class to the other.
 */
const BACKTRACK_BUDGET_MS = 25;

/**
 * Input lengths to try, shortest first.
 *
 * Escalating rather than one long string, and this is the whole trick. Measuring
 * catastrophic backtracking means *causing* it, and a single 120-character probe
 * against `(a|a)+$` takes three and a half minutes — the check would be a worse
 * denial of service than the pattern it was looking for. Climbing and stopping
 * at the budget bounds the damage to roughly one rung's overshoot, while still
 * reaching lengths where slower-growing patterns like `(a|aa)+$` show
 * themselves.
 */
const PROBE_LENGTHS = [14, 18, 22, 26, 30, 34, 38] as const;

/**
 * Refuses a pattern that backtracks catastrophically, by timing it rather than
 * reading it.
 *
 * The shape check above catches `(a+)+` and its relatives, and it is worth
 * keeping because it explains itself in the refusal. But it is a heuristic over
 * syntax, and plenty of catastrophic patterns do not have that shape:
 * `(a|a)+$` is the standard counter-example — no nested quantifier, and still
 * exponential. Deciding this by reading a pattern is the sort of question that
 * wants a non-backtracking engine like RE2; asking the engine is what can be
 * done without one.
 *
 * A regex cannot be interrupted once it starts. It blocks the whole process,
 * which is exactly the danger, so this runs at save time — where the worst case
 * is a slow save by the person who was about to hang every sync from then on.
 */
function assertNotCatastrophic(pattern: RegExp): void {
  let spentMs = 0;

  for (const length of PROBE_LENGTHS) {
    // A run of one character then something that cannot match: the shape that
    // makes a backtracking engine try every partition of the run.
    const input = `${'a'.repeat(length)}!`;

    const started = process.hrtime.bigint();
    pattern.test(input);
    spentMs += Number(process.hrtime.bigint() - started) / 1e6;

    if (spentMs > BACKTRACK_BUDGET_MS) {
      throw new ValidationError(
        'unsafe_pattern',
        'That pattern takes far too long to match against ordinary text — it would hang the next sync. Rewrite it more simply, or use "contains".',
      );
    }
  }
}

/**
 * Matches against both the cleaned description and the raw feed text.
 *
 * Feeds rewrite descriptions between the pending and posted versions of the same
 * purchase, so a rule written against one form would stop firing on the other.
 */
export function ruleMatches(rule: RuleMatcher, transaction: MatchableTransaction): boolean {
  if (rule.accountId && rule.accountId !== transaction.accountId) return false;

  const direction = rule.direction ?? 'any';
  if (direction === 'debit' && transaction.amountCents >= 0n) return false;
  if (direction === 'credit' && transaction.amountCents <= 0n) return false;

  // Ranges compare magnitude: the owner thinks in "between $20 and $50", not in
  // signed cents, and spending is negative.
  const magnitude =
    transaction.amountCents < 0n ? -transaction.amountCents : transaction.amountCents;
  if (rule.amountMinCents != null && magnitude < rule.amountMinCents) return false;
  if (rule.amountMaxCents != null && magnitude > rule.amountMaxCents) return false;

  const candidates = [transaction.description, transaction.descriptionRaw].map((text) =>
    text.slice(0, MAX_MATCHED_DESCRIPTION_LENGTH).toLowerCase(),
  );
  const needle = rule.matchValue.toLowerCase();

  switch (rule.matchMode) {
    case 'contains':
      return candidates.some((text) => text.includes(needle));
    case 'starts_with':
      return candidates.some((text) => text.startsWith(needle));
    case 'regex': {
      // Compiled per call rather than cached: a rule's pattern can change, and a
      // stale compiled copy would silently apply the old one.
      const pattern = new RegExp(rule.matchValue, 'i');
      return candidates.some((text) => pattern.test(text));
    }
  }
}

export interface RuleRow extends RuleMatcher {
  readonly id: string;
  /** Set on a categorizing rule; null on a labelling one. Never both, never neither. */
  readonly delegationId: string | null;
  readonly setKind: TransactionKind | null;
  readonly priority: number;
}

/** Live rules, in the order they are evaluated. */
export async function listActiveRules(db: Db): Promise<RuleRow[]> {
  return db.categorizationRule.findMany({
    where: { archivedAt: null, enabled: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      priority: true,
      matchMode: true,
      matchValue: true,
      amountMinCents: true,
      amountMaxCents: true,
      accountId: true,
      direction: true,
      delegationId: true,
      setKind: true,
    },
  });
}

/** First match wins. Returns the rule that fired, or null. */
export function findMatchingRule(
  rules: readonly RuleRow[],
  transaction: MatchableTransaction,
): RuleRow | null {
  for (const rule of rules) {
    if (ruleMatches(rule, transaction)) return rule;
  }
  return null;
}

export interface ApplyRulesOptions {
  readonly actorId?: string | null;
  /** Restricts to specific transactions. Sync passes the rows it just imported. */
  readonly transactionIds?: readonly string[];
  /**
   * Re-categorizes transactions that already have allocations. Off by default:
   * bulk-applying rules must never silently overwrite a decision made by hand.
   */
  readonly includeCategorized?: boolean;
}

export interface ApplyRulesResult {
  readonly examined: number;
  readonly categorized: number;
  /** Rows a labelling rule marked as income or a transfer. */
  readonly labelled: number;
}

/**
 * Applies the rule set to transactions.
 *
 * By default only uncategorized, unarchived, spending transactions are touched.
 * Income and confirmed transfers allocate to nothing by definition, and an
 * already-categorized row represents a human decision that a bulk action has no
 * business overwriting.
 *
 * **A labelling rule never touches a categorized row**, even with
 * `includeCategorized` on. Re-labelling one would mean destroying the
 * allocations underneath it, which `updateTransaction` refuses for a single row
 * — and a bulk action must not do what the same action refuses one at a time.
 */
export async function applyRules(
  db: Db,
  options: ApplyRulesOptions = {},
): Promise<ApplyRulesResult> {
  const rules = await listActiveRules(db);
  if (rules.length === 0) return { examined: 0, categorized: 0, labelled: 0 };

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      ...(options.transactionIds ? { id: { in: [...options.transactionIds] } } : {}),
      ...(options.includeCategorized ? {} : { allocations: { none: {} } }),
    },
    select: {
      id: true,
      description: true,
      descriptionRaw: true,
      amountCents: true,
      accountId: true,
      _count: { select: { allocations: true } },
    },
    orderBy: { postedAt: 'asc' },
  });

  let categorized = 0;
  let labelled = 0;

  for (const transaction of transactions) {
    const rule = findMatchingRule(rules, transaction);
    if (!rule) continue;

    if (rule.setKind) {
      if (transaction._count.allocations > 0) continue;
      await updateTransaction(db, transaction.id, { kind: rule.setKind });
      labelled += 1;
      continue;
    }
    if (!rule.delegationId) continue;

    // categorizeTransaction writes the allocation and its ledger event in one
    // database transaction, so a failure part-way cannot leave an envelope moved
    // without an allocation to explain it.
    await categorizeTransaction(db, transaction.id, rule.delegationId, {
      actorId: options.actorId ?? null,
    });
    categorized += 1;
  }

  return { examined: transactions.length, categorized, labelled };
}

/**
 * Counts what `applyRules` would do, without doing it.
 *
 * The bulk action is presented with a preview because it can move hundreds of
 * envelope balances at once, and "1 of 423" is a very different decision from
 * "397 of 423".
 */
export async function previewRules(
  db: Db,
  options: Pick<ApplyRulesOptions, 'includeCategorized'> = {},
): Promise<ApplyRulesResult> {
  const rules = await listActiveRules(db);
  if (rules.length === 0) return { examined: 0, categorized: 0, labelled: 0 };

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      ...(options.includeCategorized ? {} : { allocations: { none: {} } }),
    },
    select: {
      description: true,
      descriptionRaw: true,
      amountCents: true,
      accountId: true,
      _count: { select: { allocations: true } },
    },
  });

  let categorized = 0;
  let labelled = 0;

  // The same two branches as the apply, in the same order, because a preview
  // that counts by a different rule than the run is worse than no preview.
  for (const transaction of transactions) {
    const rule = findMatchingRule(rules, transaction);
    if (!rule) continue;
    if (rule.setKind) {
      if (transaction._count.allocations === 0) labelled += 1;
      continue;
    }
    if (rule.delegationId) categorized += 1;
  }

  return { examined: transactions.length, categorized, labelled };
}

/**
 * `| undefined` throughout because `exactOptionalPropertyTypes` is on: a parsed
 * request body has the keys present and set to undefined, which a bare optional
 * would reject.
 */
export interface CreateRuleInput {
  readonly name?: string | null | undefined;
  readonly matchMode: RuleMatchMode;
  readonly matchValue: string;
  /** Exactly one of these two. See `assertOneAction`. */
  readonly delegationId?: string | null | undefined;
  readonly setKind?: TransactionKind | null | undefined;
  readonly priority?: number | undefined;
  readonly amountMinCents?: bigint | null | undefined;
  readonly amountMaxCents?: bigint | null | undefined;
  readonly accountId?: string | null | undefined;
  readonly direction?: RuleDirection | undefined;
  readonly enabled?: boolean | undefined;
}

async function assertDelegationUsable(db: Db, delegationId: string): Promise<void> {
  const delegation = await db.delegation.findUnique({
    where: { id: delegationId },
    select: { archivedAt: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', delegationId);
  if (delegation.archivedAt) {
    throw new ConflictError(
      'delegation_archived',
      'That delegation is archived, so a rule cannot assign new spending to it.',
    );
  }
}

/**
 * A rule categorizes or it labels, and it has to do exactly one.
 *
 * Both would categorize a row the domain forbids allocations on; neither would
 * match and then do nothing, which is the worst of the three because it looks
 * like it works. `normal` is refused for the same reason: only `normal` rows are
 * examined, so a rule labelling one `normal` fires and changes nothing.
 *
 * The database holds this too. This is here so the refusal says why.
 */
function assertOneAction(
  delegationId: string | null | undefined,
  setKind: TransactionKind | null | undefined,
): void {
  if (delegationId && setKind) {
    throw new ValidationError(
      'rule_has_two_actions',
      'A rule either categorizes a transaction or says what it is, not both.',
    );
  }
  if (!delegationId && !setKind) {
    throw new ValidationError(
      'rule_has_no_action',
      'A rule needs a delegation to categorize into, or a label to apply.',
    );
  }
  if (setKind === 'normal') {
    throw new ValidationError(
      'rule_labels_normal',
      'Rules only ever see ordinary spending, so labelling a transaction ordinary would do nothing.',
    );
  }
}

function assertRangeSane(min: bigint | null | undefined, max: bigint | null | undefined): void {
  if (min != null && max != null && min > max) {
    throw new ValidationError(
      'invalid_amount_range',
      'The minimum amount is greater than the maximum, so the rule could never match.',
    );
  }
}

export async function createRule(db: Db, input: CreateRuleInput): Promise<{ id: string }> {
  assertPatternAcceptable(input.matchMode, input.matchValue);
  assertRangeSane(input.amountMinCents, input.amountMaxCents);
  assertOneAction(input.delegationId, input.setKind);
  if (input.delegationId) await assertDelegationUsable(db, input.delegationId);

  // New rules land at the end unless placed explicitly, so adding one cannot
  // change what an existing rule already does.
  const priority =
    input.priority ??
    ((
      await db.categorizationRule.aggregate({
        where: { archivedAt: null },
        _max: { priority: true },
      })
    )._max.priority ?? 0) + 10;

  return db.categorizationRule.create({
    data: {
      name: input.name ?? null,
      matchMode: input.matchMode,
      matchValue: input.matchValue,
      delegationId: input.delegationId ?? null,
      setKind: input.setKind ?? null,
      priority,
      amountMinCents: input.amountMinCents ?? null,
      amountMaxCents: input.amountMaxCents ?? null,
      accountId: input.accountId ?? null,
      direction: input.direction ?? 'any',
      enabled: input.enabled ?? true,
    },
    select: { id: true },
  });
}

/**
 * Spelled out rather than `Partial<CreateRuleInput>`: `Partial` marks a property
 * optional without admitting an explicit `undefined`, which is exactly what a
 * parsed request body contains.
 */
export interface UpdateRuleInput {
  readonly name?: string | null | undefined;
  readonly matchMode?: RuleMatchMode | undefined;
  readonly matchValue?: string | undefined;
  readonly delegationId?: string | null | undefined;
  readonly setKind?: TransactionKind | null | undefined;
  readonly priority?: number | undefined;
  readonly amountMinCents?: bigint | null | undefined;
  readonly amountMaxCents?: bigint | null | undefined;
  readonly accountId?: string | null | undefined;
  readonly direction?: RuleDirection | undefined;
  readonly enabled?: boolean | undefined;
}

export async function updateRule(db: Db, id: string, input: UpdateRuleInput): Promise<void> {
  const existing = await db.categorizationRule.findUnique({
    where: { id },
    select: {
      matchMode: true,
      matchValue: true,
      amountMinCents: true,
      amountMaxCents: true,
      delegationId: true,
      setKind: true,
    },
  });
  if (!existing) throw new NotFoundError('Rule', id);

  const matchMode = input.matchMode ?? existing.matchMode;
  const matchValue = input.matchValue ?? existing.matchValue;
  assertPatternAcceptable(matchMode, matchValue);
  assertRangeSane(
    input.amountMinCents === undefined ? existing.amountMinCents : input.amountMinCents,
    input.amountMaxCents === undefined ? existing.amountMaxCents : input.amountMaxCents,
  );

  /*
   * The action is checked as the pair it will be, not as the field that
   * arrived. Switching a rule from a delegation to a label sends one key and
   * clears the other, and validating either in isolation would refuse the only
   * request that is actually correct.
   */
  const delegationId =
    input.delegationId === undefined ? existing.delegationId : input.delegationId;
  const setKind = input.setKind === undefined ? existing.setKind : input.setKind;
  assertOneAction(delegationId, setKind);

  if (input.delegationId) await assertDelegationUsable(db, input.delegationId);

  await db.categorizationRule.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.matchMode === undefined ? {} : { matchMode: input.matchMode }),
      ...(input.matchValue === undefined ? {} : { matchValue: input.matchValue }),
      // Both, always: an action is a pair, and writing half of it would leave a
      // rule the check constraint refuses — or worse, one it accepts and that
      // does two things.
      delegationId,
      setKind,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.amountMinCents === undefined ? {} : { amountMinCents: input.amountMinCents }),
      ...(input.amountMaxCents === undefined ? {} : { amountMaxCents: input.amountMaxCents }),
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    },
  });
}

/** Archived, never deleted, so an old rule remains resolvable in history. */
export async function archiveRule(db: Db, id: string): Promise<void> {
  const existing = await db.categorizationRule.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Rule', id);

  await db.categorizationRule.update({ where: { id }, data: { archivedAt: new Date() } });
}

/** Rewrites priorities in the given order, so the UI can reorder by drag or arrows. */
export async function reorderRules(db: Db, orderedIds: readonly string[]): Promise<void> {
  const live = await db.categorizationRule.findMany({
    where: { archivedAt: null },
    select: { id: true },
  });
  const liveIds = new Set(live.map((rule) => rule.id));

  if (orderedIds.length !== liveIds.size || orderedIds.some((id) => !liveIds.has(id))) {
    // A partial order would silently leave rules where they were, which reads as
    // the reorder having been ignored.
    throw new ValidationError(
      'incomplete_order',
      'Reordering must list every active rule exactly once.',
    );
  }

  // Sequential on the caller's `Db`, which may already be a transaction — the
  // caller owns that boundary here as everywhere else in the domain layer. The
  // route wraps this so a half-applied order cannot survive a failure.
  for (const [index, id] of orderedIds.entries()) {
    await db.categorizationRule.update({ where: { id }, data: { priority: (index + 1) * 10 } });
  }
}

/**
 * Builds a rule from a transaction the owner is looking at — the "always
 * categorize like this" action, which is how the initial rule set gets built
 * quickly.
 *
 * It matches on the raw feed text rather than the cleaned description, because
 * the raw text is what stays stable across a feed's own rewording — but on the
 * *merchant* part of it rather than all of it. Matching the whole raw text is
 * what made this unusable for the year it sat here uncalled: `AMAZON
 * MKTPL*RT4G93` carries a reference that never occurs again, so the rule matched
 * exactly the transaction it was built from and nothing else, silently, for
 * ever. `suggestedMatchValue` is the guess, and the caller may override it —
 * which the dialog does, because it offers the guess in a field first.
 */
export async function createRuleFromTransaction(
  db: Db,
  transactionId: string,
  delegationId: string,
  options: { readonly matchMode?: RuleMatchMode; readonly matchValue?: string } = {},
): Promise<{ id: string }> {
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { descriptionRaw: true, description: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);

  const matchValue = (
    options.matchValue ?? suggestedMatchValue(transaction.descriptionRaw || transaction.description)
  ).slice(0, MAX_PATTERN_LENGTH);

  return createRule(db, {
    matchMode: options.matchMode ?? 'contains',
    matchValue,
    delegationId,
  });
}
