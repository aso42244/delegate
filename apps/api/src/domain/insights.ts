import { bitcoinValueCents, sumCents, type Cents } from '@budget/shared';
import { localYearKey, startOfLocalDay } from './calendar.js';
import type { Db } from '../db/client.js';
import { newestPrice } from './bitcoin.js';

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
  // Read from the nightly snapshot tables — ADR 035, which supersedes ADR 013
  // and the reconstruction these four used to be drawn from.
  'net_worth_over_time',
  'assets_vs_debts',
  'account_balance_history',
  'delegation_balance_history',
  'delegation_burn_rate',
  'identity_drift',
  'home_equity_over_time',
  'bitcoin_value_over_time',

  // Derived from the same tables rather than plotted straight from them.
  'net_worth_composition',
  'change_per_cycle',
  'thirty_day_momentum',
  'delegation_movers',
  'debt_trajectory',
] as const;

export type InsightWidget = (typeof INSIGHT_WIDGETS)[number];

export function isInsightWidget(value: string): value is InsightWidget {
  return (INSIGHT_WIDGETS as readonly string[]).includes(value);
}

/**
 * The windows §9.4 asks for. "This cycle" means since the most recent Delegate
 * press, which is the only definition of a cycle this system has.
 */
/**
 * The page-level range, shared with the snapshot series.
 *
 * One selector drives every tile, so there is one vocabulary rather than two —
 * the older spending tiles and the snapshot-backed charts read the same value.
 * `cycle` is one Delegate press to the next, which is the only cycle boundary
 * this system recognises.
 */
