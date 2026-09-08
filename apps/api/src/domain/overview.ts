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
  readonly spending_by_grouping?: OverviewSpending;
  readonly spending_by_delegation?: OverviewSpending;
  readonly asset_debt_composition?: Composition;
  readonly utilities_vs_delegated?: UtilitiesView;
  readonly delegation_movers?: {
    readonly movers: readonly Mover[];
    readonly cycleMissing: boolean;
  };
  readonly uncategorized_backlog?: OverviewBacklog;
}

export async function buildOverview(
  db: Db,
  options: {
    readonly tiles: readonly OverviewTileKey[];
    readonly window: SpendingWindow;
    readonly timeZone: string;
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
    wanted.has('utilities_vs_delegated') ? buildUtilities(db, options.timeZone, now) : undefined,
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
    ...(utilities ? { utilities_vs_delegated: utilities } : {}),
    ...(movers ? { delegation_movers: movers } : {}),
    ...(backlog ? { uncategorized_backlog: backlog } : {}),
  };
}
