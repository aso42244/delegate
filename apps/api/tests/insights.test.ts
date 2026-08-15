import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import {
  buildBacklog,
  buildComposition,
  buildCycles,
  buildNegativeDelegations,
  buildSpending,
} from '../src/domain/insights.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Insights.
 *
 * The property that matters throughout: spending is read from allocations, so
 * `adjust` events are excluded everywhere. A go-live reconciliation writes sixty
 * adjustments at once, and if those counted as spending they would dominate every
 * figure on this page and make the whole thing lie.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const NOW = new Date('2026-08-09T12:00:00Z');

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      // These suites sign in on every test from one address. The limit itself
      // is proved in auth.test.ts, which builds an app with a low one.
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
});

describe('composition', () => {
  it('splits assets and debts, with shares as basis points', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 300_000n });
    await makeAccount({ name: 'Savings', type: 'asset', balanceCents: 100_000n });
    await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });

    const composition = await buildComposition(prisma);

    expect(composition.totalAssetsCents).toBe(400_000n);
    expect(composition.totalDebtsCents).toBe(50_000n);
    expect(composition.netCents).toBe(350_000n);
    // 300,000 of 400,000 is 75%, carried as an integer rather than a float.
    expect(composition.assets[0]?.shareBasisPoints).toBe(7_500);
  });

  it('counts what is in net worth, not what is in the budget', async () => {
    // The house is deliberately off-budget but very much part of net worth.
    await makeAccount({
      name: 'The house',
      type: 'asset',
      balanceCents: 45_000_000n,
      inBudget: false,
      inNetWorth: true,
    });

    const composition = await buildComposition(prisma);
    expect(composition.totalAssetsCents).toBe(45_000_000n);
  });
});

describe('spending', () => {
  async function spendOn(delegationId: string, cents: bigint, postedAt: Date): Promise<void> {
    const account = await prisma.account.findFirstOrThrow();
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -cents,
      postedAt,
    });
    await categorizeTransaction(prisma, transaction.id, delegationId);
  }

  it('ranks by grouping, largest first', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const essentials = await prisma.grouping.create({
      data: { name: 'Essentials', section: 'delegations' },
      select: { id: true },
    });
    const grocery = await makeDelegation({ name: 'Grocery', groupingId: essentials.id });
    const fun = await makeDelegation({ name: 'Fun' });

    await spendOn(grocery.id, 30_000n, new Date('2026-08-01T00:00:00Z'));
    await spendOn(fun.id, 10_000n, new Date('2026-08-02T00:00:00Z'));

    const { entries } = await buildSpending(prisma, { by: 'grouping', window: '30d' }, NOW);
    expect(entries[0]?.name).toBe('Essentials');
    expect(entries[0]?.spendCents).toBe(30_000n);
    expect(entries[1]?.name).toBe('No grouping');
  });

  /** The reason this page reads allocations rather than delegation events. */
  it('excludes adjustments entirely', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    await spendOn(grocery.id, 5_000n, new Date('2026-08-01T00:00:00Z'));
    // A reconciliation-sized correction, far larger than the spending.
    await adjustDelegationByDelta(prisma, { delegationId: grocery.id, deltaCents: -900_000n });

    const { entries } = await buildSpending(prisma, { by: 'delegation', window: '30d' }, NOW);
    expect(entries[0]?.spendCents).toBe(5_000n);
  });

  it('lets a refund reduce the window', async () => {
    const account = await makeAccount({
      name: 'Everyday',
      type: 'asset',
      balanceCents: 5_000_000n,
    });
    const grocery = await makeDelegation({ name: 'Grocery' });

    await spendOn(grocery.id, 10_000n, new Date('2026-08-01T00:00:00Z'));
    const refund = await makeTransaction({
      accountId: account.id,
      amountCents: 2_000n,
      postedAt: new Date('2026-08-03T00:00:00Z'),
    });
    await categorizeTransaction(prisma, refund.id, grocery.id);

    const { entries } = await buildSpending(prisma, { by: 'delegation', window: '30d' }, NOW);
    expect(entries[0]?.spendCents).toBe(8_000n);
  });

  it('reports nothing rather than inventing a cycle before the first Delegate', async () => {
    const result = await buildSpending(prisma, { by: 'grouping', window: 'cycle' }, NOW);
    expect(result.since).toBeNull();
    expect(result.entries).toEqual([]);
  });
});

