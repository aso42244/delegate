import { sumCents, type Cents } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * Insights.
 *
 * A fixed catalog of built-in widgets rather than a generic chart builder — §9.4
 * chose that deliberately, and it is the right call: each widget answers one
 * question well, and nobody has to learn a query language to ask it.
 *
 * Spending is read from **allocations**, so `adjust` events are excluded
 * everywhere by construction. An adjustment is a correction to a balance, not
 * money spent, and a reconciliation of sixty lines would otherwise dominate
 * every spending figure on this page.
 */

export const INSIGHT_WIDGETS = [
  'asset_debt_composition',
  'spending_by_grouping',
  'spending_by_delegation',
  'delegations_negative',
  'uncategorized_backlog',
  'utilities_vs_delegated',
  'income_vs_spending',
  'cycle_surplus',
  // Reconstructed from the ledger rather than stored — ADR 013.
  'net_worth_over_time',
  'credit_card_trend',
  'home_equity_over_time',
  'bitcoin_value_over_time',
] as const;

export type InsightWidget = (typeof INSIGHT_WIDGETS)[number];

export function isInsightWidget(value: string): value is InsightWidget {
  return (INSIGHT_WIDGETS as readonly string[]).includes(value);
}

/**
 * The windows §9.4 asks for. "This cycle" means since the most recent Delegate
 * press, which is the only definition of a cycle this system has.
 */
