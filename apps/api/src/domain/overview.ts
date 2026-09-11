import { CYCLES_PER_YEAR, type Cents } from '@budget/shared';
import {
  buildBacklog,
  buildComposition,
  buildCycles,
  buildNegativeDelegations,
  buildSpending,
  windowStart,
  type CycleSummary,
  type NegativeDelegation,
  type Composition,
  type SpendingEntry,
  type SpendingWindow,
} from './insights.js';
import {
  aggregateSeries,
  bucketFor,
  compositionSeries,
  changePerCycle,
  dailyAggregateRows,
  debtTrajectory,
  downsample,
  equitySeries,
  momentum,
  type CompositionPoint,
  type CycleChange,
  type DebtTrajectory,
  type SeriesPoint,
  type Series,
  type SnapshotRange,
} from './snapshot-series.js';
import { getBudgetSettings } from './settings.js';
import type { OutstandingCheck } from './checks.js';
import { addMonthsToKey, localDayKey, localMonthKey, startOfLocalDay } from './calendar.js';
import { buildUtilities, type UtilitiesView } from './utilities.js';
import type { Db } from '../db/client.js';

/**
 * Overview: the tiles a person has, and only those.
 *
 * The page this replaces asks `GET /api/insights` and gets **everything** —
 * seven builders run on every request whether or not the caller has the widget
 * they feed, and again on every change of the time window. That is most of why
 * Insights feels slow, and it is not a rendering problem, so no amount of
 * redesign would have fixed it.
 *
 * The rule here is the opposite one: nothing is computed that nobody asked for.
 * `buildOverview` is given the caller's own tiles and dispatches per key, so a
 * page holding two tiles costs two queries' worth of work rather than seven.
 *
 * ## The catalogue grows a batch at a time
 *
 * `OVERVIEW_TILES` is deliberately *not* `INSIGHT_WIDGETS`. Overview replaces
 * Insights over several releases, porting tiles in batches, and a catalogue that
 * advertised all twenty-one from the first release would let somebody add a tile
 * this page cannot draw yet — which reads as a bug rather than as work in
 * progress. A key is added here in the release that can actually draw it.
 */

export const OVERVIEW_TILES = [
  // Batch A: everything drawn as a ranked bar or a composition. Grouped by what
  // has to be drawn rather than by subject, so one primitive is built once and
  // every tile that needs it gets it — rather than the same chart redesigned
  // five times under five names.
  'spending_by_grouping',
  'spending_by_delegation',
  'asset_debt_composition',
  'utilities_vs_delegated',
  'delegation_movers',

  // Batch B: everything drawn as a line or a stack through the nightly
  // snapshots (ADR 035). Three of these read one aggregate series and two read
  // one composition series, so the shared work is done once per request rather
  // than once per tile — see `buildOverview`.
  'net_worth_over_time',
  'assets_vs_debts',
  'identity_drift',
  'net_worth_composition',
  'bitcoin_value_over_time',
  'home_equity_over_time',
  'debt_trajectory',

  // Batch C: the small ones. Mostly a single figure and the sentence that says
  // what to do about it — the tiles that make this a daily read rather than a
  // weekly one, since a chart answers "what happened" and a number answers
  // "can I spend".
  'delegations_negative',
  'cycle_surplus',
  'income_vs_spending',
  'change_per_cycle',
  'thirty_day_momentum',
  'delegation_burn_rate',

  /*
   * The lines somebody chose to watch, drawn the way the Budget page draws them.
   *
   * Its data is the **budget's own read model** rather than anything computed
   * here: the whole point is that it mirrors that page, and a second query
   * ordering delegations by grouping is a second answer to a question already
   * answered — which is how two places come to disagree. It is in the catalogue
   * so it can be chosen; `buildOverview` computes nothing for it.
   */
  'delegations',

  /*
   * Where the money came from and where it went, as one picture. Its window is
   * its own — see `cashflowWindow` — because it is read as a retrospective at a
   * different cadence from the rest of the page.
   */
  'cashflow',

  /** The band of four figures across the top. One tile, not four. */
  'figures',

  /* Cycle-shaped, all three: every figure on this page is measured from payday. */
  'daily_outflow',
  'income_vs_spending_pace',
  'allocation',
  'upcoming_bills',
  'bills_this_cycle',

  /*
   * The recurring reads, drawn from the same pass over the register that Bills
   * and Utilities use. Two of them are exception lists — usually empty, and
   * worth their space precisely on the weeks they are not.
   */
  'bills_attention',
  'utilities_trend',
  'utilities_adjust',
  'outstanding_checks',

  /* The two that ask "which one", and carry a picker to answer it. */
  'account_balance_history',
  'delegation_balance_history',

  'uncategorized_backlog',
] as const;

export type OverviewTileKey = (typeof OVERVIEW_TILES)[number];

export function isOverviewTile(value: string): value is OverviewTileKey {
  return (OVERVIEW_TILES as readonly string[]).includes(value);
}

export interface OverviewSpending {
  readonly entries: readonly SpendingEntry[];
  readonly since: Date | null;
  /**
   * "Everything" and "no cycle has been run yet" both have no start date and
   * mean opposite things, so the flag says which this is — one should show every
   * transaction and the other should show none.
   */
  readonly cycleMissing: boolean;
}

export interface OverviewBacklog {
  readonly count: number;
  readonly oldestPostedAt: Date | null;
}

export interface Mover {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  /** Signed: negative is a line that emptied over the window. */
  readonly changeCents: Cents;
}

