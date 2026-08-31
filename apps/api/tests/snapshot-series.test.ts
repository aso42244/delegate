import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import {
  aggregateSeries,
  bucketFor,
  delegationDrillDown,
  downsample,
  type DailyRow,
} from '../src/domain/snapshot-series.js';
import { makeAccount, makeDelegation, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Reading the snapshot tables back, shaped for a chart.
 *
 * The properties worth protecting: a bucket is an average and takes the weakest
 * provenance in it, money never becomes a float on the way through, the live
 * point is separate from stored history, and the drill-down reads the grouping
 * the snapshot recorded rather than the one the delegation is in today.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const day = (n: number): Date => new Date(Date.UTC(2026, 7, n));

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      AUTH_RATE_LIMIT_MAX: '100000',
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(response.headers);
  await markTwoFactorEnrolled();
});

/** An aggregate row for a date, with only the fields a test cares about. */
async function storeAggregate(
  date: Date,
  netWorthCents: bigint,
  provenance: 'observed' | 'reconstructed' | 'carried' | 'interpolated' = 'observed',
): Promise<void> {
  await prisma.aggregateSnapshot.create({
    data: {
      snapshotDate: date,
      netWorthAssetsCents: netWorthCents,
      netWorthDebtsCents: 0n,
      netWorthCents,
      budgetAssetsCents: netWorthCents,
      budgetDebtsCents: 0n,
      totalDelegationsCents: 0n,
      pendingCategorizedCents: 0n,
      identityValueCents: netWorthCents,
      provenance,
    },
  });
}

const row = (
  n: number,
  value: bigint,
  provenance: DailyRow['provenance'] = 'observed',
): DailyRow => ({
  date: day(n),
  provenance,
  fields: { valueCents: value },
});

// ---------------------------------------------------------------------------

describe('choosing a bucket', () => {
  /**
   * The reader never chooses this. It follows from the range, so a chart stays
   * readable and fast without anybody having to think about it.
   */
  it('stays daily up to about six months, then coarsens', () => {
    expect(bucketFor(1)).toBe('day');
    expect(bucketFor(180)).toBe('day');
    expect(bucketFor(181)).toBe('week');
    expect(bucketFor(730)).toBe('week');
    expect(bucketFor(731)).toBe('month');
  });
});

describe('downsampling', () => {
  it('leaves a daily series alone', () => {
    const points = downsample([row(1, 100n), row(2, 200n)], 'day');
    expect(points.map((point) => point.fields['valueCents'])).toEqual([100n, 200n]);
    expect(points.every((point) => point.days === 1)).toBe(true);
  });

  /**
   * The average rather than the last value: a weekly point reporting Sunday's
   * balance would swing with whichever day landed at the end, and a net worth
   * line is not a sampling of Sundays.
   */
  it('averages a week rather than taking its last day', () => {
    // The 3rd of August 2026 is a Monday, so these five fall in one week.
    const points = downsample(
      [row(3, 100n), row(4, 200n), row(5, 300n), row(6, 400n), row(7, 500n)],
      'week',
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.fields['valueCents']).toBe(300n);
    expect(points[0]?.days).toBe(5);
  });

  it('splits weeks on Monday', () => {
    // The 9th is a Sunday and belongs to the week beginning the 3rd; the 10th
    // starts a new one.
    const points = downsample([row(9, 100n), row(10, 200n)], 'week');
    expect(points).toHaveLength(2);
    expect(points.map((point) => point.date.toISOString().slice(0, 10))).toEqual([
      '2026-08-03',
      '2026-08-10',
    ]);
  });

  it('buckets by calendar month', () => {
    const points = downsample(
      [
        {
          date: new Date(Date.UTC(2026, 6, 20)),
          provenance: 'observed',
          fields: { valueCents: 100n },
        },
        {
          date: new Date(Date.UTC(2026, 7, 2)),
          provenance: 'observed',
          fields: { valueCents: 300n },
        },
      ],
      'month',
    );
    expect(points.map((point) => point.date.toISOString().slice(0, 10))).toEqual([
      '2026-07-01',
      '2026-08-01',
    ]);
  });

  /**
   * A line drawn through a bucket is no better than its worst point, so one
   * estimated day makes the whole week estimated.
   */
  it('takes the weakest provenance in the bucket', () => {
    const points = downsample([row(3, 100n), row(4, 200n, 'interpolated'), row(5, 300n)], 'week');
    expect(points[0]?.provenance).toBe('interpolated');
  });

  it('keeps a bucket observed when every day in it was', () => {
    const points = downsample([row(3, 100n), row(4, 200n)], 'week');
    expect(points[0]?.provenance).toBe('observed');
  });

  /** Money never becomes a float, not even halfway through an average. */
  it('rounds an average half away from zero, in integers', () => {
    expect(downsample([row(3, 100n), row(4, 101n)], 'week')[0]?.fields['valueCents']).toBe(101n);
    expect(downsample([row(3, -100n), row(4, -101n)], 'week')[0]?.fields['valueCents']).toBe(-101n);
  });

  it('handles an empty series without inventing a point', () => {
    expect(downsample([], 'week')).toEqual([]);
  });
});

