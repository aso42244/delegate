import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { setAllocations } from './allocations.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { transferBetweenDelegations } from './transfer.js';

/**
 * Outstanding checks — money written but not yet cashed.
 *
 * A check sits in a gap the rest of the system has no way to represent. The
 * household has spent the money; the bank has not seen it. Without this, the
 * envelope still shows funds that are already committed, and the mistake is the
 * expensive kind: spending the same money twice.
 *
 * ## Why a check is a delegation
 *
 * Because that is what it is — an envelope holding money until the bank catches
 * up. Writing check 1062 for $120 against Piano Lessons is an envelope transfer:
 * Piano Lessons falls by $120, "Check 1062" rises by $120. `SUM(delegations)` is
 * unchanged and no account moved, so the budget identity is untouched, which is
 * correct: nothing has actually left the household yet.
 *
 * When the check clears, the bank transaction reduces the account and its
 * allocation empties the check line. Both sides of the identity fall by $120 and
 * it balances again.
 *
 * The alternative — a separate table with its own balance — would have needed
 * its own term in the identity, its own history, its own reconciliation, and its
 * own bugs. This way a check is carried by the ledger that already exists, and
 * `recompute-balances` checks it for free.
 *
 * Every function here takes `Db` and leaves the transaction boundary to its
 * caller, as the rest of the domain does. The routes wrap them in
 * `prisma.$transaction`, which matters: a check line without its transfer would
 * be a line holding nothing while the envelope still shows the money — exactly
 * the confusion this exists to remove.
 */

/** The grouping outstanding checks live in, found by key rather than by name. */
export const OUTSTANDING_CHECKS_KEY = 'outstanding-checks';
const OUTSTANDING_CHECKS_NAME = 'Outstanding Checks';

export interface WriteCheckInput {
  readonly checkNumber: string;
  readonly amountCents: Cents;
  readonly issuedAt: Date;
  readonly memo?: string | null;
  readonly sourceDelegationId: string;
  readonly actorId?: string | null;
}

export interface OutstandingCheck {
  readonly id: string;
  readonly checkNumber: string;
  readonly memo: string | null;
  readonly issuedAt: Date;
  readonly balanceCents: Cents;
  readonly sourceDelegationId: string | null;
  readonly sourceName: string | null;
}

/**
 * Finds the reserved grouping, creating it the first time a check is written.
 *
 * Not seeded, because a household that never writes a check should never see an
 * empty grouping explaining a feature it does not use.
 */
async function outstandingChecksGrouping(db: Db): Promise<string> {
  const existing = await db.grouping.findFirst({
    where: { systemKey: OUTSTANDING_CHECKS_KEY },
    select: { id: true, archivedAt: true },
  });

  if (existing) {
    // Belt and braces: the domain refuses to archive this grouping, but if one
    // ever got archived the next check should revive it rather than fail.
    if (existing.archivedAt) {
      await db.grouping.update({ where: { id: existing.id }, data: { archivedAt: null } });
    }
    return existing.id;
  }

  const created = await db.grouping.create({
    data: {
      name: OUTSTANDING_CHECKS_NAME,
      section: 'delegations',
      systemKey: OUTSTANDING_CHECKS_KEY,
    },
    select: { id: true },
  });
  return created.id;
}

/** The display name of a check line: the number is the identifier. */
function checkName(checkNumber: string, memo: string | null | undefined): string {
  return memo ? `Check ${checkNumber} — ${memo}` : `Check ${checkNumber}`;
}

export function normalizeCheckNumber(value: string): string {
  return value.trim();
}