/**
 * Which lines moved most over the window, and in which direction.
 *
 * Read from the nightly snapshots rather than from the ledger, because the
 * question is what a balance *was* on a past date — and that is exactly what
 * ADR 035 records nightly so it never has to be reconstructed again.
 *
 * Deliberately **not** the drill-down `/api/insights/snapshots/delegations`
 * uses. That returns a full point series per delegation so a chart can be drawn
 * through it; this tile shows one number per line, and fetching a quarter of
 * daily history to display a single difference is the shape of waste this whole
 * endpoint exists to stop.
 *
 * The change is last minus first **within the window**, not against today. A
 * line with no snapshot in the window has not been observed and is left out
 * rather than reported as zero — no movement and no evidence are different
 * answers, and only one of them is a fact.
 */
interface WindowedDelegation {
  readonly name: string;
  readonly color: string | null;
  /** Balances in date order across the window. */
  readonly balances: Cents[];
}

/**
 * Every delegation's balances across the window, read once.
 *
 * Both delegation tiles need exactly this and nothing more — movers reduces it
 * to last-minus-first, burn rate to the sum of its downward steps. Reading it
 * twice would be the waste this endpoint exists to stop, and reading the
 * drill-down instead would fetch a full point series per line so a chart could
 * be drawn through it, which neither tile draws.
 */
async function windowedDelegations(
  db: Db,
  start: Awaited<ReturnType<typeof windowStart>>,
): Promise<Map<string, WindowedDelegation>> {
  const rows = await db.delegationSnapshot.findMany({
    where: {
      ...(start.kind === 'since' ? { snapshotDate: { gte: start.date } } : {}),
      delegation: { archivedAt: null },
    },
    orderBy: { snapshotDate: 'asc' },
    select: {
      delegationId: true,
      balanceCents: true,
      delegation: { select: { name: true, grouping: { select: { color: true } } } },
    },
  });

  const byDelegation = new Map<string, WindowedDelegation>();
  for (const row of rows) {
    const existing = byDelegation.get(row.delegationId);
    if (existing) {
      existing.balances.push(row.balanceCents);
      continue;
    }
    byDelegation.set(row.delegationId, {
      name: row.delegation.name,
      color: row.delegation.grouping?.color ?? null,
      balances: [row.balanceCents],
    });
  }
  return byDelegation;
}

/**
 * Which lines moved most over the window, and in which direction.
 *
 * Read from the nightly snapshots rather than from the ledger, because the
 * question is what a balance *was* on a past date — and that is exactly what
 * ADR 035 records nightly so it never has to be reconstructed again.
 *
 * The change is last minus first **within the window**, not against today. A
 * line with no snapshot in the window has not been observed and is left out
 * rather than reported as zero — no movement and no evidence are different
 * answers, and only one of them is a fact.
 */
export async function buildMovers(
  db: Db,
  options: { readonly window: SpendingWindow; readonly timeZone: string },
  now: Date = new Date(),
): Promise<{ movers: Mover[]; cycleMissing: boolean }> {
  const start = await windowStart(db, options.window, options.timeZone, now);
  if (start.kind === 'no_cycle') return { movers: [], cycleMissing: true };

  const byDelegation = await windowedDelegations(db, start);

  const movers = [...byDelegation.entries()].map(([delegationId, entry]) => ({
    delegationId,
    name: entry.name,
    color: entry.color,
    changeCents: (entry.balances[entry.balances.length - 1] ?? 0n) - (entry.balances[0] ?? 0n),
  }));

  /*
   * Ranked by size of movement, not by direction. The question is "what moved",
   * and a line that emptied by $400 is as interesting as one that filled by
   * $400 — sorting signed would bury every emptied line at the bottom, which is
   * the half somebody is usually looking for.
   */
  movers.sort((a, b) => {
    const left = a.changeCents < 0n ? -a.changeCents : a.changeCents;
    const right = b.changeCents < 0n ? -b.changeCents : b.changeCents;
    return right > left ? 1 : right < left ? -1 : a.name.localeCompare(b.name);
  });

  // A line that did not move is not a mover. It would otherwise pad the tile
  // with zero-length bars and push the real movement off the bottom.
  return { movers: movers.filter((mover) => mover.changeCents !== 0n), cycleMissing: false };
}

export interface BurnRate {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  /** What this line spends in one pay cycle, at the rate observed. */
  readonly perCycleCents: Cents;
}

/**
 * How fast each line empties, per pay cycle.
 *
 * Only the **downward** steps count. A delegation is refilled every Delegate
 * press, so netting the rises against the falls would report a line that is
 * funded exactly as fast as it is spent as burning nothing at all — which is
 * true of almost every healthy envelope and useless as an answer.
 *
 * Scaled from the days actually covered to the length of one cycle, so a
 * thirty-day window and a year-to-date one are read against the same unit.
 */
export async function buildBurnRates(
  db: Db,
  options: { readonly window: SpendingWindow; readonly timeZone: string },
  now: Date = new Date(),
): Promise<{ rates: BurnRate[]; cycleMissing: boolean }> {
  const start = await windowStart(db, options.window, options.timeZone, now);
  if (start.kind === 'no_cycle') return { rates: [], cycleMissing: true };

  const [byDelegation, settings] = await Promise.all([
    windowedDelegations(db, start),
    getBudgetSettings(db),
  ]);
  const cyclesPerYear = CYCLES_PER_YEAR[settings.payCadence];
  // Hundredths of a day, so the scaling stays in integers throughout.
  const cycleDays = BigInt(Math.round((365 / cyclesPerYear) * 100));

  const rates: BurnRate[] = [];
  for (const [delegationId, entry] of byDelegation) {
    if (entry.balances.length < 2) continue;

    let spent = 0n;
    for (let index = 1; index < entry.balances.length; index += 1) {
      const previous = entry.balances[index - 1] ?? 0n;
      const current = entry.balances[index] ?? 0n;
      if (current < previous) spent += previous - current;
    }
    if (spent === 0n) continue;

    const days = BigInt(entry.balances.length);
    rates.push({
      delegationId,
      name: entry.name,
      color: entry.color,
      perCycleCents: (spent * cycleDays) / (days * 100n),
    });
  }

  rates.sort((a, b) =>
    b.perCycleCents > a.perCycleCents
      ? 1
      : b.perCycleCents < a.perCycleCents
        ? -1
        : a.name.localeCompare(b.name),
  );

  return { rates, cycleMissing: false };
}