describe('the aggregate series', () => {
  it('reports how much history there is and where it begins', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n, createdAt: day(1) });
    for (const n of [20, 21, 22]) await storeAggregate(day(n), BigInt(n) * 1000n);

    const result = await aggregateSeries(prisma, 'all');
    expect(result.days).toBe(3);
    expect(result.bucket).toBe('day');
    expect(result.earliest?.toISOString().slice(0, 10)).toBe('2026-08-20');
  });

  /**
   * Snapshots are labelled for the previous day, so without a live point every
   * chart ends a day behind and reads as stale rather than current. It is kept
   * separate from the stored points because it is current state, not an
   * observation somebody recorded.
   */
  it('carries a live point computed from current state', async () => {
    await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 777_000n,
      createdAt: day(1),
    });
    await storeAggregate(day(20), 1_000n);

    const result = await aggregateSeries(prisma, 'all');
    expect(result.points).toHaveLength(1);
    expect(result.live?.['netWorthCents']).toBe(777_000n);
  });

  it('narrows to the range asked for', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: day(1) });
    const today = new Date();
    for (let back = 0; back < 100; back += 1) {
      const date = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back),
      );
      await storeAggregate(date, 1_000n);
    }

    expect((await aggregateSeries(prisma, '30d')).days).toBe(31);
    expect((await aggregateSeries(prisma, 'all')).days).toBe(100);
  });

  it('says there is nothing rather than failing, before the first run', async () => {
    const result = await aggregateSeries(prisma, 'all');
    expect(result.points).toEqual([]);
    expect(result.days).toBe(0);
    expect(result.earliest).toBeNull();
  });
});

