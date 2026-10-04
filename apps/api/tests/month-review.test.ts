import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction, setAllocations } from '../src/domain/allocations.js';
import { buildMonthReview } from '../src/domain/month-review.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Month in review (ADR 078): a month read back from the ledger, never stored.
 *
 * The claim that matters is that it adds up — the lines and the uncategorized
 * row are Went out, to the cent — because a review that does not reconcile is a
 * second opinion about the budget rather than a reading of it.
 */

const AUGUST = new Date('2026-08-01T00:00:00.000Z');
// Well after August, so August is a finished month whatever the clock says.
const NOW = new Date('2026-10-04T12:00:00.000Z');
const ZONE = 'UTC';

let app: FastifyInstance;
let cookie: string;

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
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'owner', password: 'correct-horse-battery' },
  });
  cookie = sessionCookie(response.headers);
  await markTwoFactorEnrolled();
});

function on(day: string): Date {
  return new Date(`${day}T15:00:00.000Z`);
}

describe('a month in review', () => {
  it('adds up: every line and the uncategorized row are what went out', async () => {
    const everyday = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 900_000n });
    const ira = await makeAccount({
      name: 'IRA',
      type: 'asset',
      balanceCents: 900_000n,
      inBudget: false,
    });
    const groceries = await makeDelegation({ name: 'Groceries' });
    const household = await makeDelegation({ name: 'Household' });

    await makeTransaction({
      accountId: everyday.id,
      amountCents: 500_000n,
      kind: 'income',
      postedAt: on('2026-08-05'),
    });
    const kroger = await makeTransaction({
      accountId: everyday.id,
      amountCents: -8_412n,
      postedAt: on('2026-08-06'),
    });
    await categorizeTransaction(prisma, kroger.id, groceries.id);
    const costco = await makeTransaction({
      accountId: everyday.id,
      amountCents: -10_000n,
      postedAt: on('2026-08-07'),
    });
    await setAllocations(prisma, costco.id, [
      { delegationId: groceries.id, amountCents: -7_000n },
      { delegationId: household.id, amountCents: -3_000n },
    ]);
    await makeTransaction({
      accountId: everyday.id,
      amountCents: -999n,
      postedAt: on('2026-08-08'),
    });
    // Off the budget, so not spending: net worth is where it shows.
    await makeTransaction({ accountId: ira.id, amountCents: -5_000n, postedAt: on('2026-08-09') });
    // September's, so not August's.
    await makeTransaction({
      accountId: everyday.id,
      amountCents: -1_234n,
      postedAt: on('2026-09-02'),
    });

    // What a press gave Groceries this month. A transfer would not count.
    await prisma.delegationEvent.create({
      data: {
        delegationId: groceries.id,
        deltaCents: 20_000n,
        eventType: 'delegate',
        occurredAt: on('2026-08-01'),
      },
    });

    const review = await buildMonthReview(prisma, { month: AUGUST, timeZone: ZONE }, NOW);

    expect(review.cameInCents).toBe(500_000n);
    expect(review.wentOutCents).toBe(19_411n);
    expect(review.uncategorizedCents).toBe(999n);

    const linesSpent = review.lines.reduce((sum, line) => sum + line.spentCents, 0n);
    expect(linesSpent + review.uncategorizedCents).toBe(review.wentOutCents);

    const grocery = review.lines.find((line) => line.name === 'Groceries');
    expect(grocery).toMatchObject({
      delegatedCents: 20_000n,
      spentCents: 15_412n,
      leftCents: 4_588n,
    });
    // Household spent and was given nothing, so it went further than planned
    // and leads the list.
    expect(review.lines[0]?.name).toBe('Household');
    expect(review.lines[0]?.leftCents).toBe(-3_000n);
    // Nothing in July, so there is no month before to compare with.
    expect(review.previous).toBeNull();
  });

  it('names a bill that cost more than usual, and one that did not come', async () => {
    const everyday = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 900_000n });
    for (const [day, cents] of [
      ['2026-05-10', -9_600n],
      ['2026-06-10', -9_600n],
      ['2026-07-10', -9_600n],
      ['2026-08-10', -14_210n],
    ] as const) {
      await makeTransaction({
        accountId: everyday.id,
        amountCents: cents,
        description: 'PRAIRIE POWER & LIGHT',
        postedAt: on(day),
      });
    }
    for (const day of ['2026-05-03', '2026-06-03', '2026-07-03']) {
      await makeTransaction({
        accountId: everyday.id,
        amountCents: -1_549n,
        description: 'STREAMFLIX',
        postedAt: on(day),
      });
    }

    const review = await buildMonthReview(prisma, { month: AUGUST, timeZone: ZONE }, NOW);
    const power = review.bills.find((bill) => bill.name === 'PRAIRIE POWER & LIGHT');
    expect(power?.move).toMatchObject({
      kind: 'moved',
      amountCents: 14_210n,
      typicalCents: 9_600n,
    });
    const stream = review.bills.find((bill) => bill.name === 'STREAMFLIX');
    expect(stream?.move.kind).toBe('missed');
  });

  it('reads net worth from the snapshots at both edges of the month', async () => {
    const wallet = await makeAccount({ name: 'Cold storage', type: 'asset', balanceCents: 0n });
    const aggregate = (date: string, assets: bigint, debts: bigint) =>
      prisma.aggregateSnapshot.create({
        data: {
          snapshotDate: new Date(`${date}T00:00:00.000Z`),
          provenance: 'observed',
          netWorthAssetsCents: assets,
          netWorthDebtsCents: debts,
          netWorthCents: assets - debts,
          budgetAssetsCents: 0n,
          budgetDebtsCents: 0n,
          totalDelegationsCents: 0n,
          pendingCategorizedCents: 0n,
          identityValueCents: 0n,
        },
      });
    const holding = (date: string, cents: bigint) =>
      prisma.accountSnapshot.create({
        data: {
          snapshotDate: new Date(`${date}T00:00:00.000Z`),
          accountId: wallet.id,
          balanceCents: cents,
          provenance: 'observed',
          accountType: 'asset',
          inBudget: false,
          inNetWorth: true,
          quantitySats: 1_000_000n,
        },
      });
    await aggregate('2026-07-31', 100_000n, 20_000n);
    await holding('2026-07-31', 40_000n);
    await aggregate('2026-08-31', 130_000n, 15_000n);
    await holding('2026-08-31', 45_000n);

    const review = await buildMonthReview(prisma, { month: AUGUST, timeZone: ZONE }, NOW);
    expect(review.netWorth).toMatchObject({
      startCents: 80_000n,
      endCents: 115_000n,
      // Assets rose 30,000, and 5,000 of it was the holding's price.
      otherAssetsChangeCents: 25_000n,
      bitcoinChangeCents: 5_000n,
      debtsPaidDownCents: 5_000n,
    });
  });
});

describe('GET /api/month-review', () => {
  it('opens on the last finished month, and never on the one in progress', async () => {
    const everyday = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 0n });
    await makeTransaction({
      accountId: everyday.id,
      amountCents: -100n,
      postedAt: on('2026-01-15'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/month-review?month=2999-01',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      month: string;
      nextMonth: string | null;
      previousMonth: string | null;
      wentOutCents: string;
    }>();

    // Clamped to the newest finished month, which has nothing after it.
    expect(body.nextMonth).toBeNull();
    expect(body.previousMonth).not.toBeNull();
    // Cents as a string (ADR 002).
    expect(typeof body.wentOutCents).toBe('string');
  });

  it('refuses a month that is not one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/month-review?month=2026-13',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});