/**
 * Every key is optional, and an absent key means "not asked for" rather than
 * "empty".
 *
 * Those are different answers and the client has to be able to tell them apart:
 * a tile nobody has should render nothing at all, while a tile somebody has with
 * no data behind it should render its empty state. Collapsing the two would put
 * `No spending in this window.` on a page that was never asked to show spending.
 */
/** Which tiles read which shared series. One computation serves all of them. */
const AGGREGATE_TILES = ['net_worth_over_time', 'assets_vs_debts', 'identity_drift'] as const;
const COMPOSITION_TILES = ['net_worth_composition', 'bitcoin_value_over_time'] as const;
/** Three derived views over one set of daily rows, so the rows are read once. */
const DAILY_TILES = ['debt_trajectory', 'change_per_cycle', 'thirty_day_momentum'] as const;
/*
 * Movers and burn rate read the same delegation balances, and each fetches them
 * for itself rather than sharing one read.
 *
 * Deliberate, and the cheaper trade of the two: the duplication is one indexed
 * query over one household's snapshots, and it only happens when both tiles are
 * on the same page. Sharing it would mean threading a pre-fetched map through
 * two exported functions that are otherwise independently callable and
 * independently tested — complexity paid on every read of the code to save a
 * query on some of the requests. `windowedDelegations` is the shared piece, and
 * that is the part worth sharing.
 */
/** Both are a reading of the same cycle summaries. */
const CYCLE_TILES = ['cycle_surplus', 'income_vs_spending'] as const;

export interface OverviewComposition {
  readonly points: readonly CompositionPoint[];
  readonly days: number;
}

export interface CashflowNode {
  readonly key: string;
  readonly name: string;
  readonly amountCents: Cents;
}

export interface Cashflow {
  /** Where money came from, largest first. */
  readonly inflows: readonly CashflowNode[];
  /** Where it went, by grouping, largest first. */
  readonly outflows: readonly CashflowNode[];
  /** Deposits nobody has marked as income yet. */
  readonly uncategorizedInCents: Cents;
  /** Spending nobody has filed yet. */
  readonly uncategorizedOutCents: Cents;
  /** What is left. Negative means more went out than came in. */
  readonly surplusCents: Cents;
  readonly totalInCents: Cents;
  readonly cycleMissing: boolean;
}

/**
 * Cashflow: sources on the left, destinations on the right, one total between.
 *
 * **The right-hand side already existed** as `spending_by_grouping`. The left
 * did not, and could not, because income in Delegate allocates to nothing by
 * design — "waiting to be categorized" means waiting for a decision, and income
 * has no decision to make. So there is no stored answer to "which income is
 * this", and the sources have to be inferred.
 *
 * They are inferred the way bills are: grouped by `merchantKey`, and named by
 * the **newest transaction's own description**. That is deliberately the same
 * machinery ADR 045 uses rather than a second one — `merchantKey` is already
 * load-bearing in four places, and a fifth idea of what makes two rows the same
 * payer would be a fifth thing to keep in step. It also means a source first
 * appears as whatever the bank's descriptor says, which is the honest starting
 * point: naming it is a correction somebody makes, not a guess this makes.
 *
 * **Uncategorized appears on both sides and is not filler.** A deposit nobody
 * has marked as income and a charge nobody has filed are both real money moving
 * through, and drawing them as a category would say the household spends a third
 * of its income on something called "Uncategorized". They are the one thing on
 * this chart somebody can act on, so they are drawn in the warning tone and the
 * tile links to the queue.
 *
 * **The two sides sum to the same figure by construction**, because surplus is
 * defined as the remainder rather than measured independently. A Sankey whose
 * sides disagree is a Sankey that cannot be drawn, and computing the surplus
 * some other way would eventually produce one.
 */