export const SPENDING_WINDOWS = ['30d', '90d', '6mo', '1yr', 'ytd', 'cycle', 'all'] as const;
export type SpendingWindow = (typeof SPENDING_WINDOWS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a window begins.
 *
 * Three outcomes rather than a nullable date, because "everything" and "there is
 * no cycle yet" are different answers that a null cannot tell apart — and one of
 * them should show every transaction while the other should show none.
 */
export type WindowStart =
  | { readonly kind: 'since'; readonly date: Date }
  | { readonly kind: 'all' }
  | { readonly kind: 'no_cycle' };

export async function windowStart(
  db: Db,
  window: SpendingWindow,
  timeZone: string,
  now: Date = new Date(),
): Promise<WindowStart> {
  const back = (days: number): WindowStart => ({
    kind: 'since',
    date: new Date(now.getTime() - days * DAY_MS),
  });

  switch (window) {
    case '30d':
      return back(30);
    case '90d':
      return back(90);
    case '6mo':
      return back(182);
    case '1yr':
      return back(365);
    case 'ytd':
      // The household's year. New Year's Eve at ten in the evening is already
      // next year in UTC, and would fall outside its own year-to-date.
      return { kind: 'since', date: startOfLocalDay(localYearKey(now, timeZone), timeZone) };
    case 'cycle': {
      const run = await db.delegateRun.findFirst({
        where: { undoneAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Before the first Delegate press there is no cycle, and inventing one
      // would put a number on screen that means nothing.
      return run ? { kind: 'since', date: run.createdAt } : { kind: 'no_cycle' };
    }
    case 'all':
      return { kind: 'all' };
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
  const [rows, price] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null, inNetWorth: true },
      select: {
        id: true,
        name: true,
        nickname: true,
        type: true,
        balanceCents: true,
        bitcoinSats: true,
        mortgageAccountId: true,
      },
    }),
    newestPrice(db),
  ]);

  /**
   * A Bitcoin account's worth is its quantity at today's price, not its
   * `balance_cents` — which is zero, because there is no dollar balance to
   * carry. Summing the column alone left a real holding out of net worth
   * entirely while the net-worth-over-time chart, which has always valued it
   * this way, included it. The two disagreed, and the chart was right.
   *
   * Without a price the holding contributes nothing, which is the honest answer
   * — a quantity is not a value until something says what it is worth.
   */
  const worthOf = (account: (typeof rows)[number]): Cents =>
    account.bitcoinSats === null
      ? account.balanceCents
      : price === null
        ? 0n
        : bitcoinValueCents(account.bitcoinSats, price.priceCents);

  /**
   * A property with a mortgage against it is shown as **one line, at equity**,
   * and the mortgage is removed from the debts beside it.
   *
   * Listing the house gross and the loan separately is arithmetically fine — the
   * net is identical either way — but it reads badly: a $350,000 line taking 96%
   * of the assets, next to a debt nobody connects to it, describes a household
   * that owns a house outright. Netting the pair says the true thing, which is
   * how much of the house is actually theirs.
   *
   * Only when the mortgage is itself in net worth and not archived. Netting
   * against a loan that is not in this sum would subtract it twice.
   */
  const byId = new Map(rows.map((account) => [account.id, account]));
  const nettedAway = new Set(
    rows
      .filter((account) => account.mortgageAccountId !== null)
      .map((account) => account.mortgageAccountId)
      .filter((id): id is string => id !== null && byId.has(id)),
  );

  const accounts = rows
    .filter((account) => !nettedAway.has(account.id))
    .map((account) => {
      const mortgage =
        account.mortgageAccountId === null ? null : (byId.get(account.mortgageAccountId) ?? null);
      if (mortgage === null) {
        return {
          name: account.nickname ?? account.name,
          type: account.type,
          valueCents: worthOf(account),
        };
      }

      const equity = worthOf(account) - worthOf(mortgage);
      return {
        // Named for what the figure is. "1505 E Otonka Trail" beside a number
        // that is not its value would be the same confusion in a new place.
        name: `${account.nickname ?? account.name} (equity)`,
        // Underwater is a debt, and belongs on the other side of the page.
        type: equity < 0n ? ('debt' as const) : account.type,
        valueCents: equity < 0n ? -equity : equity,
      };
    })
    .sort((a, b) => (b.valueCents > a.valueCents ? 1 : b.valueCents < a.valueCents ? -1 : 0));

  const assets = accounts.filter((account) => account.type === 'asset');
  const debts = accounts.filter((account) => account.type === 'debt');
  const totalAssetsCents = sumCents(assets.map((account) => account.valueCents));
  const totalDebtsCents = sumCents(debts.map((account) => account.valueCents));

  const share = (value: Cents, total: Cents): number =>
    total === 0n ? 0 : Number((value * 10_000n) / total);

  return {
    assets: assets.map((account) => ({
      name: account.name,
      balanceCents: account.valueCents,
      shareBasisPoints: share(account.valueCents, totalAssetsCents),
    })),
    debts: debts.map((account) => ({
      name: account.name,
      balanceCents: account.valueCents,
      shareBasisPoints: share(account.valueCents, totalDebtsCents),
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
  options: {
    readonly by: 'grouping' | 'delegation';
    readonly window: SpendingWindow;
    readonly timeZone: string;
  },
  now: Date = new Date(),
): Promise<{ entries: SpendingEntry[]; since: Date | null; cycleMissing: boolean }> {
  const start = await windowStart(db, options.window, options.timeZone, now);
  if (start.kind === 'no_cycle') return { entries: [], since: null, cycleMissing: true };

  const since = start.kind === 'since' ? start.date : null;

  const allocations = await db.transactionAllocation.findMany({
    where: {
      transaction: {
        archivedAt: null,
        kind: 'normal',
        ...(since ? { postedAt: { gte: since } } : {}),
      },
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

  return { entries, since, cycleMissing: false };
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
   * True for the cycle still open — the one since the most recent Delegate
   * press — so a half-finished cycle is not compared against whole ones as
   * though it were.
   *
   * It said "a cycle containing a third payday" and described biweekly pay. The
   * code never did that, and the pay cadence is a setting now, so the comment
   * was wrong twice over.
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
