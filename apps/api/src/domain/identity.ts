import { type IdentityResult, computeIdentity } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * The budget identity, recomputed on every view:
 *
 *   SUM(in-budget assets)
 *     − SUM(in-budget debts)
 *     − SUM(delegation balances)
 *     + SUM(categorized pending transactions)
 *
 * A health indicator, not an enforced invariant. Positive means money has landed
 * in an account and not yet been handed to an envelope — the "available to
 * delegate" figure on the bottom row of the Budget page.
 *
 * Only `in_budget` accounts are summed, which is what keeps the house and the
 * mortgage — both net-worth-only — from swamping the number.
 *
 * The first two terms are the **adjusted** balances, not the stored columns: a
 * synced account's stored figure is the institution's, and hand-entered activity
 * the feed has not reported is applied on read rather than written into it
 * (`standby.ts`). The screen shows the adjusted figure, so the identity has to
 * use the same one — a reconciliation computed from numbers nobody can see is a
 * reading that cannot be checked.
 *
 * Every delegation is summed, archived ones included. Archiving requires a $0
 * balance so they contribute nothing in practice, but excluding them would let a
 * nonzero archived line silently break the identity instead of showing up in it.
 */
export async function computeBudgetIdentity(db: Db): Promise<IdentityResult> {
  const [assets, debts, delegations, settings, pending, standby] = await Promise.all([
    db.account.aggregate({
      where: { inBudget: true, type: 'asset', archivedAt: null },
      _sum: { balanceCents: true },
    }),
    db.account.aggregate({
      where: { inBudget: true, type: 'debt', archivedAt: null },
      _sum: { balanceCents: true },
    }),
    db.delegation.aggregate({ _sum: { balanceCents: true } }),
    db.budgetSettings.findUnique({ where: { id: 1 }, select: { identityToleranceCents: true } }),
    /*
     * Categorized pending transactions, which the account balances do not yet
     * carry. The stored balance is the institution's settled `balance`, never
     * `available-balance`, so a pending charge is missing from it — while
     * categorizing has already taken the money out of its envelope.
     *
     * `allocations: { some: {} }` is the whole condition. An *un*categorized
     * pending row has moved neither side and is already consistent; adjusting
     * for it would turn a reconciliation into a forecast. Allocations are
     * required to sum to the transaction amount, so summing `amountCents` here
     * is summing exactly what the delegations moved by.
     *
     * Manual rows apply their own balance effect on creation and are always
     * created settled, so there is no manual row to exclude — but the filter is
     * on the account rather than the source, because what matters is whether
     * this account is one the first two terms count at all.
     */
    db.transaction.aggregate({
      where: {
        pending: true,
        archivedAt: null,
        allocations: { some: {} },
        account: { inBudget: true, archivedAt: null },
      },
      _sum: { amountCents: true },
    }),
    /*
     * Standby rows, split by the type of the account they sit on.
     *
     * These are hand-entered rows on a synced account, which deliberately do
     * not write `balance_cents` — see `standby.ts`. The first two terms
     * therefore read the institution's figure from before the feed went quiet,
     * and the screen reads that figure plus this. The identity has to agree
     * with the screen, or the equation on the chip reconciles against numbers
     * nobody can see.
     *
     * **No fourth-term treatment, and that is deliberate.** A categorized
     * standby row moved both sides — the balance here and its envelope — so it
     * cancels and needs no correction. An uncategorized one moved the balance
     * and nothing else, which reads as over-delegated: correct, and exactly
     * what any uncategorized spending reads as until it is filed.
     */
    db.transaction.groupBy({
      by: ['accountId'],
      where: {
        archivedAt: null,
        source: 'manual',
        account: {
          inBudget: true,
          archivedAt: null,
          source: { not: 'manual' },
        },
      },
      _sum: { amountCents: true },
    }),
  ]);

  // Resolved per account because the sign depends on the account's type, which
  // `groupBy` cannot carry. Small by construction: one row per synced account
  // that has hand-entered activity outstanding, and usually none at all.
  let standbyAssetsCents = 0n;
  let standbyDebtsCents = 0n;
  if (standby.length > 0) {
    const types = new Map(
      (
        await db.account.findMany({
          where: { id: { in: standby.map((row) => row.accountId) } },
          select: { id: true, type: true },
        })
      ).map((account) => [account.id, account.type]),
    );
    for (const row of standby) {
      const amount = row._sum.amountCents ?? 0n;
      // Balances are positive magnitudes for both types, so a charge lowers an
      // asset and raises a debt. Same rule as `accountBalanceDelta`.
      if (types.get(row.accountId) === 'debt') standbyDebtsCents -= amount;
      else standbyAssetsCents += amount;
    }
  }

  return computeIdentity({
    assetsCents: (assets._sum.balanceCents ?? 0n) + standbyAssetsCents,
    debtsCents: (debts._sum.balanceCents ?? 0n) + standbyDebtsCents,
    delegationsCents: delegations._sum.balanceCents ?? 0n,
    pendingCents: pending._sum.amountCents ?? 0n,
    ...(settings ? { toleranceCents: settings.identityToleranceCents } : {}),
  });
}