export async function buildCashflow(
  db: Db,
  options: { readonly window: SpendingWindow; readonly timeZone: string },
  now: Date = new Date(),
): Promise<Cashflow> {
  const empty = {
    inflows: [],
    outflows: [],
    uncategorizedInCents: 0n,
    uncategorizedOutCents: 0n,
    surplusCents: 0n,
    totalInCents: 0n,
  };

  const start = await windowStart(db, options.window, options.timeZone, now);
  if (start.kind === 'no_cycle') return { ...empty, cycleMissing: true };

  const since = start.kind === 'since' ? { postedAt: { gte: start.date } } : {};

  const [income, loose, spending] = await Promise.all([
    // Income is the same predicate `buildCycles` uses. Two figures for "what
    // came in" that disagreed would be worse than either of them alone.
    db.transaction.groupBy({
      by: ['source'],
      where: { archivedAt: null, kind: 'income', ...since },
      _sum: { amountCents: true },
    }),
    // Ordinary rows nobody has filed. Positive is a deposit not yet marked as
    // income; negative is spending not yet categorized.
    db.transaction.findMany({
      where: { archivedAt: null, kind: 'normal', allocations: { none: {} }, ...since },
      select: { amountCents: true },
    }),
    buildSpending(db, { by: 'grouping', window: options.window, timeZone: options.timeZone }, now),
  ]);

  /*
   * Two nodes at most: what the feed delivered, and what was typed by hand.
   *
   * ADR 052 inferred a source per payer from `merchantKey` and named it by the
   * newest description. On real data that produced a left column of bank
   * strings — `ACH Deposit 12208 ELO PROF L PAYROLL 13977925` — about 420px of
   * text in a 448px gap, and the same employer drawn twice because the
   * hand-entered rows carried a prefix the key split on.
   *
   * The grouping is `source` instead, which is a fact the database records
   * rather than a convention in somebody's typing. Two nodes, both named for
   * what they are: money the bank reported, and money entered while its feed was
   * behind. The second is a standing signal that the balances are part bank and
   * part household — the same thing the `a` chip says on an account row — and it
   * disappears on its own once the feed catches up and those rows are archived.
   */
  const sources = new Map<string, { name: string; amountCents: Cents }>();
  for (const row of income) {
    const manual = row.source === 'manual';
    const key = manual ? 'manual' : 'feed';
    const existing = sources.get(key);
    const amount = row._sum.amountCents ?? 0n;
    if (existing) {
      existing.amountCents += amount;
      continue;
    }
    sources.set(key, { name: manual ? 'Income (manual)' : 'Income', amountCents: amount });
  }

  let uncategorizedInCents = 0n;
  let uncategorizedOutCents = 0n;
  for (const row of loose) {
    if (row.amountCents > 0n) uncategorizedInCents += row.amountCents;
    else uncategorizedOutCents += -row.amountCents;
  }

  const inflows = [...sources.entries()]
    .map(([key, entry]) => ({ key, name: entry.name, amountCents: entry.amountCents }))
    .filter((node) => node.amountCents > 0n)
    .sort((a, b) =>
      b.amountCents > a.amountCents
        ? 1
        : b.amountCents < a.amountCents
          ? -1
          : a.name.localeCompare(b.name),
    );

  const outflows = spending.entries
    .filter((entry) => entry.spendCents > 0n)
    .map((entry) => ({ key: entry.key, name: entry.name, amountCents: entry.spendCents }));

  const totalInCents =
    inflows.reduce((sum, node) => sum + node.amountCents, 0n) + uncategorizedInCents;
  const spentCents = outflows.reduce((sum, node) => sum + node.amountCents, 0n);

  return {
    inflows,
    outflows,
    uncategorizedInCents,
    uncategorizedOutCents,
    // The remainder, never measured separately: the two sides of a Sankey have
    // to sum to the same figure or it cannot be drawn.
    surplusCents: totalInCents - spentCents - uncategorizedOutCents,
    totalInCents,
    cycleMissing: false,
  };
}

export interface OverviewData {
  /**
   * One aggregate series, not three.
   *
   * Net worth over time, assets against debts and identity drift are the same
   * stored rows read differently — every field each of them needs is on every
   * point. Sending it three times under three keys would be three copies of a
   * year of history to say the same thing, and computing it three times would
   * be the waste this endpoint exists to stop.
   */
  readonly aggregate?: Series;
  readonly composition?: OverviewComposition;
  readonly home_equity_over_time?: {
    readonly name: string | null;
    readonly points: readonly {
      readonly date: Date;
      readonly provenance: string;
      readonly fields: Readonly<Record<string, bigint>>;
    }[];
    readonly days: number;
  };
  readonly debt_trajectory?: DebtTrajectory;
  readonly change_per_cycle?: readonly CycleChange[];
  readonly thirty_day_momentum?: readonly SeriesPoint[];
  readonly delegations_negative?: readonly NegativeDelegation[];
  readonly cycles?: readonly CycleSummary[];
  readonly delegation_burn_rate?: {
    readonly rates: readonly BurnRate[];
    readonly cycleMissing: boolean;
  };
  readonly cashflow?: Cashflow;
  readonly figures?: readonly Figure[];
  readonly daily_outflow?: readonly OutflowDay[];
  readonly income_vs_spending_pace?: readonly PacePoint[];
  readonly allocation?: readonly AllocationSlice[];
  readonly upcoming_bills?: readonly UpcomingBill[];
  readonly account_balance_history?: {
    readonly name: string | null;
    readonly points: readonly {
      date: Date;
      provenance: string;
      fields: Readonly<Record<string, Cents>>;
    }[];
  };
  readonly delegation_balance_history?: {
    readonly name: string | null;
    readonly points: readonly { date: Date; provenance: string; balanceCents: Cents }[];
  };
  /** What the two picker tiles can be pointed at. Only things with history. */
  readonly pickable?: { accounts: readonly PickableThing[]; delegations: readonly PickableThing[] };
  readonly spending_by_grouping?: OverviewSpending;
  readonly spending_by_delegation?: OverviewSpending;
  readonly asset_debt_composition?: Composition;
  readonly utilities_vs_delegated?: UtilitiesView;
  readonly delegation_movers?: {
    readonly movers: readonly Mover[];
    readonly cycleMissing: boolean;
  };
  readonly outstanding_checks?: readonly OutstandingCheck[];
  readonly uncategorized_backlog?: OverviewBacklog;
}