export const SPENDING_WINDOWS = ['30d', '90d', '365d', 'ytd', 'cycle'] as const;
export type SpendingWindow = (typeof SPENDING_WINDOWS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export async function windowStart(
  db: Db,
  window: SpendingWindow,
  now: Date = new Date(),
): Promise<Date | null> {
  switch (window) {
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS);
    case '90d':
      return new Date(now.getTime() - 90 * DAY_MS);
    case '365d':
      return new Date(now.getTime() - 365 * DAY_MS);
    case 'ytd':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case 'cycle': {
      const run = await db.delegateRun.findFirst({
        where: { undoneAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Null before the first Delegate press: there is no cycle yet, and
      // inventing one would put a number on screen that means nothing.
      return run?.createdAt ?? null;
    }
  }
}

export interface CompositionEntry {
  readonly name: string;
  readonly balanceCents: Cents;
  /** Basis points of the section total, so the split survives as an integer. */
  readonly shareBasisPoints: number;
}

export interface Composition {
  readonly assets: readonly CompositionEntry[];
  readonly debts: readonly CompositionEntry[];
  readonly totalAssetsCents: Cents;
  readonly totalDebtsCents: Cents;
  readonly netCents: Cents;
}

/**
 * What the household holds and owes right now.
 *
 * Shares are basis points rather than a float percentage: the point of this
 * project is that money never becomes a float, and a percentage of money is
 * still money's business.
 */
export async function buildComposition(db: Db): Promise<Composition> {
  const accounts = await db.account.findMany({
    where: { archivedAt: null, inNetWorth: true },
    select: { name: true, type: true, balanceCents: true },
    orderBy: { balanceCents: 'desc' },
  });

  const assets = accounts.filter((account) => account.type === 'asset');
  const debts = accounts.filter((account) => account.type === 'debt');
  const totalAssetsCents = sumCents(assets.map((account) => account.balanceCents));
  const totalDebtsCents = sumCents(debts.map((account) => account.balanceCents));

  const share = (value: Cents, total: Cents): number =>
    total === 0n ? 0 : Number((value * 10_000n) / total);

  return {
    assets: assets.map((account) => ({
      name: account.name,
      balanceCents: account.balanceCents,
      shareBasisPoints: share(account.balanceCents, totalAssetsCents),
    })),
    debts: debts.map((account) => ({
      name: account.name,
      balanceCents: account.balanceCents,
      shareBasisPoints: share(account.balanceCents, totalDebtsCents),
    })),
    totalAssetsCents,
    totalDebtsCents,
    netCents: totalAssetsCents - totalDebtsCents,
  };
}

export interface SpendingEntry {
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly spendCents: Cents;
}

/**
 * Spending in a window, grouped by grouping or by delegation.
 *
 * Positive magnitudes: refunds inside the window reduce the figure, which is
 * what "spending" means to a person looking at it.
 */
export async function buildSpending(
  db: Db,
  options: { readonly by: 'grouping' | 'delegation'; readonly window: SpendingWindow },
  now: Date = new Date(),
): Promise<{ entries: SpendingEntry[]; since: Date | null }> {
  const since = await windowStart(db, options.window, now);
  if (since === null) return { entries: [], since: null };

  const allocations = await db.transactionAllocation.findMany({
    where: {
      transaction: { archivedAt: null, kind: 'normal', postedAt: { gte: since } },
    },
    select: {
      amountCents: true,
      delegation: {
        select: {
          id: true,
          name: true,
          grouping: { select: { id: true, name: true, color: true } },
        },
      },
    },
  });

  const totals = new Map<string, SpendingEntry>();

  for (const allocation of allocations) {
    const grouping = allocation.delegation.grouping;
    const key =
      options.by === 'grouping' ? (grouping?.id ?? 'ungrouped') : allocation.delegation.id;
    const name =
      options.by === 'grouping' ? (grouping?.name ?? 'No grouping') : allocation.delegation.name;
    const color = options.by === 'grouping' ? (grouping?.color ?? null) : null;

    const existing = totals.get(key);
    totals.set(key, {
      key,
      name,
      color,
      // Spending is stored negative; the magnitude is the negation.
      spendCents: (existing?.spendCents ?? 0n) - allocation.amountCents,
    });
  }

  const entries = [...totals.values()]
    // Largest first: the question is "where did it go", and the answer is at
    // the top.
    .sort((a, b) => (b.spendCents > a.spendCents ? 1 : b.spendCents < a.spendCents ? -1 : 0));

  return { entries, since };
}

export interface NegativeDelegation {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: Cents;
}

/** The lines that are over-spent. The only red in the interface, per §11. */
export async function buildNegativeDelegations(db: Db): Promise<NegativeDelegation[]> {
  const rows = await db.delegation.findMany({
    where: { archivedAt: null, balanceCents: { lt: 0 } },
    select: { id: true, name: true, balanceCents: true },
    orderBy: { balanceCents: 'asc' },
  });
  return rows;
}

export interface BacklogSummary {
  readonly count: number;
  readonly oldestPostedAt: Date | null;
}

export async function buildBacklog(db: Db): Promise<BacklogSummary> {
  const where = { archivedAt: null, kind: 'normal' as const, allocations: { none: {} } };

  const [count, oldest] = await Promise.all([
    db.transaction.count({ where }),
    db.transaction.findFirst({
      where,
      orderBy: { postedAt: 'asc' },
      select: { postedAt: true },
    }),
  ]);

  return { count, oldestPostedAt: oldest?.postedAt ?? null };
}

export interface CycleSummary {
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly incomeCents: Cents;
  readonly spendingCents: Cents;
  /** Income less spending. Negative means the cycle ran a deficit. */
  readonly surplusCents: Cents;
  /**
   * True for a cycle containing a third payday. The owner is paid biweekly, so
   * two months a year have three — flagged so the comparison is not misread.
   */
  readonly partial: boolean;
}

/**
 * Income against spending, cycle by cycle.
 *
 * A cycle runs from one Delegate press to the next, which is the only boundary
 * this system recognises. The most recent cycle is still open and is marked, so
 * a half-finished cycle is not compared against whole ones as though it were.
 */
export async function buildCycles(db: Db, now: Date = new Date()): Promise<CycleSummary[]> {
  const runs = await db.delegateRun.findMany({
    where: { undoneAt: null },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (runs.length === 0) return [];

  const summaries: CycleSummary[] = [];

  for (const [index, run] of runs.entries()) {
    const startedAt = run.createdAt;
    const endedAt = runs[index + 1]?.createdAt ?? null;

    const transactions = await db.transaction.findMany({
      where: {
        archivedAt: null,
        postedAt: { gte: startedAt, ...(endedAt ? { lt: endedAt } : {}) },
      },
      select: { amountCents: true, kind: true },
    });

    const incomeCents = sumCents(
      transactions.filter((row) => row.kind === 'income').map((row) => row.amountCents),
    );
    // Spending is negative; report it as a magnitude.
    const spendingCents = -sumCents(
      transactions.filter((row) => row.kind === 'normal').map((row) => row.amountCents),
    );

    summaries.push({
      startedAt,
      endedAt,
      incomeCents,
      spendingCents,
      surplusCents: incomeCents - spendingCents,
      partial: endedAt === null && startedAt <= now,
    });
  }

  return summaries;
}
