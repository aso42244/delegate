import {
  CYCLES_PER_YEAR,
  weakestProvenance,
  type Cents,
  type SnapshotProvenance,
} from '@budget/shared';
import type { Db } from '../db/client.js';
import { getBudgetSettings } from './settings.js';
import { asSnapshotDate, observeDay } from './snapshots.js';

/**
 * Reading the snapshot tables back, already shaped for a chart.
 *
 * Downsampling, bucketing and the derived views all happen here rather than in
 * the browser: the client should be handed something it can draw, not a year of
 * rows to reduce on a phone.
 *
 * Two rules run through everything below. **A bucket takes the weakest
 * provenance of the rows in it** — a week containing one estimated day is an
 * estimated week, because a line drawn through it is no better than its worst
 * point. And **money stays integer**: averages are computed as integer division
 * with explicit rounding, never through a float.
 */

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * The page-level range. One control drives every widget.
 *
 * `ytd` and `cycle` are here because the widgets that predate snapshots are
 * driven by the same selector and those are the windows that mean something to
 * them — a cycle is one Delegate press to the next, which is the only boundary
 * this system recognises.
 */
export const SNAPSHOT_RANGES = ['30d', '90d', '6mo', '1yr', 'ytd', 'cycle', 'all'] as const;
export type SnapshotRange = (typeof SNAPSHOT_RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first date a range includes. Null means "everything stored". */
export async function rangeStart(
  db: Db,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<Date | null> {
  const today = asSnapshotDate(now);
  const back = (days: number): Date => new Date(today.getTime() - days * DAY_MS);

  switch (range) {
    case '30d':
      return back(30);
    case '90d':
      return back(90);
    case '6mo':
      return back(182);
    case '1yr':
      return back(365);
    case 'ytd':
      return new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    case 'cycle': {
      const run = await db.delegateRun.findFirst({
        where: { undoneAt: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Before the first Delegate press there is no cycle, and inventing one
      // would put a number on screen that means nothing.
      return run ? asSnapshotDate(run.createdAt) : null;
    }
    case 'all':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

export type Bucket = 'day' | 'week' | 'month';

/**
 * How coarse the series has to be to stay readable and fast.
 *
 * Roughly 180 points is where a daily line stops being a line and starts being
 * noise on a laptop, and 730 is where a weekly one does the same. The reader
 * never chooses this — it follows from the range they picked.
 */
export function bucketFor(days: number): Bucket {
  if (days > 730) return 'month';
  if (days > 180) return 'week';
  return 'day';
}

/** The date a point is filed under once bucketed. */
function bucketKey(date: Date, bucket: Bucket): Date {
  if (bucket === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  if (bucket === 'week') {
    // Monday. `getUTCDay` is 0 on Sunday, which belongs to the week before it.
    const weekday = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - weekday * DAY_MS);
  }
  return date;
}

/** Mean of integer cents, rounded half away from zero. Never a float. */
function meanCents(values: readonly Cents[]): Cents {
  if (values.length === 0) return 0n;
  const total = values.reduce((sum, value) => sum + value, 0n);
  const count = BigInt(values.length);
  const sign = total < 0n ? -1n : 1n;
  const magnitude = total < 0n ? -total : total;
  return sign * ((magnitude * 2n + count) / (count * 2n));
}

export interface DailyRow {
  readonly date: Date;
  readonly provenance: SnapshotProvenance;
  readonly fields: Readonly<Record<string, Cents>>;
}

export interface SeriesPoint {
  readonly date: Date;
  readonly provenance: SnapshotProvenance;
  readonly fields: Readonly<Record<string, Cents>>;
  /** How many stored days this point averages. One for an un-bucketed day. */
  readonly days: number;
}

/**
 * Collapses daily rows into buckets, averaging each field.
 *
 * The average rather than the last value of the bucket: a weekly point that
 * reported Sunday's balance would swing with whichever day happened to land at
 * the end, and a net worth line is not a sampling of Sundays.
 */
export function downsample(rows: readonly DailyRow[], bucket: Bucket): SeriesPoint[] {
  if (rows.length === 0) return [];
  if (bucket === 'day') {
    return rows.map((row) => ({ ...row, days: 1 }));
  }

  const buckets = new Map<number, DailyRow[]>();
  for (const row of rows) {
    const key = bucketKey(row.date, bucket).getTime();
    const existing = buckets.get(key);
    if (existing) existing.push(row);
    else buckets.set(key, [row]);
  }

  const names = Object.keys(rows[0]?.fields ?? {});

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, group]) => ({
      date: new Date(key),
      // One estimated day makes the whole bucket an estimate. A line drawn
      // through it is no better than its worst point.
      provenance: weakestProvenance(group.map((row) => row.provenance)),
      fields: Object.fromEntries(
        names.map((name) => [name, meanCents(group.map((row) => row.fields[name] ?? 0n))]),
      ),
      days: group.length,
    }));
}

// ---------------------------------------------------------------------------
// The aggregate series
// ---------------------------------------------------------------------------

export interface Series {
  readonly points: readonly SeriesPoint[];
  readonly bucket: Bucket;
  /** The first date stored at all, so the interface can say where history starts. */
  readonly earliest: Date | null;
  /** Stored days in range, before bucketing. The empty states read this. */
  readonly days: number;
  /**
   * The picture as it is right now, appended by the client as a distinct final
   * point. Snapshots are labelled for the previous day, so without this every
   * chart ends a day behind and looks stale rather than current.
   */
  readonly live: Readonly<Record<string, Cents>> | null;
}

const AGGREGATE_FIELDS = [
  'netWorthCents',
  'netWorthAssetsCents',
  'netWorthDebtsCents',
  'budgetAssetsCents',
  'budgetDebtsCents',
  'totalDelegationsCents',
  'pendingCategorizedCents',
  'identityValueCents',
] as const;

export async function aggregateSeries(
  db: Db,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<Series> {
  const start = await rangeStart(db, range, now);

  const [rows, earliest] = await Promise.all([
    db.aggregateSnapshot.findMany({
      where: start ? { snapshotDate: { gte: start } } : {},
      orderBy: { snapshotDate: 'asc' },
    }),
    db.aggregateSnapshot.findFirst({
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true },
    }),
  ]);

  const daily: DailyRow[] = rows.map((row) => ({
    date: row.snapshotDate,
    provenance: row.provenance,
    fields: Object.fromEntries(AGGREGATE_FIELDS.map((name) => [name, row[name]])),
  }));

  const bucket = bucketFor(daily.length);
  const live = await liveAggregate(db, now);

  return {
    points: downsample(daily, bucket),
    bucket,
    earliest: earliest?.snapshotDate ?? null,
    days: daily.length,
    live,
  };
}

/** Today's figures, computed the same way the nightly job computes them. */
async function liveAggregate(db: Db, now: Date): Promise<Record<string, Cents> | null> {
  const day = await observeDay(db, asSnapshotDate(now));
  return Object.fromEntries(AGGREGATE_FIELDS.map((name) => [name, day.aggregate[name]]));
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

export async function accountSeries(
  db: Db,
  accountId: string,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<Series> {
  const start = await rangeStart(db, range, now);

  const [rows, earliest, account] = await Promise.all([
    db.accountSnapshot.findMany({
      where: { accountId, ...(start ? { snapshotDate: { gte: start } } : {}) },
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true, provenance: true, balanceCents: true },
    }),
    db.accountSnapshot.findFirst({
      where: { accountId },
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true },
    }),
    db.account.findUnique({ where: { id: accountId }, select: { id: true } }),
  ]);

  const daily: DailyRow[] = rows.map((row) => ({
    date: row.snapshotDate,
    provenance: row.provenance,
    fields: { balanceCents: row.balanceCents },
  }));

  const bucket = bucketFor(daily.length);
  let live: Record<string, Cents> | null = null;
  if (account) {
    const day = await observeDay(db, asSnapshotDate(now));
    const row = day.accounts.find((entry) => entry.accountId === accountId);
    if (row) live = { balanceCents: row.balanceCents };
  }

  return {
    points: downsample(daily, bucket),
    bucket,
    earliest: earliest?.snapshotDate ?? null,
    days: daily.length,
    live,
  };
}

// ---------------------------------------------------------------------------
// The delegation drill-down
// ---------------------------------------------------------------------------

export type DrillLevel = 'groupings' | 'delegations' | 'delegation';

export interface NamedSeries {
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly points: readonly SeriesPoint[];
  /** Average spend per pay cycle over the range — widget 5's whole question. */
  readonly burnRateCents: Cents;
  /** Change across the range, for the movers ranking. */
  readonly changeCents: Cents;
}

export interface DrillDown {
  readonly level: DrillLevel;
  readonly bucket: Bucket;
  readonly days: number;
  readonly series: readonly NamedSeries[];
  readonly cyclesPerYear: number;
  /** What the breadcrumb says, resolved here so the client holds no lookup. */
  readonly groupingName: string | null;
  readonly delegationName: string | null;
}

/**
 * Widgets 4 and 5, at whichever of the three levels was asked for.
 *
 * The grouping a delegation sat in is read from the **snapshot row**, not from
 * the delegation, so moving Grocery between groupings does not retroactively
 * move a year of its history with it.
 */
export async function delegationDrillDown(
  db: Db,
  options: {
    readonly range: SnapshotRange;
    readonly groupingId?: string | undefined;
    readonly delegationId?: string | undefined;
  },
  now: Date = new Date(),
): Promise<DrillDown> {
  const start = await rangeStart(db, options.range, now);
  const { payCadence } = await getBudgetSettings(db);
  const cyclesPerYear = CYCLES_PER_YEAR[payCadence];

  const level: DrillLevel = options.delegationId
    ? 'delegation'
    : options.groupingId
      ? 'delegations'
      : 'groupings';

  const rows = await db.delegationSnapshot.findMany({
    where: {
      ...(start ? { snapshotDate: { gte: start } } : {}),
      ...(options.delegationId ? { delegationId: options.delegationId } : {}),
      ...(options.groupingId && !options.delegationId ? { groupingId: options.groupingId } : {}),
    },
    orderBy: { snapshotDate: 'asc' },
    select: {
      snapshotDate: true,
      provenance: true,
      balanceCents: true,
      delegationId: true,
      groupingId: true,
      delegation: { select: { name: true } },
      grouping: { select: { name: true, color: true } },
    },
  });

  // One series per grouping at the top level, one per delegation below it.
  const groups = new Map<
    string,
    {
      name: string;
      color: string | null;
      byDate: Map<number, { total: Cents; provenances: SnapshotProvenance[] }>;
    }
  >();

  for (const row of rows) {
    const key = level === 'groupings' ? (row.groupingId ?? 'ungrouped') : row.delegationId;
    const name =
      level === 'groupings' ? (row.grouping?.name ?? 'No grouping') : row.delegation.name;
    const color = row.grouping?.color ?? null;

    let group = groups.get(key);
    if (!group) {
      group = { name, color, byDate: new Map() };
      groups.set(key, group);
    }

    const time = row.snapshotDate.getTime();
    const bucketed = group.byDate.get(time);
    if (bucketed) {
      bucketed.total += row.balanceCents;
      bucketed.provenances.push(row.provenance);
    } else {
      group.byDate.set(time, { total: row.balanceCents, provenances: [row.provenance] });
    }
  }

  const dayCount = new Set(rows.map((row) => row.snapshotDate.getTime())).size;
  const bucket = bucketFor(dayCount);

  const series: NamedSeries[] = [...groups.entries()].map(([key, group]) => {
    const daily: DailyRow[] = [...group.byDate.entries()]
      .sort(([a], [b]) => a - b)
      .map(([time, entry]) => ({
        date: new Date(time),
        provenance: weakestProvenance(entry.provenances),
        fields: { balanceCents: entry.total },
      }));

    const first = daily[0]?.fields['balanceCents'] ?? 0n;
    const last = daily[daily.length - 1]?.fields['balanceCents'] ?? 0n;

    return {
      key,
      name: group.name,
      color: group.color,
      points: downsample(daily, bucket),
      burnRateCents: burnRate(daily, cyclesPerYear),
      changeCents: last - first,
    };
  });

  // Largest mover first: the question these answer is "what moved", and the
  // answer belongs at the top.
  series.sort((a, b) => {
    const left = a.changeCents < 0n ? -a.changeCents : a.changeCents;
    const right = b.changeCents < 0n ? -b.changeCents : b.changeCents;
    return right > left ? 1 : right < left ? -1 : 0;
  });

  const [grouping, delegation] = await Promise.all([
    options.groupingId
      ? db.grouping.findUnique({ where: { id: options.groupingId }, select: { name: true } })
      : null,
    options.delegationId
      ? db.delegation.findUnique({ where: { id: options.delegationId }, select: { name: true } })
      : null,
  ]);

  return {
    level,
    bucket,
    days: dayCount,
    series,
    cyclesPerYear,
    groupingName: grouping?.name ?? null,
    delegationName: delegation?.name ?? null,
  };
}

/**
 * Average spend per pay cycle.
 *
 * Spending is the sum of the falls in the balance across the range, scaled to a
 * cycle. A rise is a Delegate press putting money in, not spending, so only the
 * downward steps count — which is the number that reveals whether the amount to
 * delegate on a line is actually right.
 *
 * Cycles per year comes from the pay cadence setting, never a hardcoded 26. The
 * Utilities page already divides by it, and two screens of one household
 * disagreeing about how often it is paid would be worse than either answer.
 */
function burnRate(daily: readonly DailyRow[], cyclesPerYear: number): Cents {
  if (daily.length < 2) return 0n;

  let spent = 0n;
  for (let index = 1; index < daily.length; index += 1) {
    const previous = daily[index - 1]?.fields['balanceCents'] ?? 0n;
    const current = daily[index]?.fields['balanceCents'] ?? 0n;
    if (current < previous) spent += previous - current;
  }

  // Scaled from the days actually covered to the length of one cycle.
  const days = BigInt(daily.length);
  const cycleDays = BigInt(Math.round((365 / cyclesPerYear) * 100));
  return (spent * cycleDays) / (days * 100n);
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Widget 11: the rolling 30-day change in net worth.
 *
 * Computed on the **daily** rows before any bucketing, because a rolling window
 * over weekly averages is a different and much blunter thing. It exists to smooth
 * the biweekly sawtooth so the underlying direction shows.
 */
export function momentum(daily: readonly DailyRow[], windowDays = 30): DailyRow[] {
  const byDate = new Map(daily.map((row) => [row.date.getTime(), row]));
  const out: DailyRow[] = [];

  for (const row of daily) {
    const then = byDate.get(row.date.getTime() - windowDays * DAY_MS);
    if (!then) continue;
    out.push({
      date: row.date,
      provenance: weakestProvenance([row.provenance, then.provenance]),
      fields: {
        changeCents: (row.fields['netWorthCents'] ?? 0n) - (then.fields['netWorthCents'] ?? 0n),
      },
    });
  }
  return out;
}

export interface CycleChange {
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly changeCents: Cents;
  readonly provenance: SnapshotProvenance;
  readonly partial: boolean;
}

/**
 * Widget 10: net worth change per pay cycle, aligned to actual paydays.
 *
 * A payday in this system is a Delegate press — `delegate_runs.created_at` — and
 * a cycle is one press to the next. Nothing schedules it, so the cadence setting
 * is a divisor and never a calendar.
 */
export async function changePerCycle(
  db: Db,
  daily: readonly DailyRow[],
  now: Date = new Date(),
): Promise<CycleChange[]> {
  const runs = await db.delegateRun.findMany({
    where: { undoneAt: null },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (runs.length === 0 || daily.length === 0) return [];

  const at = (date: Date): DailyRow | undefined => {
    // The last stored day at or before the boundary: a cycle that starts on a
    // day with no snapshot still has a value to measure from.
    let found: DailyRow | undefined;
    for (const row of daily) {
      if (row.date.getTime() <= date.getTime()) found = row;
      else break;
    }
    return found;
  };

  const changes: CycleChange[] = [];
  for (const [index, run] of runs.entries()) {
    const startedAt = asSnapshotDate(run.createdAt);
    const next = runs[index + 1];
    const endedAt = next ? asSnapshotDate(next.createdAt) : null;

    const from = at(startedAt);
    const to = at(endedAt ?? asSnapshotDate(now));
    if (!from || !to || from.date.getTime() === to.date.getTime()) continue;

    changes.push({
      startedAt,
      endedAt,
      changeCents: (to.fields['netWorthCents'] ?? 0n) - (from.fields['netWorthCents'] ?? 0n),
      provenance: weakestProvenance([from.provenance, to.provenance]),
      partial: endedAt === null,
    });
  }

  return changes;
}

export interface DebtTrajectory {
  readonly points: readonly SeriesPoint[];
  /**
   * Where a straight line through the trailing 90 days reaches zero. Null when
   * debts are flat or rising, or when there is not enough history to say —
   * an estimate nobody can sanity-check is worse than no estimate.
   */
  readonly payoffDate: Date | null;
  readonly hasEnoughHistory: boolean;
}

/** How many days of history before a projection is worth drawing at all. */
const TRAJECTORY_MIN_DAYS = 60;
const TRAJECTORY_WINDOW_DAYS = 90;

/**
 * Widget 13: total debts over time, with a payoff projection.
 *
 * Deliberately hidden until there is enough history to mean anything. A line
 * fitted through nine days would put a payoff date on screen that moves by years
 * every morning, and a number that unstable reads as a fact to whoever sees it.
 */
export function debtTrajectory(daily: readonly DailyRow[], bucket: Bucket): DebtTrajectory {
  const points = downsample(
    daily.map((row) => ({
      date: row.date,
      provenance: row.provenance,
      fields: { debtsCents: row.fields['netWorthDebtsCents'] ?? 0n },
    })),
    bucket,
  );

  if (daily.length < TRAJECTORY_MIN_DAYS) {
    return { points, payoffDate: null, hasEnoughHistory: false };
  }

  const window = daily.slice(-TRAJECTORY_WINDOW_DAYS);
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return { points, payoffDate: null, hasEnoughHistory: false };

  const from = first.fields['netWorthDebtsCents'] ?? 0n;
  const to = last.fields['netWorthDebtsCents'] ?? 0n;
  const spanDays = Math.round((last.date.getTime() - first.date.getTime()) / DAY_MS);

  // Flat or rising: there is no payoff to project, and drawing one anyway would
  // be an invented reassurance.
  if (spanDays <= 0 || to >= from || to <= 0n) {
    return { points, payoffDate: null, hasEnoughHistory: true };
  }

  const perDay = (from - to) / BigInt(spanDays);
  if (perDay <= 0n) return { points, payoffDate: null, hasEnoughHistory: true };

  const daysRemaining = Number(to / perDay);
  return {
    points,
    payoffDate: new Date(last.date.getTime() + daysRemaining * DAY_MS),
    hasEnoughHistory: true,
  };
}

export interface CompositionPoint {
  readonly date: Date;
  readonly provenance: SnapshotProvenance;
  readonly bitcoinCents: Cents;
  readonly otherAssetsCents: Cents;
  readonly debtsCents: Cents;
}

/**
 * Widget 9: what net worth is made of, over time.
 *
 * The split is what the stored rows can actually answer: a Bitcoin holding is
 * identifiable by its quantity, and everything else is assets against debts.
 *
 * There is deliberately no cash-versus-savings split. The application has no
 * such classification — an account is an asset or a debt — and inventing one
 * from names would be a guess presented as a category.
 */
export async function compositionSeries(
  db: Db,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<{ points: CompositionPoint[]; bucket: Bucket; days: number }> {
  const start = await rangeStart(db, range, now);

  const rows = await db.accountSnapshot.findMany({
    where: {
      inNetWorth: true,
      ...(start ? { snapshotDate: { gte: start } } : {}),
    },
    orderBy: { snapshotDate: 'asc' },
    select: {
      snapshotDate: true,
      provenance: true,
      balanceCents: true,
      accountType: true,
      quantitySats: true,
    },
  });

  const byDate = new Map<
    number,
    { bitcoin: Cents; other: Cents; debts: Cents; provenances: SnapshotProvenance[] }
  >();

  for (const row of rows) {
    const time = row.snapshotDate.getTime();
    const entry = byDate.get(time) ?? {
      bitcoin: 0n,
      other: 0n,
      debts: 0n,
      provenances: [] as SnapshotProvenance[],
    };

    if (row.accountType === 'debt') entry.debts += row.balanceCents;
    else if (row.quantitySats !== null) entry.bitcoin += row.balanceCents;
    else entry.other += row.balanceCents;

    entry.provenances.push(row.provenance);
    byDate.set(time, entry);
  }

  const daily: DailyRow[] = [...byDate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, entry]) => ({
      date: new Date(time),
      provenance: weakestProvenance(entry.provenances),
      fields: {
        bitcoinCents: entry.bitcoin,
        otherAssetsCents: entry.other,
        debtsCents: entry.debts,
      },
    }));

  const bucket = bucketFor(daily.length);
  return {
    points: downsample(daily, bucket).map((point) => ({
      date: point.date,
      provenance: point.provenance,
      bitcoinCents: point.fields['bitcoinCents'] ?? 0n,
      otherAssetsCents: point.fields['otherAssetsCents'] ?? 0n,
      debtsCents: point.fields['debtsCents'] ?? 0n,
    })),
    bucket,
    days: daily.length,
  };
}

/** The daily aggregate rows a derived view needs, un-bucketed. */
export async function dailyAggregateRows(
  db: Db,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<DailyRow[]> {
  const start = await rangeStart(db, range, now);
  const rows = await db.aggregateSnapshot.findMany({
    where: start ? { snapshotDate: { gte: start } } : {},
    orderBy: { snapshotDate: 'asc' },
  });
  return rows.map((row) => ({
    date: row.snapshotDate,
    provenance: row.provenance,
    fields: Object.fromEntries(AGGREGATE_FIELDS.map((name) => [name, row[name]])),
  }));
}

/**
 * Home equity over time: the property less what is still owed on it.
 *
 * Aligned by date rather than by index. The two series are stored per account
 * and either can be missing a day, so zipping them positionally would subtract a
 * mortgage balance from the wrong date and draw an equity line that is
 * confidently wrong.
 */
export async function equitySeries(
  db: Db,
  range: SnapshotRange,
  now: Date = new Date(),
): Promise<{ points: SeriesPoint[]; bucket: Bucket; days: number; name: string | null }> {
  const property = await db.account.findFirst({
    where: { archivedAt: null, mortgageAccountId: { not: null } },
    select: { id: true, name: true, nickname: true, mortgageAccountId: true },
  });
  if (!property?.mortgageAccountId) {
    return { points: [], bucket: 'day', days: 0, name: null };
  }

  const start = await rangeStart(db, range, now);
  const where = start ? { snapshotDate: { gte: start } } : {};

  const [values, owed] = await Promise.all([
    db.accountSnapshot.findMany({
      where: { accountId: property.id, ...where },
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true, balanceCents: true, provenance: true },
    }),
    db.accountSnapshot.findMany({
      where: { accountId: property.mortgageAccountId, ...where },
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true, balanceCents: true, provenance: true },
    }),
  ]);

  const owedByDate = new Map(owed.map((row) => [row.snapshotDate.getTime(), row] as const));

  const daily: DailyRow[] = values
    .filter((row) => owedByDate.has(row.snapshotDate.getTime()))
    .map((row) => {
      const mortgage = owedByDate.get(row.snapshotDate.getTime())!;
      return {
        date: row.snapshotDate,
        provenance: weakestProvenance([row.provenance, mortgage.provenance]),
        fields: { equityCents: row.balanceCents - mortgage.balanceCents },
      };
    });

  const bucket = bucketFor(daily.length);
  return {
    points: downsample(daily, bucket),
    bucket,
    days: daily.length,
    name: property.nickname ?? property.name,
  };
}
