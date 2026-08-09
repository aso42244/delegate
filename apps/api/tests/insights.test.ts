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
    expect(before.json<{ chosen: string[] }>().chosen).toEqual([]);

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
    expect(after.json<{ chosen: string[] }>().chosen).toEqual([
      'uncategorized_backlog',
      'asset_debt_composition',
    ]);
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