export async function buildOverview(
  db: Db,
  options: {
    readonly tiles: readonly OverviewTileKey[];
    readonly window: SpendingWindow;
    readonly timeZone: string;
    /**
     * The cashflow tile's own window, which is not the page's.
     *
     * It answers "where did it go", read as a retrospective at a different
     * cadence from the figures around it — so it carries its own control and
     * defaults to year-to-date. The page's period governs everything else.
     */
    readonly cashflowWindow?: SpendingWindow;
  },
  now: Date = new Date(),
): Promise<OverviewData> {
  // A layout cannot hold a duplicate — `overview_tiles` has a unique index over
  // (user, widget) — but this is called with a list, and a list that arrived
  // from anywhere else must not cost the same query twice.
  const wanted = new Set<OverviewTileKey>(options.tiles);

  // The snapshot range vocabulary is the same list as the spending windows, so
  // one selector drives every tile and nothing has to be mapped between them —
  // TypeScript agrees, which is why this needs no cast.
  const range: SnapshotRange = options.window;
  const wantsAggregate = AGGREGATE_TILES.some((key) => wanted.has(key));
  const wantsComposition = COMPOSITION_TILES.some((key) => wanted.has(key));
  const wantsDaily = DAILY_TILES.some((key) => wanted.has(key));
  const wantsCycles = CYCLE_TILES.some((key) => wanted.has(key));

  const [
    byGrouping,
    byDelegation,
    accountComposition,
    utilities,
    movers,
    backlog,
    aggregate,
    composition,
    equity,
    daily,
    negative,
    cycles,
    burnRates,
    cashflow,
  ] = await Promise.all([
    wanted.has('spending_by_grouping')
      ? buildSpending(
          db,
          { by: 'grouping', window: options.window, timeZone: options.timeZone },
          now,
        )
      : undefined,
    wanted.has('spending_by_delegation')
      ? buildSpending(
          db,
          { by: 'delegation', window: options.window, timeZone: options.timeZone },
          now,
        )
      : undefined,
    wanted.has('asset_debt_composition') ? buildComposition(db) : undefined,
    /*
     * One pass serves all three utility tiles — funded-against-actual, the
     * trend, and what is worth adjusting are three readings of the same
     * twenty-four months.
     */
    wanted.has('utilities_vs_delegated') ||
    wanted.has('utilities_trend') ||
    wanted.has('utilities_adjust')
      ? buildUtilities(db, options.timeZone, now)
      : undefined,
    wanted.has('delegation_movers')
      ? buildMovers(db, { window: options.window, timeZone: options.timeZone }, now)
      : undefined,
    wanted.has('uncategorized_backlog') ? buildBacklog(db) : undefined,
    wantsAggregate ? aggregateSeries(db, range, now) : undefined,
    wantsComposition ? compositionSeries(db, range, now) : undefined,
    wanted.has('home_equity_over_time') ? equitySeries(db, range, now) : undefined,
    wantsDaily ? dailyAggregateRows(db, range, now) : undefined,
    wanted.has('delegations_negative') ? buildNegativeDelegations(db) : undefined,
    wantsCycles ? buildCycles(db) : undefined,
    wanted.has('delegation_burn_rate')
      ? buildBurnRates(db, { window: options.window, timeZone: options.timeZone }, now)
      : undefined,
    wanted.has('cashflow')
      ? buildCashflow(
          db,
          { window: options.cashflowWindow ?? 'ytd', timeZone: options.timeZone },
          now,
        )
      : undefined,
  ]);

  return {
    ...(byGrouping ? { spending_by_grouping: byGrouping } : {}),
    ...(byDelegation ? { spending_by_delegation: byDelegation } : {}),
    ...(accountComposition ? { asset_debt_composition: accountComposition } : {}),
    ...(aggregate ? { aggregate } : {}),
    ...(composition ? { composition: { points: composition.points, days: composition.days } } : {}),
    ...(equity ? { home_equity_over_time: equity } : {}),
    // The trajectory is derived from the daily rows rather than stored, and it
    // needs the bucket the rest of the page is drawn at so the projection lines
    // up with the history behind it.
    ...(daily && wanted.has('debt_trajectory')
      ? { debt_trajectory: debtTrajectory(daily, bucketFor(daily.length)) }
      : {}),
    ...(daily && wanted.has('change_per_cycle')
      ? { change_per_cycle: await changePerCycle(db, daily) }
      : {}),
    ...(daily && wanted.has('thirty_day_momentum')
      ? {
          // Computed on the daily rows before bucketing: a rolling window over
          // weekly averages is a different and much blunter thing.
          thirty_day_momentum: downsample(momentum(daily), bucketFor(daily.length)),
        }
      : {}),
    ...(negative ? { delegations_negative: negative } : {}),
    ...(cycles ? { cycles } : {}),
    ...(burnRates ? { delegation_burn_rate: burnRates } : {}),
    ...(cashflow ? { cashflow } : {}),
    ...(utilities ? { utilities_vs_delegated: utilities } : {}),
    ...(movers ? { delegation_movers: movers } : {}),
    ...(backlog ? { uncategorized_backlog: backlog } : {}),
  };
}

export interface PanelLine {
  readonly id: string;
  readonly name: string;
  readonly groupingId: string | null;
  readonly groupingName: string | null;
  readonly color: string | null;
  /** What the line holds now. Negative is overspent. */
  readonly balanceCents: Cents;
  /** What each Delegate press puts in. Null on an ad-hoc line. */
  readonly plannedCents: Cents | null;
  /** Spending allocated to this line since the cycle began. */
  readonly spentCents: Cents;
}

/**
 * The panel's delegations: the lines somebody chose, with everything a pace bar
 * needs.
 *
 * **"Since the cycle began" means since the payday**, not since the last
 * Delegate press, and the distinction is worth stating because both exist.
 *
 * A press is where money moves; a payday is where time is measured from. The
 * bar compares one against the other, so its numerator and its tick have to
 * share a window — measuring spending from the press while measuring time from
 * the payday would put a line's fill and the tick judging it on two different
 * clocks, and the gap between them would show up as a line looking behind for no
 * reason on any cycle where the press ran late.
 *
 * With no anchor set there is no payday to measure from, so it falls back to the
 * press boundary — which is what this application has always meant by "cycle",
 * and it keeps every figure on the page working before the anchor is entered.
 */
