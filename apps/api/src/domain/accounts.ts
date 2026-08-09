import { formatCents, type Cents } from '@budget/shared';
import type { AccountType } from '@prisma/client';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * How a transaction moves the account it belongs to.
 *
 * Balances are stored as positive magnitudes for both assets and debts, and
 * transaction amounts are signed with negative meaning money out. Those two
 * conventions pull in opposite directions on a debt:
 *
 *   * Asset: a −$50 charge lowers the balance.       delta = amount
 *   * Debt:  a −$50 charge *raises* what is owed.    delta = −amount
 *
 * Getting this backwards would keep the identity balanced while showing every
 * card balance with the wrong sign, so it lives in one function with one test
 * rather than being re-derived at each call site.
 *
 * The identity is unaffected either way: a card charge raises debts by $50 and
 * lowers the categorized envelope by $50, and the two cancel.
 */
export function accountBalanceDelta(type: AccountType, amountCents: Cents): Cents {
  switch (type) {
    case 'asset':
      return amountCents;
    case 'debt':
      return -amountCents;
  }
}

/**
 * Applies a transaction's effect to its account's cached balance, and stamps
 * `balance_as_of` so staleness reflects the most recent confirmed movement.
 */
export async function applyTransactionToAccountBalance(
  db: Db,
  accountId: string,
  amountCents: Cents,
  asOf: Date,
): Promise<{ balanceCents: Cents }> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, type: true },
  });
  if (!account) throw new NotFoundError('Account', accountId);

  const updated = await db.account.update({
    where: { id: accountId },
    data: {
      balanceCents: { increment: accountBalanceDelta(account.type, amountCents) },
      balanceAsOf: asOf,
    },
    select: { balanceCents: true },
  });
  return { balanceCents: updated.balanceCents };
}

export interface CreateAccountInput {
  readonly name: string;
  readonly type: AccountType;
  readonly balanceCents: Cents;
  // `| undefined` throughout, because `exactOptionalPropertyTypes` is on and a
  // parsed request body carries explicit undefined for an omitted field.
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
  readonly groupingId?: string | null | undefined;
}

/**
 * Creates an account the owner keeps by hand.
 *
 * Only manual accounts are created here. A SimpleFIN account is discovered by a
 * sync, which owns its external id — creating one here would produce a row the
 * feed could never match, and then a duplicate the first time it synced.
 */
export async function createManualAccount(
  db: Db,
  input: CreateAccountInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name === '') throw new ValidationError('empty_name', 'An account needs a name.');

  return db.account.create({
    data: {
      name,
      type: input.type,
      source: 'manual',
      balanceCents: input.balanceCents,
      inBudget: input.inBudget ?? true,
      inNetWorth: input.inNetWorth ?? true,
      stalenessIntervalDays: input.stalenessIntervalDays ?? null,
      groupingId: input.groupingId ?? null,
      // The balance was just confirmed by being typed in.
      balanceAsOf: now,
    },
    select: { id: true },
  });
}

export interface UpdateAccountInput {
  readonly name?: string | undefined;
  readonly type?: AccountType | undefined;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
  readonly groupingId?: string | null | undefined;
  readonly needsReview?: boolean | undefined;
  /** Manual accounts only. Sets the balance outright and stamps it as of now. */
  readonly balanceCents?: Cents | undefined;
  /** The mortgage secured against this property, if it is one. */
  readonly mortgageAccountId?: string | null | undefined;
}

/**
 * Edits an account.
 *
 * The balance is the one field that is not universally editable. A SimpleFIN
 * account's balance is whatever the institution last reported, and the next sync
 * would overwrite anything typed here — so accepting it would be a lie that
 * corrects itself within the hour, which is worse than refusing.
 */
export async function updateAccount(
  db: Db,
  id: string,
  input: UpdateAccountInput,
  now: Date = new Date(),
): Promise<void> {
  const account = await db.account.findUnique({
    where: { id },
    select: { id: true, source: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', id);
  if (account.archivedAt) {
    throw new ConflictError('account_archived', 'That account is archived. Restore it first.');
  }

  if (input.balanceCents !== undefined && account.source !== 'manual') {
    throw new ConflictError(
      'balance_not_editable',
      'This balance comes from SimpleFIN and the next sync would overwrite it. Record a transaction instead.',
    );
  }

  if (input.name !== undefined && input.name.trim() === '') {
    throw new ValidationError('empty_name', 'An account needs a name.');
  }

  if (
    input.stalenessIntervalDays !== undefined &&
    input.stalenessIntervalDays !== null &&
    (!Number.isInteger(input.stalenessIntervalDays) || input.stalenessIntervalDays < 1)
  ) {
    throw new ValidationError(
      'staleness_interval_invalid',
      'A staleness interval is a whole number of days, at least one. Leave it empty for never.',
    );
  }

  await db.account.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.inBudget === undefined ? {} : { inBudget: input.inBudget }),
      ...(input.inNetWorth === undefined ? {} : { inNetWorth: input.inNetWorth }),
      ...(input.stalenessIntervalDays === undefined
        ? {}
        : { stalenessIntervalDays: input.stalenessIntervalDays }),
      ...(input.groupingId === undefined ? {} : { groupingId: input.groupingId }),
      ...(input.needsReview === undefined ? {} : { needsReview: input.needsReview }),
      ...(input.mortgageAccountId === undefined
        ? {}
        : { mortgageAccountId: input.mortgageAccountId }),
      // Typing a balance is confirming it, so the staleness clock restarts.
      ...(input.balanceCents === undefined
        ? {}
        : { balanceCents: input.balanceCents, balanceAsOf: now }),
    },
  });
}

/**
 * Archives an account.
 *
 * Blocked while an **in-budget** account still holds a balance, because the
 * identity subtracts what the accounts hold: archiving $400 of real money would
 * shift the bottom line by $400 with nothing on screen to explain it, exactly as
 * archiving a delegation with money in it would.
 *
 * An off-budget account — the house, the mortgage — is not part of that sum, so
 * there is nothing to protect and it archives at any balance.
 */
export async function archiveAccount(db: Db, id: string, now: Date = new Date()): Promise<void> {
  const account = await db.account.findUnique({
    where: { id },
    select: { id: true, name: true, balanceCents: true, inBudget: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', id);
  if (account.archivedAt) return;

  if (account.inBudget && account.balanceCents !== 0n) {
    throw new ConflictError(
      'account_balance_not_zero',
      `${account.name} still holds ${formatCents(account.balanceCents)} and is in the budget. Move the money out, or take it out of the budget first.`,
      { accountId: id, balanceCents: account.balanceCents.toString() },
    );
  }

  await db.account.update({ where: { id }, data: { archivedAt: now } });
}

export async function restoreAccount(db: Db, id: string): Promise<void> {
  const account = await db.account.findUnique({ where: { id }, select: { id: true } });
  if (!account) throw new NotFoundError('Account', id);

  await db.account.update({ where: { id }, data: { archivedAt: null } });
}

/**
 * Equity on a property that references a mortgage: property value minus what is
 * still owed. Computed on read, never stored — a stored copy would drift from
 * the mortgage balance on every payment.
 */
export async function computeEquityCents(db: Db, propertyAccountId: string): Promise<Cents | null> {
  const property = await db.account.findUnique({
    where: { id: propertyAccountId },
    select: {
      balanceCents: true,
      mortgageAccount: { select: { balanceCents: true } },
    },
  });
  if (!property) throw new NotFoundError('Account', propertyAccountId);
  if (!property.mortgageAccount) return null;

  return property.balanceCents - property.mortgageAccount.balanceCents;
}