describe('the other widgets', () => {
  it('lists only the over-spent delegations, worst first', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const fun = await makeDelegation({ name: 'Fun' });
    await makeDelegation({ name: 'Fine' });

    await adjustDelegationByDelta(prisma, { delegationId: grocery.id, deltaCents: -5_000n });
    await adjustDelegationByDelta(prisma, { delegationId: fun.id, deltaCents: -20_000n });

    const negative = await buildNegativeDelegations(prisma);
    expect(negative.map((row) => row.name)).toEqual(['Fun', 'Grocery']);
  });

  it('counts the backlog and its oldest member', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500_000n });
    await makeTransaction({
      accountId: account.id,
      amountCents: -1_000n,
      postedAt: new Date('2026-07-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: account.id,
      amountCents: -2_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });

    const backlog = await buildBacklog(prisma);
    expect(backlog.count).toBe(2);
    expect(backlog.oldestPostedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('marks the cycle still running as in progress', async () => {
    const user = await prisma.user.findFirstOrThrow();
    await prisma.delegateRun.create({
      data: {
        createdAt: new Date('2026-08-01T00:00:00Z'),
        actorId: user.id,
        batchId: '11111111-1111-4111-8111-111111111111',
        totalCents: 0n,
        lineCount: 0,
      },
    });

    const cycles = await buildCycles(prisma, NOW);
    expect(cycles).toHaveLength(1);
    // A half-finished cycle must not be compared with whole ones as an equal.
    expect(cycles[0]?.partial).toBe(true);
  });
});

describe('the layout', () => {
  it('starts empty and is saved per user', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/insights/layout',
      headers: { cookie },
    });
    expect(before.json<{ chosen: unknown[] }>().chosen).toEqual([]);

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/insights/layout',
      headers: { cookie },
      payload: { widgets: ['uncategorized_backlog', 'asset_debt_composition'] },
    });
    expect(saved.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/insights/layout',
      headers: { cookie },
    });
    // Order is part of the layout, so it comes back in the order it was set.
    // Order is part of the layout, and so is the chart each tile is drawn as;
    // a bare key means "its usual chart".
    expect(after.json<{ chosen: { key: string; display: string | null }[] }>().chosen).toEqual([
      { key: 'uncategorized_backlog', display: null },
      { key: 'asset_debt_composition', display: null },
    ]);
  });

  it('remembers the chart a tile is drawn as', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/insights/layout',
      headers: { cookie },
      payload: { widgets: [{ key: 'spending_by_grouping', display: 'donut' }] },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/insights/layout',
      headers: { cookie },
    });
    expect(after.json<{ chosen: { key: string; display: string | null }[] }>().chosen).toEqual([
      { key: 'spending_by_grouping', display: 'donut' },
    ]);
  });

  /**
   * A donut of a single number says nothing. Refused rather than stored and
   * quietly ignored at render time, which would look like the setting not
   * working.
   */
  it('refuses a chart the widget cannot be drawn as', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/insights/layout',
      headers: { cookie },
      payload: { widgets: [{ key: 'uncategorized_backlog', display: 'donut' }] },
    });

    expect(response.json<{ ok: boolean; mismatched: string[] }>()).toMatchObject({
      ok: false,
      mismatched: ['uncategorized_backlog:donut'],
    });
  });

  it('refuses a widget that is not in the catalog', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/insights/layout',
      headers: { cookie },
      payload: { widgets: ['not_a_widget'] },
    });

    expect(response.json<{ ok: boolean }>().ok).toBe(false);
    const layout = await app.inject({
      method: 'GET',
      url: '/api/insights/layout',
      headers: { cookie },
    });
    // Nothing was written.
    expect(layout.json<{ chosen: string[] }>().chosen).toEqual([]);
  });

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/insights' });
    expect(response.statusCode).toBe(401);
  });
});

/**
 * Bitcoin over time.
 *
 * The series was computable all along — `accountSeries` has valued a holding at
 * each day's price since Phase 2 — but the route never returned it, so the tile
 * had nothing to draw and showed a paragraph instead.
 */
describe('the bitcoin series', () => {
  it('values the holding at each day s price', async () => {
    const wallet = await makeAccount({
      name: 'Hardware wallet',
      type: 'asset',
      balanceCents: 0n,
    });
    await prisma.account.update({
      where: { id: wallet.id },
      // Half a bitcoin, in satoshis.
      data: { bitcoinSats: 50_000_000n },
    });

    for (const [daysAgo, dollars] of [
      [3, 60_000],
      [2, 65_000],
      [1, 70_000],
    ] as const) {
      const date = new Date(NOW);
      date.setUTCDate(date.getUTCDate() - daysAgo);
      await prisma.bitcoinPrice.create({
        data: {
          priceDate: new Date(date.toISOString().slice(0, 10)),
          priceCents: BigInt(dollars) * 100n,
          source: 'test',
        },
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/insights/series?days=7',
      headers: { cookie },
    });

    const body = response.json<{
      bitcoin_value_over_time: { name: string; points: { valueCents: string }[] } | null;
    }>();

    expect(body.bitcoin_value_over_time?.name).toBe('Hardware wallet');

    const values = (body.bitcoin_value_over_time?.points ?? []).map((point) =>
      BigInt(point.valueCents),
    );
    // Half a coin at $70,000 is $35,000 — the price moves, the quantity does not.
    expect(values.some((value) => value === 3_500_000n)).toBe(true);
  });

  it('returns nothing when no account holds any', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });

    const response = await app.inject({
      method: 'GET',
      url: '/api/insights/series?days=7',
      headers: { cookie },
    });

    expect(
      response.json<{ bitcoin_value_over_time: unknown }>().bitcoin_value_over_time,
    ).toBeNull();
  });
});