export async function buildPanel(
  db: Db,
  options: {
    readonly since: Date | null;
    readonly timeZone: string;
  },
  now: Date = new Date(),
): Promise<PanelLine[]> {
  const since =
    options.since ??
    (await windowStart(db, 'cycle', options.timeZone, now).then((start) =>
      start.kind === 'since' ? start.date : null,
    ));

  const [lines, allocations] = await Promise.all([
    db.delegation.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        balanceCents: true,
        amountToDelegateCents: true,
        position: true,
        grouping: { select: { id: true, name: true, color: true, position: true } },
      },
    }),
    db.transactionAllocation.findMany({
      where: {
        transaction: {
          archivedAt: null,
          kind: 'normal',
          ...(since ? { postedAt: { gte: since } } : {}),
        },
      },
      select: { delegationId: true, amountCents: true },
    }),
  ]);

  // Spending is stored signed and negative; the bar reads a magnitude.
  const spent = new Map<string, Cents>();
  for (const allocation of allocations) {
    spent.set(
      allocation.delegationId,
      (spent.get(allocation.delegationId) ?? 0n) - allocation.amountCents,
    );
  }

  /*
   * The Budget page's own order: grouping position, then the line's position,
   * then name. Not alphabetical — the owner's groupings are named "3 - Food"
   * and "5 - Home" because ordering was the thing missing before positions
   * existed, and sorting by name here would undo a deliberate arrangement.
   */
  return lines
    .map((line) => ({
      id: line.id,
      name: line.name,
      groupingId: line.grouping?.id ?? null,
      groupingName: line.grouping?.name ?? null,
      color: line.grouping?.color ?? null,
      balanceCents: line.balanceCents,
      plannedCents: line.amountToDelegateCents,
      spentCents: (() => {
        const value = spent.get(line.id) ?? 0n;
        // A refunded line can net positive over the window; that is not
        // negative spending, it is none.
        return value > 0n ? value : 0n;
      })(),
      _groupPosition: line.grouping?.position ?? Number.MAX_SAFE_INTEGER,
      _position: line.position,
    }))
    .sort(
      (a, b) =>
        a._groupPosition - b._groupPosition ||
        (a.groupingName ?? '').localeCompare(b.groupingName ?? '') ||
        a._position - b._position ||
        a.name.localeCompare(b.name),
    )
    .map(({ _groupPosition: _g, _position: _p, ...line }) => line);
}

export const FIGURE_KEYS = [
  'inflow',
  'spent',
  'left_to_spend',
  'uncategorized',
  'safe_per_day',
  'net_worth',
  'days_to_payday',
] as const;

export type FigureKey = (typeof FIGURE_KEYS)[number];

export function isFigureKey(value: string): value is FigureKey {
  return (FIGURE_KEYS as readonly string[]).includes(value);
}

export interface Figure {
  readonly key: FigureKey;
  /** Cents, or null where the figure has no answer yet. */
  readonly valueCents: Cents | null;
  /** For the two that are counts rather than money. */
  readonly count: number | null;
}

/**
 * The figures a person chose for the band across the top.
 *
 * One tile drawing four numbers rather than four tiles, because a row holds two
 * and four separate tiles would fill the first screen before a chart appeared.
 * Which four is a per-tile setting, which is also what makes the catalogue here
 * able to be longer than the band is wide.
 *
 * **`safe_per_day` divides by days left in the cycle, not the month.** Every
 * other figure on this page is cycle-shaped, and a month divisor would be the
 * one number measuring something different — which is the sort of thing nobody
 * notices until they have trusted it for a fortnight.
 */
export async function buildFigures(
  db: Db,
  options: {
    readonly keys: readonly FigureKey[];
    readonly timeZone: string;
    readonly cycleStart: Date | null;
    readonly daysLeftInCycle: number | null;
  },
): Promise<Figure[]> {
  const wanted = new Set(options.keys);
  if (wanted.size === 0) return [];

  const since = options.cycleStart;
  const inCycle = since ? { postedAt: { gte: since } } : {};

  const needsFlow =
    wanted.has('inflow') ||
    wanted.has('spent') ||
    wanted.has('left_to_spend') ||
    wanted.has('safe_per_day');

  const [flow, backlog, composition] = await Promise.all([
    needsFlow
      ? db.transaction.findMany({
          where: { archivedAt: null, kind: { in: ['income', 'normal'] }, ...inCycle },
          select: { amountCents: true, kind: true },
        })
      : undefined,
    wanted.has('uncategorized') ? buildBacklog(db) : undefined,
    wanted.has('net_worth') ? buildComposition(db) : undefined,
  ]);

  const inflow = sumOf(flow, 'income');
  // Spending is stored negative; report a magnitude.
  const spent = -sumOf(flow, 'normal');
  const left = inflow - spent;

  const figures: Figure[] = [];
  for (const key of options.keys) {
    switch (key) {
      case 'inflow':
        figures.push({ key, valueCents: inflow, count: null });
        break;
      case 'spent':
        figures.push({ key, valueCents: spent, count: null });
        break;
      case 'left_to_spend':
        figures.push({ key, valueCents: left, count: null });
        break;
      case 'safe_per_day':
        figures.push({
          key,
          // Null rather than dividing by nothing: with no anchor there is no
          // cycle to spread it over, and a figure invented from a guess is
          // worse than an absent one.
          valueCents:
            options.daysLeftInCycle && options.daysLeftInCycle > 0
              ? left / BigInt(options.daysLeftInCycle)
              : null,
          count: null,
        });
        break;
      case 'uncategorized':
        figures.push({ key, valueCents: null, count: backlog?.count ?? 0 });
        break;
      case 'net_worth':
        figures.push({ key, valueCents: composition?.netCents ?? 0n, count: null });
        break;
      case 'days_to_payday':
        figures.push({ key, valueCents: null, count: options.daysLeftInCycle });
        break;
    }
  }
  return figures;
}

