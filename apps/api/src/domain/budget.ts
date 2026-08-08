import { sumCents, type Cents, type GroupingSection, type IdentityResult } from '@budget/shared';
import type { Db } from '../db/client.js';
import { computeBudgetIdentity } from './identity.js';

/**
 * The Main Budget read model.
 *
 * One query set builds the whole page — three sections, their groupings, and the
 * identity across the bottom. It is assembled server-side so the UI never has to
 * derive a total itself: a number computed in two places is a number that will
 * eventually disagree with itself.
 *
 * Ordering is alphabetical everywhere, which is the only order this system has.
 */

export interface BudgetRow {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: Cents;
  /** Null for assets and debts, and for ad-hoc delegations. Null is not zero. */
  readonly amountToDelegateCents: Cents | null;
  readonly groupingId: string | null;
  readonly isUtility: boolean;
  readonly notes: string | null;
  /** Assets and debts only. */
  readonly source: string | null;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly balanceAsOf: Date | null;
  readonly stalenessIntervalDays: number | null;
}

export interface BudgetGrouping {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly collapsed: boolean;
  /** Summed from children, so a collapsed row can show totals without a second query. */
  readonly balanceCents: Cents;
  readonly amountToDelegateCents: Cents | null;
  readonly rows: readonly BudgetRow[];
}

export interface BudgetSection {
  readonly section: GroupingSection;
  readonly groupings: readonly BudgetGrouping[];
  /** Rows with no grouping, shown after the groupings. */
  readonly ungrouped: readonly BudgetRow[];
  readonly totalBalanceCents: Cents;
  readonly totalAmountToDelegateCents: Cents | null;
}

export interface BudgetView {
  readonly assets: BudgetSection;
  readonly debts: BudgetSection;
  readonly delegations: BudgetSection;
  readonly identity: IdentityResult;
  /** Start of the current cycle: the most recent Delegate press. Null before the first. */
  readonly cycleStartedAt: Date | null;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

/**
 * Sums amounts to delegate across rows.
 *
 * Returns null when every row is ad-hoc, so a grouping of ad-hoc lines shows an
 * em-dash rather than `$0` — null means "adds nothing at Delegate time", which
 * reads differently from a deliberate zero.
 */
function sumAmountToDelegate(rows: readonly BudgetRow[]): Cents | null {
  const present = rows
    .map((row) => row.amountToDelegateCents)
    .filter((value): value is Cents => value !== null);
  return present.length === 0 ? null : sumCents(present);
}

function groupRows(
  section: GroupingSection,
  groupings: readonly {
    id: string;
    name: string;
    color: string | null;
    collapsed: boolean;
    section: GroupingSection;
  }[],
  rows: readonly BudgetRow[],
): BudgetSection {
  const sectionGroupings = groupings.filter((grouping) => grouping.section === section);

  const built = sectionGroupings
    .map((grouping): BudgetGrouping => {
      const children = rows.filter((row) => row.groupingId === grouping.id).sort(byName);
      return {
        id: grouping.id,
        name: grouping.name,
        color: grouping.color,
        collapsed: grouping.collapsed,
        balanceCents: sumCents(children.map((child) => child.balanceCents)),
        amountToDelegateCents: sumAmountToDelegate(children),
        rows: children,
      };
    })
    .sort(byName);

  const ungrouped = rows.filter((row) => row.groupingId === null).sort(byName);

  return {
    section,
    groupings: built,
    ungrouped,
    totalBalanceCents: sumCents(rows.map((row) => row.balanceCents)),
    totalAmountToDelegateCents: sumAmountToDelegate(rows),
  };
}

export async function buildBudgetView(db: Db): Promise<BudgetView> {
  const [accounts, delegations, groupings, identity, latestRun] = await Promise.all([
    db.account.findMany({
      // Off-budget accounts belong to net worth, not to this page.
      where: { archivedAt: null, inBudget: true },
      select: {
        id: true,
        name: true,
        type: true,
        source: true,
        balanceCents: true,
        groupingId: true,
        needsReview: true,
        balanceAsOf: true,
        stalenessIntervalDays: true,
        inBudget: true,
        inNetWorth: true,
      },
    }),
    db.delegation.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        balanceCents: true,
        amountToDelegateCents: true,
        groupingId: true,
        isUtility: true,
        notes: true,
      },
    }),
    db.grouping.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, color: true, collapsed: true, section: true },
    }),
    computeBudgetIdentity(db),
    db.delegateRun.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  const accountRow = (account: (typeof accounts)[number]): BudgetRow => ({
    id: account.id,
    name: account.name,
    balanceCents: account.balanceCents,
    // Assets and debts have no amount to delegate; the column is empty for them.
    amountToDelegateCents: null,
    groupingId: account.groupingId,
    isUtility: false,
    notes: null,
    source: account.source,
    inBudget: account.inBudget,
    inNetWorth: account.inNetWorth,
    needsReview: account.needsReview,
    balanceAsOf: account.balanceAsOf,
    stalenessIntervalDays: account.stalenessIntervalDays,
  });

  const delegationRows: BudgetRow[] = delegations.map((delegation) => ({
    id: delegation.id,
    name: delegation.name,
    balanceCents: delegation.balanceCents,
    amountToDelegateCents: delegation.amountToDelegateCents,
    groupingId: delegation.groupingId,
    isUtility: delegation.isUtility,
    notes: delegation.notes,
    source: null,
    // Delegations are not accounts; these two are an account's business.
    inBudget: false,
    inNetWorth: false,
    needsReview: false,
    balanceAsOf: null,
    stalenessIntervalDays: null,
  }));

  return {
    assets: groupRows(
      'assets',
      groupings,
      accounts.filter((account) => account.type === 'asset').map(accountRow),
    ),
    debts: groupRows(
      'debts',
      groupings,
      accounts.filter((account) => account.type === 'debt').map(accountRow),
    ),
    delegations: groupRows('delegations', groupings, delegationRows),
    identity,
    cycleStartedAt: latestRun?.createdAt ?? null,
  };
}
