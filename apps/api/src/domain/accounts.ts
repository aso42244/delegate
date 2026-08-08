import type { Cents } from '@budget/shared';
import type { AccountType } from '@prisma/client';
import type { Db } from '../db/client.js';
import { NotFoundError } from './errors.js';

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