function sumOf(rows: { amountCents: Cents; kind: string }[] | undefined, kind: string): Cents {
  if (!rows) return 0n;
  return rows.reduce((total, row) => (row.kind === kind ? total + row.amountCents : total), 0n);
}

export interface UpcomingBill {
  readonly key: string;
  readonly name: string;
  readonly expectedNextAt: Date;
  readonly typicalAmountCents: Cents;
  readonly delegationName: string | null;
}

export interface OutflowDay {
  readonly date: Date;
  readonly spentCents: Cents;
}

/** The calendar month `now` falls in, in the household's own zone. */
export function monthBounds(
  now: Date,
  timeZone: string,
): { readonly start: Date; readonly end: Date } {
  const start = localMonthKey(now, timeZone);
  return { start, end: addMonthsToKey(start, 1) };
}

/**
 * What went out on each day, over the calendar month and the two before it.
 *
 * The one reading on this page that is not cycle-shaped, and deliberately so.
 * Everything else here answers "how am I doing against this cycle's plan", which
 * needs the cycle; this answers "what did each day cost", and days belong to
 * months — bills arrive on dates, statements close on dates, and "the 1st was
 * the big one" is how anybody describes their own spending.
 *
 * It was built cycle-shaped first, on the argument that one calendar-shaped
 * figure among cycle-shaped ones is the reading somebody has to remember is
 * different. The owner overruled it, and the tile says which month it is drawing
 * so there is nothing to remember.
 *
 * It also needs no payday anchor, which makes it the one cycle-adjacent tile
 * that works on a household that has never set one.
 *
 * **Three months, not one.** A single band says how this month is going and
 * nothing about whether that is unusual, which is the question a spending
 * pattern is actually asked. Three stacked bands, on **one shared scale**, make
 * the comparison the picture rather than something to work out: the darkest cell
 * anywhere is the worst day of the quarter, wherever it falls.
 *
 * Every day in a month gets a cell, including the ones nothing happened on. A
 * band that skipped empty days would compress a quiet fortnight into the width
 * of a busy one and say something false about the shape of the month — the same
 * mistake the utility charts avoid by keeping an empty month between two bills.
 *
 * The months are **not** padded to a common length. Aligning them by day of the
 * month is what makes a column comparable — the 1st over the 1st — so a 30-day
 * month is a row of 30 against a row of 31, and stops one cell short. Padding
 * them equal would put the 28th of February under the 30th of March.
 */