/** Records a check: creates the line and moves the money onto it. */
export async function writeCheck(db: Db, input: WriteCheckInput): Promise<OutstandingCheck> {
  const checkNumber = normalizeCheckNumber(input.checkNumber);

  if (!checkNumber) {
    throw new ValidationError('check_number_required', 'A check needs its number.');
  }
  if (checkNumber.length > 32) {
    throw new ValidationError('check_number_too_long', 'That does not look like a check number.');
  }
  if (input.amountCents <= 0n) {
    throw new ValidationError(
      'check_amount_not_positive',
      'A check is for a positive amount. Record money coming in as a transaction.',
    );
  }

  const source = await db.delegation.findUnique({
    where: { id: input.sourceDelegationId },
    select: { id: true, archivedAt: true, kind: true },
  });
  if (!source) throw new NotFoundError('Delegation', input.sourceDelegationId);
  if (source.archivedAt) {
    throw new ValidationError('source_archived', 'That delegation is archived.');
  }
  if (source.kind === 'check') {
    throw new ValidationError(
      'source_is_a_check',
      'A check cannot be written against another check.',
    );
  }

  const clash = await db.delegation.findFirst({
    where: {
      kind: 'check',
      archivedAt: null,
      checkNumber: { equals: checkNumber, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(
      'check_number_outstanding',
      `Check ${checkNumber} is already outstanding. Match or void it first.`,
    );
  }

  const groupingId = await outstandingChecksGrouping(db);

  const check = await db.delegation.create({
    data: {
      name: checkName(checkNumber, input.memo),
      kind: 'check',
      groupingId,
      checkNumber,
      checkMemo: input.memo?.trim() || null,
      checkIssuedAt: input.issuedAt,
      checkSourceDelegationId: input.sourceDelegationId,
      // A check is never funded by Delegate. Null, not zero — null is "add
      // nothing", zero would be a decision to add nothing each cycle.
      amountToDelegateCents: null,
    },
    select: { id: true },
  });

  await transferBetweenDelegations(db, {
    fromDelegationId: input.sourceDelegationId,
    toDelegationId: check.id,
    amountCents: input.amountCents,
    actorId: input.actorId ?? null,
  });

  return present(
    await db.delegation.findUniqueOrThrow({ where: { id: check.id }, select: CHECK_SELECT }),
  );
}

const CHECK_SELECT = {
  id: true,
  checkNumber: true,
  checkMemo: true,
  checkIssuedAt: true,
  balanceCents: true,
  checkSourceDelegationId: true,
  checkSource: { select: { name: true } },
} as const;

type CheckRow = {
  id: string;
  checkNumber: string | null;
  checkMemo: string | null;
  checkIssuedAt: Date | null;
  balanceCents: bigint;
  checkSourceDelegationId: string | null;
  checkSource: { name: string } | null;
};

function present(row: CheckRow): OutstandingCheck {
  return {
    id: row.id,
    checkNumber: row.checkNumber ?? '',
    memo: row.checkMemo,
    issuedAt: row.checkIssuedAt ?? new Date(0),
    balanceCents: row.balanceCents,
    sourceDelegationId: row.checkSourceDelegationId,
    sourceName: row.checkSource?.name ?? null,
  };
}

export async function listOutstandingChecks(db: Db): Promise<OutstandingCheck[]> {
  const rows = await db.delegation.findMany({
    where: { kind: 'check', archivedAt: null },
    select: CHECK_SELECT,
    orderBy: { checkIssuedAt: 'asc' },
  });
  return rows.map(present);
}

/**
 * A check that will never be cashed — lost, spoiled, torn up.
 *
 * The money goes back where it came from and the line is archived, never
 * deleted, so the history of it having existed survives.
 */
export async function voidCheck(
  db: Db,
  checkId: string,
  options: { readonly actorId?: string | null } = {},
): Promise<void> {
  const check = await db.delegation.findUnique({
    where: { id: checkId },
    select: {
      id: true,
      kind: true,
      archivedAt: true,
      balanceCents: true,
      checkSourceDelegationId: true,
    },
  });
  if (!check || check.kind !== 'check') throw new NotFoundError('Outstanding check', checkId);
  if (check.archivedAt) {
    throw new ConflictError('check_already_settled', 'That check has already been settled.');
  }

  if (check.balanceCents !== 0n && check.checkSourceDelegationId) {
    const returning = check.balanceCents > 0n;
    await transferBetweenDelegations(db, {
      fromDelegationId: returning ? checkId : check.checkSourceDelegationId,
      toDelegationId: returning ? check.checkSourceDelegationId : checkId,
      amountCents: returning ? check.balanceCents : -check.balanceCents,
      actorId: options.actorId ?? null,
    });
  }

  await db.delegation.update({ where: { id: checkId }, data: { archivedAt: new Date() } });
}

export interface ClearCheckResult {
  readonly checkId: string;
  readonly transactionId: string;
  /**
   * What the bank actually paid, minus what was written down. Zero in the
   * ordinary case; non-zero lands on the delegation the check was drawn on.
   */
  readonly differenceCents: Cents;
}

/**
 * Settles a check against the bank transaction that cashed it.
 *
 * The allocation goes to the **delegation the check was drawn on**, not to the
 * check line, and this is the detail that makes the feature honest rather than
 * merely balanced. A check is a holding pen, not a category: money spent on
 * piano lessons was spent on piano lessons whether or not it travelled by check.
 * Allocating to the check line would balance perfectly and then quietly tell
 * Insights that the household spent $120 on "Check 1062".
 *
 * So: allocate the payment to the source, then move the check's holding back to
 * the source to close it out. The source ends where it started, the check ends
 * empty, and the account has fallen by what the bank took.
 *
 * The transaction's amount is authoritative — the bank is the record of what was
 * actually paid. When it differs from what was written down, the difference is
 * simply left on the source delegation, which is exactly where someone would
 * want to find it: the envelope is short by the amount the check overran.
 */
export async function clearCheck(
  db: Db,
  checkId: string,
  transactionId: string,
  options: { readonly actorId?: string | null } = {},
): Promise<ClearCheckResult> {
  const check = await db.delegation.findUnique({
    where: { id: checkId },
    select: {
      id: true,
      kind: true,
      archivedAt: true,
      balanceCents: true,
      checkSourceDelegationId: true,
    },
  });
  if (!check || check.kind !== 'check') throw new NotFoundError('Outstanding check', checkId);
  if (check.archivedAt) {
    throw new ConflictError('check_already_settled', 'That check has already been settled.');
  }

  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, amountCents: true, kind: true, archivedAt: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);
  if (transaction.archivedAt) {
    throw new ValidationError('transaction_archived', 'That transaction is archived.');
  }
  if (transaction.kind !== 'normal') {
    throw new ValidationError(
      'transaction_kind_not_matchable',
      'Only an ordinary transaction can settle a check.',
    );
  }
  if (transaction.amountCents >= 0n) {
    throw new ValidationError(
      'transaction_not_a_payment',
      'A check clears as money leaving an account.',
    );
  }

  // The source is kept live while a check is outstanding — archiving it is
  // refused for exactly this reason — so this is the ordinary path. The check
  // line is the fallback only for data that predates that guarantee.
  const target = check.checkSourceDelegationId ?? checkId;

  await setAllocations(
    db,
    transactionId,
    [{ delegationId: target, amountCents: transaction.amountCents }],
    { actorId: options.actorId ?? null },
  );

  // Close the check by moving what it holds back to the source. Whatever the
  // bank took beyond that stays on the source as a shortfall.
  const held = check.balanceCents;
  if (held !== 0n && check.checkSourceDelegationId) {
    const returning = held > 0n;
    await transferBetweenDelegations(db, {
      fromDelegationId: returning ? checkId : check.checkSourceDelegationId,
      toDelegationId: returning ? check.checkSourceDelegationId : checkId,
      amountCents: returning ? held : -held,
      actorId: options.actorId ?? null,
    });
  }

  await db.delegation.update({ where: { id: checkId }, data: { archivedAt: new Date() } });

  return {
    checkId,
    transactionId,
    // Negative when the bank took more than the check was written for.
    differenceCents: held + transaction.amountCents,
  };
}

/**
 * Whether a transaction's text names a given check number.
 *
 * Deliberately strict. Bank descriptions carry all sorts of digits — trace
 * numbers, dates, store numbers — and a loose match would settle the wrong
 * check, moving real money to the wrong envelope. The number must appear as a
 * whole token, not as part of a longer run of digits: "1062" matches
 * `CHECK 1062` and `CHECK #1062`, and does not match `2110629`.
 */
export function textNamesCheck(text: string, checkNumber: string): boolean {
  const escaped = checkNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9])${escaped}(?![0-9])`).test(text);
}

export interface CheckMatch {
  readonly checkId: string;
  readonly transactionId: string;
  readonly checkNumber: string;
}

/**
 * Settles every check whose bank transaction has arrived.
 *
 * Run after a sync. A match needs **both** the exact amount and the check number
 * as a whole token, and the transaction must still be uncategorized. Requiring
 * both is what makes this safe to apply without asking: an amount alone would
 * match any payment that happened to be for the same figure, and a number alone
 * would match a coincidence in a description.
 *
 * Anything it cannot resolve is left alone for the manual path, which is the
 * right failure — an unmatched check is visible on the budget, whereas a wrongly
 * matched one is money quietly moved to the wrong place.
 */
export async function matchClearedChecks(
  db: Db,
  options: { readonly actorId?: string | null } = {},
): Promise<CheckMatch[]> {
  const checks = await db.delegation.findMany({
    where: { kind: 'check', archivedAt: null },
    select: { id: true, checkNumber: true, balanceCents: true },
  });
  if (checks.length === 0) return [];

  const candidates = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      amountCents: { lt: 0n },
      allocations: { none: {} },
      account: { archivedAt: null, inBudget: true },
    },
    select: { id: true, amountCents: true, description: true },
    orderBy: { postedAt: 'asc' },
  });

  const matches: CheckMatch[] = [];
  const used = new Set<string>();

  for (const check of checks) {
    if (!check.checkNumber) continue;

    const hit = candidates.find(
      (candidate) =>
        !used.has(candidate.id) &&
        // The check line holds what was written; the payment is its negative.
        candidate.amountCents === -check.balanceCents &&
        textNamesCheck(candidate.description, check.checkNumber!),
    );
    if (!hit) continue;

    used.add(hit.id);
    await clearCheck(db, check.id, hit.id, options);
    matches.push({ checkId: check.id, transactionId: hit.id, checkNumber: check.checkNumber });
  }

  return matches;
}