describe('the delegation drill-down', () => {
  async function twoGroupings(): Promise<{ food: string; home: string }> {
    const food = await prisma.grouping.create({
      data: { name: '3 - Food', section: 'delegations', color: '#46A171' },
      select: { id: true },
    });
    const home = await prisma.grouping.create({
      data: { name: '5 - Home', section: 'delegations' },
      select: { id: true },
    });
    return { food: food.id, home: home.id };
  }

  it('aggregates one series per grouping by default', async () => {
    const { food, home } = await twoGroupings();
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: food, createdAt: day(1) });
    const dining = await makeDelegation({ name: 'Dining', groupingId: food, createdAt: day(1) });
    const repairs = await makeDelegation({ name: 'Repairs', groupingId: home, createdAt: day(1) });

    for (const [id, groupingId, amount] of [
      [grocery.id, food, 10_000n],
      [dining.id, food, 5_000n],
      [repairs.id, home, 20_000n],
    ] as const) {
      await prisma.delegationSnapshot.create({
        data: {
          snapshotDate: day(20),
          delegationId: id,
          balanceCents: amount,
          provenance: 'observed',
          groupingId,
        },
      });
    }

    const drill = await delegationDrillDown(prisma, { range: 'all' });
    expect(drill.level).toBe('groupings');
    expect(drill.series).toHaveLength(2);

    const foodSeries = drill.series.find((entry) => entry.name === '3 - Food');
    // The two Food lines summed into one series.
    expect(foodSeries?.points[0]?.fields['balanceCents']).toBe(15_000n);
    expect(foodSeries?.color).toBe('#46A171');
  });

  it('drops to one series per delegation inside a grouping', async () => {
    const { food } = await twoGroupings();
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: food, createdAt: day(1) });
    const dining = await makeDelegation({ name: 'Dining', groupingId: food, createdAt: day(1) });

    for (const id of [grocery.id, dining.id]) {
      await prisma.delegationSnapshot.create({
        data: {
          snapshotDate: day(20),
          delegationId: id,
          balanceCents: 10_000n,
          provenance: 'observed',
          groupingId: food,
        },
      });
    }

    const drill = await delegationDrillDown(prisma, { range: 'all', groupingId: food });
    expect(drill.level).toBe('delegations');
    expect(drill.series.map((entry) => entry.name).sort()).toEqual(['Dining', 'Grocery']);
    expect(drill.groupingName).toBe('3 - Food');
  });

  it('narrows to one delegation', async () => {
    const { food } = await twoGroupings();
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: food, createdAt: day(1) });
    await prisma.delegationSnapshot.create({
      data: {
        snapshotDate: day(20),
        delegationId: grocery.id,
        balanceCents: 10_000n,
        provenance: 'observed',
        groupingId: food,
      },
    });

    const drill = await delegationDrillDown(prisma, { range: 'all', delegationId: grocery.id });
    expect(drill.level).toBe('delegation');
    expect(drill.series).toHaveLength(1);
    expect(drill.delegationName).toBe('Grocery');
  });

  /**
   * The whole reason the grouping is captured on the snapshot row. Moving a line
   * between groupings must not retroactively move a year of its history.
   */
  it('reads the grouping the snapshot recorded, not the one it is in now', async () => {
    const { food, home } = await twoGroupings();
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: food, createdAt: day(1) });
    await prisma.delegationSnapshot.create({
      data: {
        snapshotDate: day(20),
        delegationId: grocery.id,
        balanceCents: 10_000n,
        provenance: 'observed',
        groupingId: food,
      },
    });

    // Moved today. The stored history stays where it was.
    await prisma.delegation.update({ where: { id: grocery.id }, data: { groupingId: home } });

    const drill = await delegationDrillDown(prisma, { range: 'all' });
    expect(drill.series).toHaveLength(1);
    expect(drill.series[0]?.name).toBe('3 - Food');
  });

  /**
   * Burn rate divides by the configured cadence, never a hardcoded 26 — two
   * screens of one household disagreeing about how often it is paid would be
   * worse than either answer.
   */
  it('takes cycles per year from the pay cadence setting', async () => {
    await prisma.budgetSettings.upsert({
      where: { id: 1 },
      create: { id: 1, payCadence: 'monthly' },
      update: { payCadence: 'monthly' },
    });

    const drill = await delegationDrillDown(prisma, { range: 'all' });
    expect(drill.cyclesPerYear).toBe(12);
  });

  it('ranks the biggest movers first', async () => {
    const { food, home } = await twoGroupings();
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: food, createdAt: day(1) });
    const repairs = await makeDelegation({ name: 'Repairs', groupingId: home, createdAt: day(1) });

    for (const [id, groupingId, from, to] of [
      [grocery.id, food, 10_000n, 9_000n],
      [repairs.id, home, 10_000n, 60_000n],
    ] as const) {
      await prisma.delegationSnapshot.createMany({
        data: [
          {
            snapshotDate: day(20),
            delegationId: id,
            balanceCents: from,
            provenance: 'observed',
            groupingId,
          },
          {
            snapshotDate: day(21),
            delegationId: id,
            balanceCents: to,
            provenance: 'observed',
            groupingId,
          },
        ],
      });
    }

    const drill = await delegationDrillDown(prisma, { range: 'all' });
    expect(drill.series[0]?.name).toBe('5 - Home');
    expect(drill.series[0]?.changeCents).toBe(50_000n);
    expect(drill.series[1]?.changeCents).toBe(-1_000n);
  });
});

