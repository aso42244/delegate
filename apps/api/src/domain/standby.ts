import type { AccountType } from '@prisma/client';
import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { accountBalanceDelta } from './accounts.js';

/**
 * Standby rows: what somebody types in while a feed is behind.
 *
 * A synced account's `balance_cents` is the institution's own figure, restamped
 * on every run. Nothing typed into the register can change what the institution
 * says, so a manual row on a synced account must not write that column — it did,
 * and the next sync erased it within the hour, which looked exactly like the
 * entry had worked and then quietly hadn't.
 *
 * But the row is not nothing. During an outage the stored balance is not "the
 * settled balance now", it is "the settled balance as of whenever the feed last
 * worked", which may be days stale. A hand-entered charge is known activity the
 * institution has not reported to us. So the correction belongs on the way
 * **out**: the stored figure stays the feed's, and what a person reads is that
 * figure plus what we know has happened since.
 *
 * **There is no flag and nothing to set.** A manual row on a synced account is a
 * standby row by construction — there is no other reason to enter one — and a
 * manual row on a manual account is the ordinary case, where the stored balance
 * is the only balance there is and the row moves it directly. Deriving it means
 * there is no state to turn on, no state to forget to turn off, and no way for
 * the two to disagree.
 *
 * It settles itself. When the feed catches up it delivers the same charges, the
 * standby rows are archived, and the adjustment disappears with them.
 */

/**
 * The signed sum of hand-entered activity per synced account, in transaction
 * sign (negative is money out) rather than balance sign.
 *
 * Archived rows are excluded on both sides: an archived transaction has been
 * withdrawn, and an archived account is not on any screen this feeds.
 */
export async function standbyAdjustments(db: Db): Promise<Map<string, Cents>> {
  const rows = await db.transaction.groupBy({
    by: ['accountId'],
    where: {
      archivedAt: null,
      source: 'manual',
      // The account's source, not the transaction's. Both are `manual` on a
      // cash account, and that row is not standby — it has already moved the
      // only balance that account has.
      account: { archivedAt: null, source: { not: 'manual' } },
    },
    _sum: { amountCents: true },
  });

  return new Map(rows.map((row) => [row.accountId, row._sum.amountCents ?? 0n]));
}

/**
 * The figure to show for an account, and the one the identity counts.
 *
 * Both go through here so they cannot drift: a page showing one number while
 * the reconciliation at the top of it uses another is worse than either being
 * wrong on its own.
 *
 * `accountBalanceDelta` carries the debt sign convention — balances are positive
 * magnitudes for both types, so a −$50 charge lowers an asset and raises a debt.
 */
export function balanceWithStandby(
  type: AccountType,
  storedCents: Cents,
  adjustmentCents: Cents,
): Cents {
  return storedCents + accountBalanceDelta(type, adjustmentCents);
}
