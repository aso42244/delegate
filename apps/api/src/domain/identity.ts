import { type IdentityResult, computeIdentity } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * The budget identity, recomputed on every view:
 *
 *   SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)
 *
 * A health indicator, not an enforced invariant. Positive means money has landed
 * in an account and not yet been handed to an envelope — the "available to
 * delegate" figure on the bottom row of the Budget page.
 *
 * Only `in_budget` accounts are summed, which is what keeps the house and the
 * mortgage — both net-worth-only — from swamping the number.
 *
 * Every delegation is summed, archived ones included. Archiving requires a $0
 * balance so they contribute nothing in practice, but excluding them would let a
 * nonzero archived line silently break the identity instead of showing up in it.
 */
export async function computeBudgetIdentity(db: Db): Promise<IdentityResult> {
  const [assets, debts, delegations, settings] = await Promise.all([
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
  ]);

  return computeIdentity({
    assetsCents: assets._sum.balanceCents ?? 0n,
    debtsCents: debts._sum.balanceCents ?? 0n,
    delegationsCents: delegations._sum.balanceCents ?? 0n,
    ...(settings ? { toleranceCents: settings.identityToleranceCents } : {}),
  });
}