describe('the routes', () => {
  it('serves the page in one request, to any signed-in person', async () => {
    const account = await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 100n,
      createdAt: day(1),
    });
    await storeAggregate(day(20), 500_000n);
    // The picker offers only accounts that actually have history, so one needs a
    // stored row to appear at all.
    await prisma.accountSnapshot.create({
      data: {
        snapshotDate: day(20),
        accountId: account.id,
        balanceCents: 100n,
        provenance: 'observed',
        accountType: 'asset',
        inBudget: true,
        inNetWorth: true,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/insights/snapshots?range=all',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      range: string;
      aggregate: { points: { netWorthCents: string; provenance: string }[]; live: unknown };
      net_worth_composition: { points: unknown[] };
      debt_trajectory: { hasEnoughHistory: boolean };
      accounts: { id: string }[];
    }>();

    expect(body.range).toBe('all');
    // Cents cross the wire as decimal strings, never as JSON numbers.
    expect(body.aggregate.points[0]?.netWorthCents).toBe('500000');
    expect(body.aggregate.points[0]?.provenance).toBe('observed');
    expect(body.aggregate.live).not.toBeNull();
    expect(body.accounts).toHaveLength(1);
  });

  /**
   * A projection fitted through a handful of days would move by years every
   * morning, and a number that unstable reads as a fact to whoever sees it.
   */
  it('withholds the payoff projection until there is enough history', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n, createdAt: day(1) });
    await storeAggregate(day(20), 500_000n);

    const response = await app.inject({
      method: 'GET',
      url: '/api/insights/snapshots?range=all',
      headers: { cookie },
    });

    const body = response.json<{
      debt_trajectory: { hasEnoughHistory: boolean; payoffDate: string | null };
    }>();
    expect(body.debt_trajectory.hasEnoughHistory).toBe(false);
    expect(body.debt_trajectory.payoffDate).toBeNull();
  });

  it('serves one account on request', async () => {
    const account = await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 500_000n,
      createdAt: day(1),
    });
    await prisma.accountSnapshot.create({
      data: {
        snapshotDate: day(20),
        accountId: account.id,
        balanceCents: 400_000n,
        provenance: 'observed',
        accountType: 'asset',
        inBudget: true,
        inNetWorth: true,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/insights/snapshots/account/${account.id}?range=all`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      points: { balanceCents: string }[];
      live: { balanceCents: string } | null;
    }>();
    expect(body.points[0]?.balanceCents).toBe('400000');
    // The live point is today's balance, distinct from the stored history.
    expect(body.live?.balanceCents).toBe('500000');
  });

  it('refuses a range it does not know rather than guessing one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/insights/snapshots?range=forever',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/insights/snapshots' });
    expect(response.statusCode).toBe(401);
  });

  it('serves the drill-down at each level', async () => {
    const grouping = await prisma.grouping.create({
      data: { name: 'Food', section: 'delegations' },
      select: { id: true },
    });
    const grocery = await makeDelegation({
      name: 'Grocery',
      groupingId: grouping.id,
      createdAt: day(1),
    });
    await prisma.delegationSnapshot.create({
      data: {
        snapshotDate: day(20),
        delegationId: grocery.id,
        balanceCents: 10_000n,
        provenance: 'observed',
        groupingId: grouping.id,
      },
    });

    for (const [query, level] of [
      ['', 'groupings'],
      [`&groupingId=${grouping.id}`, 'delegations'],
      [`&delegationId=${grocery.id}`, 'delegation'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/insights/snapshots/delegations?range=all${query}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ level: string }>().level).toBe(level);
    }
  });
});

/**
 * The chart-shape cases from the specification: one day, one week, and more than
 * a year. Each has to come back drawable rather than broken.
 */
describe('however much history there is', () => {
  async function history(days: number): Promise<void> {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: day(1) });
    const today = new Date();
    for (let back = days - 1; back >= 0; back -= 1) {
      const date = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back),
      );
      await storeAggregate(date, BigInt(days - back) * 1_000n);
    }
  }

  it('renders one day as a single point rather than an error', async () => {
    await history(1);
    const result = await aggregateSeries(prisma, 'all');
    expect(result.days).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.bucket).toBe('day');
  });

  it('renders a week daily', async () => {
    await history(7);
    const result = await aggregateSeries(prisma, 'all');
    expect(result.days).toBe(7);
    expect(result.points).toHaveLength(7);
    expect(result.bucket).toBe('day');
  });

  /** 400 days is past the daily threshold, so it comes back weekly and short. */
  it('renders 400 days as weekly buckets', async () => {
    await history(400);
    const result = await aggregateSeries(prisma, 'all');

    expect(result.days).toBe(400);
    expect(result.bucket).toBe('week');
    expect(result.points.length).toBeLessThan(60);
    expect(result.points.length).toBeGreaterThan(50);
    // Every bucket still says how many days it averaged.
    expect(result.points.every((point) => point.days >= 1 && point.days <= 7)).toBe(true);
  });
});