/**
 * A Bitcoin holding in net worth.
 *
 * Its `balance_cents` is zero — there is no dollar balance to carry — so summing
 * that column left a real holding out of net worth entirely, while the
 * net-worth-over-time chart, which has valued it at each day's price since Phase
 * 2, included it. The two disagreed and the chart was right.
 */
describe('net worth with a Bitcoin holding', () => {
  async function holding(sats: bigint): Promise<void> {
    const wallet = await makeAccount({
      name: 'Hardware wallet',
      type: 'asset',
      balanceCents: 0n,
      inBudget: false,
      inNetWorth: true,
    });
    await prisma.account.update({ where: { id: wallet.id }, data: { bitcoinSats: sats } });
  }

  it('counts the holding at today s price', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await holding(165_400_000n);
    // $60,000.00 per Bitcoin, in cents. Round numbers on purpose: the rounding
    // rule has its own tests, and this one is about whether it is counted.
    await prisma.bitcoinPrice.create({
      data: { priceDate: new Date('2026-08-15'), priceCents: 6_000_000n, source: 'test' },
    });

    const composition = await buildComposition(prisma);

    // 1.654 BTC at $60,000 is $99,240, plus $1,000 of checking.
    expect(composition.totalAssetsCents).toBe(9_924_000n + 100_000n);
    expect(composition.netCents).toBe(9_924_000n + 100_000n);
  });

  /** A quantity is not a value until something says what it is worth. */
  it('contributes nothing while there is no price', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await holding(165_400_000n);

    const composition = await buildComposition(prisma);
    expect(composition.totalAssetsCents).toBe(100_000n);
  });

  it('agrees with the net worth series, which always valued it', async () => {
    await holding(100_000_000n);
    // One whole Bitcoin at $50,000.00.
    await prisma.bitcoinPrice.create({
      data: { priceDate: new Date('2026-08-15'), priceCents: 5_000_000n, source: 'test' },
    });

    const composition = await buildComposition(prisma);
    expect(composition.totalAssetsCents).toBe(5_000_000n);
  });
});

/**
 * A property shown at equity.
 *
 * Listing the house gross and its mortgage separately nets to the same number,
 * but reads as a household that owns a house outright with an unrelated loan
 * beside it. One line at equity says the true thing.
 */
describe('a mortgaged property in the composition', () => {
  async function house(valueCents: bigint, owedCents: bigint): Promise<void> {
    const mortgage = await makeAccount({
      name: 'Frontier Bank Mortgage',
      type: 'debt',
      balanceCents: owedCents,
      inBudget: false,
      inNetWorth: true,
    });
    const property = await makeAccount({
      name: '1505 E Otonka Trail',
      type: 'asset',
      balanceCents: valueCents,
      inBudget: false,
      inNetWorth: true,
    });
    await prisma.account.update({
      where: { id: property.id },
      data: { mortgageAccountId: mortgage.id },
    });
  }

  it('shows one line at equity, and drops the mortgage beside it', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1_379_665n });
    await house(35_000_000n, 23_500_000n);

    const composition = await buildComposition(prisma);

    expect(composition.assets.map((entry) => entry.name)).toContain('1505 E Otonka Trail (equity)');
    expect(composition.assets.find((entry) => entry.name.includes('Otonka'))?.balanceCents).toBe(
      11_500_000n,
    );
    // The mortgage is not listed twice.
    expect(composition.debts.map((entry) => entry.name)).not.toContain('Frontier Bank Mortgage');
  });

  /** The whole point of netting is that it changes presentation, not totals. */
  it('leaves net worth exactly where it was', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1_379_665n });
    await house(35_000_000n, 23_500_000n);

    const composition = await buildComposition(prisma);
    expect(composition.netCents).toBe(35_000_000n - 23_500_000n + 1_379_665n);
  });

  it('puts an underwater property on the debts side', async () => {
    await house(20_000_000n, 25_000_000n);

    const composition = await buildComposition(prisma);

    expect(composition.debts.map((entry) => entry.name)).toContain('1505 E Otonka Trail (equity)');
    expect(composition.totalDebtsCents).toBe(5_000_000n);
    expect(composition.netCents).toBe(-5_000_000n);
  });

  /** Netting against a loan outside this sum would subtract it twice. */
  it('does not net a mortgage that is not itself in net worth', async () => {
    const mortgage = await makeAccount({
      name: 'Frontier Bank Mortgage',
      type: 'debt',
      balanceCents: 23_500_000n,
      inBudget: false,
      inNetWorth: false,
    });
    const property = await makeAccount({
      name: '1505 E Otonka Trail',
      type: 'asset',
      balanceCents: 35_000_000n,
      inBudget: false,
      inNetWorth: true,
    });
    await prisma.account.update({
      where: { id: property.id },
      data: { mortgageAccountId: mortgage.id },
    });

    const composition = await buildComposition(prisma);
    expect(composition.totalAssetsCents).toBe(35_000_000n);
    expect(composition.netCents).toBe(35_000_000n);
  });
});
