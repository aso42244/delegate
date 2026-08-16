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
 * Every delegation is summed, archived ones included. Archiving requires a $0
 * balance so they contribute nothing in practice, but excluding them would let a
 * nonzero archived line silently break the identity instead of showing up in it.
 */
export async function computeBudgetIdentity(db: Db): Promise<IdentityResult> {
  const [assets, debts, delegations, settings, pending] = await Promise.all([
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
  ]);

  return computeIdentity({
    assetsCents: assets._sum.balanceCents ?? 0n,
    debtsCents: debts._sum.balanceCents ?? 0n,
    delegationsCents: delegations._sum.balanceCents ?? 0n,
    pendingCents: pending._sum.amountCents ?? 0n,
    ...(settings ? { toleranceCents: settings.identityToleranceCents } : {}),
  });
}