export async function buildOutflow(
  db: Db,
  options: {
    readonly start: Date;
    readonly end: Date;
    readonly timeZone: string;
  },
): Promise<OutflowDay[]> {
  const rows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      amountCents: { lt: 0 },
      postedAt: {
        gte: startOfLocalDay(options.start, options.timeZone),
        lt: startOfLocalDay(options.end, options.timeZone),
      },
    },
    select: { amountCents: true, postedAt: true },
  });

  const byDay = new Map<number, Cents>();
  for (const row of rows) {
    // An instant needs a zone to be placed in a day. ADR 037, and the reason an
    // evening charge once landed in the wrong month.
    const key = localDayKey(row.postedAt, options.timeZone).getTime();
    byDay.set(key, (byDay.get(key) ?? 0n) - row.amountCents);
  }

  const days: OutflowDay[] = [];
  const cursor = new Date(options.start.getTime());
  while (cursor.getTime() < options.end.getTime()) {
    days.push({ date: new Date(cursor.getTime()), spentCents: byDay.get(cursor.getTime()) ?? 0n });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface OutflowMonth {
  /** First day of the month, as a day key. */
  readonly month: Date;
  readonly days: readonly OutflowDay[];
}

/**
 * The band's months, newest first.
 *
 * One query per month rather than one for the span, because each month's bounds
 * are its own and the alternative is slicing a flat list back into months by
 * date arithmetic that `buildOutflow` already does correctly.
 */
export async function buildOutflowMonths(
  db: Db,
  options: { readonly timeZone: string; readonly months: number },
  now: Date = new Date(),
): Promise<OutflowMonth[]> {
  const current = localMonthKey(now, options.timeZone);

  return Promise.all(
    Array.from({ length: options.months }, (_unused, back) => addMonthsToKey(current, -back)).map(
      async (month) => ({
        month,
        days: await buildOutflow(db, {
          start: month,
          end: addMonthsToKey(month, 1),
          timeZone: options.timeZone,
        }),
      }),
    ),
  );
}

export interface PacePoint {
  readonly date: Date;
  readonly inflowCents: Cents;
  readonly spentCents: Cents;
  /** Null after today: the future has no figure, and a flat line would imply one. */
  readonly observed: boolean;
}

/**
 * Money in against money out, both running totals, across the cycle.
 *
 * The two lines stop at today. Carrying them flat to the end of the cycle would
 * draw a fortnight of spending nothing, which is a claim about the future rather
 * than a record of the past — and on a chart whose whole job is pace, a flat
 * tail reads as being comfortably ahead.
 */
export async function buildPace(
  db: Db,
  options: {
    readonly start: Date;
    readonly end: Date;
    readonly timeZone: string;
  },
  now: Date = new Date(),
): Promise<PacePoint[]> {
  const rows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: { in: ['income', 'normal'] },
      postedAt: { gte: startOfLocalDay(options.start, options.timeZone) },
    },
    select: { amountCents: true, kind: true, postedAt: true },
  });

  const inflowByDay = new Map<number, Cents>();
  const spentByDay = new Map<number, Cents>();
  for (const row of rows) {
    const key = localDayKey(row.postedAt, options.timeZone).getTime();
    if (row.kind === 'income') inflowByDay.set(key, (inflowByDay.get(key) ?? 0n) + row.amountCents);
    else if (row.amountCents < 0n)
      spentByDay.set(key, (spentByDay.get(key) ?? 0n) - row.amountCents);
  }

  const today = localDayKey(now, options.timeZone).getTime();
  const points: PacePoint[] = [];
  let inflow = 0n;
  let spent = 0n;

  const cursor = new Date(options.start.getTime());
  while (cursor.getTime() < options.end.getTime()) {
    const key = cursor.getTime();
    inflow += inflowByDay.get(key) ?? 0n;
    spent += spentByDay.get(key) ?? 0n;
    points.push({
      date: new Date(key),
      inflowCents: inflow,
      spentCents: spent,
      observed: key <= today,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

export interface AllocationSlice {
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly amountCents: Cents;
}

/**
 * What is delegated where — either the plan or the position.
 *
 * `plan` is each grouping's sum of amount-to-delegate: what every payday puts
 * where, and therefore what the household's priorities actually are. It moves
 * only when somebody changes the plan, which is what makes it recognisable at a
 * glance.
 *
 * `position` is each grouping's total balance: where the money is sitting right
 * now. It moves as the cycle is spent, so the proportions drift with the timing
 * of bills rather than with anything anybody decided.
 *
 * Two readings of one subject, which is why they are one tile with a switch
 * rather than two tiles.
 */
/**
 * Both readings, from one pass.
 *
 * The tile switches between them, and switching used to write the choice to the
 * layout and wait for the whole page to be recomputed before the donut redrew —
 * about a second, for a toggle. They are the same rows summed two ways, so they
 * are sent together and the switch is a local one; the write still happens, to
 * remember the choice, but nothing waits for it.
 */
export async function buildAllocations(
  db: Db,
): Promise<{ plan: AllocationSlice[]; position: AllocationSlice[] }> {
  const [plan, position] = await Promise.all([
    buildAllocation(db, 'plan'),
    buildAllocation(db, 'position'),
  ]);
  return { plan, position };
}

export async function buildAllocation(
  db: Db,
  mode: 'plan' | 'position',
): Promise<AllocationSlice[]> {
  const lines = await db.delegation.findMany({
    where: { archivedAt: null },
    select: {
      balanceCents: true,
      amountToDelegateCents: true,
      grouping: { select: { id: true, name: true, color: true, position: true, systemKey: true } },
    },
  });

  const totals = new Map<string, AllocationSlice & { position: number }>();
  for (const line of lines) {
    // Outstanding Checks is the budget's own grouping — money that has left in
    // paper form rather than a category anybody filed under.
    if (line.grouping?.systemKey === 'outstanding-checks') continue;

    const amount = mode === 'plan' ? (line.amountToDelegateCents ?? 0n) : line.balanceCents;
    if (amount <= 0n) continue;

    const key = line.grouping?.id ?? 'ungrouped';
    const existing = totals.get(key);
    if (existing) {
      totals.set(key, { ...existing, amountCents: existing.amountCents + amount });
      continue;
    }
    totals.set(key, {
      key,
      name: line.grouping?.name ?? 'No grouping',
      color: line.grouping?.color ?? null,
      amountCents: amount,
      position: line.grouping?.position ?? Number.MAX_SAFE_INTEGER,
    });
  }

  return [...totals.values()]
    .sort((a, b) => (b.amountCents > a.amountCents ? 1 : b.amountCents < a.amountCents ? -1 : 0))
    .map(({ position: _position, ...slice }) => slice);
}

export interface PickableThing {
  readonly id: string;
  readonly name: string;
}

/**
 * One delegation's balance over time.
 *
 * A lean read rather than `delegationDrillDown`, which returns every line of a
 * grouping with a burn rate apiece so a three-level chart can be drawn through
 * it. This tile draws one line, and fetching a quarter's history for
 * twenty-four delegations to show one of them is the waste this endpoint exists
 * to stop.
 */
export async function delegationSeries(
  db: Db,
  delegationId: string,
  since: Date | null,
): Promise<{
  points: { date: Date; provenance: string; balanceCents: Cents }[];
  name: string | null;
}> {
  const [line, rows] = await Promise.all([
    db.delegation.findUnique({ where: { id: delegationId }, select: { name: true } }),
    db.delegationSnapshot.findMany({
      where: { delegationId, ...(since ? { snapshotDate: { gte: since } } : {}) },
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true, provenance: true, balanceCents: true },
    }),
  ]);

  return {
    name: line?.name ?? null,
    points: rows.map((row) => ({
      date: row.snapshotDate,
      provenance: row.provenance,
      balanceCents: row.balanceCents,
    })),
  };
}

/**
 * What the two picker tiles can be pointed at.
 *
 * **Only things with history**, so the picker never offers something that draws
 * an empty box. A list of everything would make choosing wrong the default
 * experience on a household whose snapshots start at the first night.
 */
export async function pickableSeries(
  db: Db,
): Promise<{ accounts: PickableThing[]; delegations: PickableThing[] }> {
  const [accountIds, delegationIds] = await Promise.all([
    db.accountSnapshot.groupBy({ by: ['accountId'] }),
    db.delegationSnapshot.groupBy({ by: ['delegationId'] }),
  ]);

  const [accounts, delegations] = await Promise.all([
    db.account.findMany({
      where: { id: { in: accountIds.map((row) => row.accountId) }, archivedAt: null },
      select: { id: true, name: true, nickname: true },
      orderBy: { name: 'asc' },
    }),
    db.delegation.findMany({
      where: { id: { in: delegationIds.map((row) => row.delegationId) }, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return {
    // The nickname where there is one: "Citibank Costco VISA Costco Anywhere
    // Visa® Card by Citi-7459" is not a thing to choose from a list.
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.nickname ?? account.name,
    })),
    delegations,
  };
}
