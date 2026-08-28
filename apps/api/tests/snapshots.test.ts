import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { captureSnapshot, snapshotStatus } from '../src/domain/snapshots.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import {
  makeAccount,
  makeDelegation,
  makeHolding,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The nightly snapshot, capturing what the application can see. See ADR 035.
 *
 * The properties worth protecting are the ones that make a stored row
 * trustworthy: it is idempotent, it never revises an observation, all three
 * tables move together, and the identity it stores is the same figure the Budget
 * page shows.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const DAY = new Date(Date.UTC(2026, 7, 27));

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

async function rowsFor(date: Date = DAY): Promise<{
  accounts: number;
  delegations: number;
  aggregate: number;
}> {
  const [accounts, delegations, aggregate] = await Promise.all([
    prisma.accountSnapshot.count({ where: { snapshotDate: date } }),
    prisma.delegationSnapshot.count({ where: { snapshotDate: date } }),
    prisma.aggregateSnapshot.count({ where: { snapshotDate: date } }),
  ]);
  return { accounts, delegations, aggregate };
}

describe('capturing a day', () => {
  it('writes a row per account, a row per delegation, and one aggregate', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });
    await makeDelegation({ name: 'Grocery' });
    await makeDelegation({ name: 'Fuel' });

    const result = await captureSnapshot(prisma, DAY);

    expect(result.accountsWritten).toBe(2);
    expect(result.delegationsWritten).toBe(2);
    expect(result.aggregateWritten).toBe(true);
    expect(await rowsFor()).toEqual({ accounts: 2, delegations: 2, aggregate: 1 });
  });

  it('files the rows under the date it was given, not under today', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await captureSnapshot(prisma, DAY);

    const row = await prisma.accountSnapshot.findFirst({ select: { snapshotDate: true } });
    expect(row?.snapshotDate.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('marks everything it saw as observed', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeDelegation({ name: 'Grocery' });
    await captureSnapshot(prisma, DAY);

    const accounts = await prisma.accountSnapshot.findMany({ select: { provenance: true } });
    const delegations = await prisma.delegationSnapshot.findMany({ select: { provenance: true } });
    const aggregate = await prisma.aggregateSnapshot.findFirst({ select: { provenance: true } });

    expect(accounts.every((row) => row.provenance === 'observed')).toBe(true);
    expect(delegations.every((row) => row.provenance === 'observed')).toBe(true);
    expect(aggregate?.provenance).toBe('observed');
  });

  /**
   * Reading the classification live would let re-typing a card as an asset, or
   * taking the house out of net worth, silently rewrite a chart already read.
   */
  it('records the classification as it stood, so a later change cannot rewrite it', async () => {
    const account = await makeAccount({
      name: 'Card',
      type: 'debt',
      balanceCents: 50_000n,
      inBudget: true,
      inNetWorth: true,
    });
    await captureSnapshot(prisma, DAY);

    await prisma.account.update({
      where: { id: account.id },
      data: { type: 'asset', inBudget: false, inNetWorth: false },
    });

    const row = await prisma.accountSnapshot.findFirst({
      where: { accountId: account.id },
      select: { accountType: true, inBudget: true, inNetWorth: true },
    });
    expect(row).toEqual({ accountType: 'debt', inBudget: true, inNetWorth: true });
  });

  it('records the grouping a delegation sat in, for the same reason', async () => {
    const grouping = await prisma.grouping.create({
      data: { name: 'Food', section: 'delegations' },
      select: { id: true },
    });
    const delegation = await makeDelegation({ name: 'Grocery', groupingId: grouping.id });
    await captureSnapshot(prisma, DAY);

    await prisma.delegation.update({ where: { id: delegation.id }, data: { groupingId: null } });

    const row = await prisma.delegationSnapshot.findFirst({
      where: { delegationId: delegation.id },
      select: { groupingId: true },
    });
    expect(row?.groupingId).toBe(grouping.id);
  });

  it('skips archived accounts and delegations', async () => {
    const account = await makeAccount({ name: 'Old', type: 'asset', balanceCents: 0n });
    const delegation = await makeDelegation({ name: 'Retired' });
    await prisma.account.update({ where: { id: account.id }, data: { archivedAt: new Date() } });
    await prisma.delegation.update({
      where: { id: delegation.id },
      data: { archivedAt: new Date() },
    });

    const result = await captureSnapshot(prisma, DAY);
    expect(result.accountsWritten).toBe(0);
    expect(result.delegationsWritten).toBe(0);
  });
});

describe('idempotency', () => {
  /**
   * The manual trigger points at any date, and the gap-filler will re-enter days
   * that already have rows. Running twice must not duplicate or corrupt them.
   */
  it('running twice for the same date changes nothing', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeDelegation({ name: 'Grocery' });

    await captureSnapshot(prisma, DAY);
    const before = await prisma.accountSnapshot.findMany({ orderBy: { accountId: 'asc' } });
    const aggregateBefore = await prisma.aggregateSnapshot.findFirst();

    const second = await captureSnapshot(prisma, DAY);

    expect(await rowsFor()).toEqual({ accounts: 1, delegations: 1, aggregate: 1 });
    // Nothing was written, and the result says so rather than reporting work.
    expect(second.accountsWritten).toBe(0);
    expect(second.accountsKept).toBe(1);
    expect(second.aggregateWritten).toBe(false);

    const after = await prisma.accountSnapshot.findMany({ orderBy: { accountId: 'asc' } });
    expect(after).toEqual(before);
    expect(await prisma.aggregateSnapshot.findFirst()).toEqual(aggregateBefore);
  });

  /**
   * The rule that makes a re-run safe: a re-run repairs what is missing and
   * revises nothing that was seen. Here the balance moves between the two runs,
   * and the stored observation must not follow it.
   */
  it('never overwrites an observed row, even when the live figure has changed', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await captureSnapshot(prisma, DAY);

    await prisma.account.update({
      where: { id: account.id },
      data: { balanceCents: 900_000n },
    });
    await captureSnapshot(prisma, DAY);

    const row = await prisma.accountSnapshot.findFirst({ select: { balanceCents: true } });
    expect(row?.balanceCents).toBe(500_000n);
  });

  it('does not overwrite an observed aggregate either', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await captureSnapshot(prisma, DAY);

    await prisma.account.updateMany({ data: { balanceCents: 900_000n } });
    await captureSnapshot(prisma, DAY);

    const aggregate = await prisma.aggregateSnapshot.findFirst();
    expect(aggregate?.netWorthAssetsCents).toBe(500_000n);
  });

  /**
   * A row written by the gap-filler is a derivation, and a later run that can do
   * better should be able to replace it. Only observations are frozen.
   */
  it('replaces a reconstructed row rather than freezing it', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await prisma.accountSnapshot.create({
      data: {
        snapshotDate: DAY,
        accountId: account.id,
        balanceCents: 111_111n,
        provenance: 'reconstructed',
        accountType: 'asset',
        inBudget: true,
        inNetWorth: true,
      },
    });

    await captureSnapshot(prisma, DAY);

    const row = await prisma.accountSnapshot.findFirst({
      select: { balanceCents: true, provenance: true },
    });
    expect(row).toEqual({ balanceCents: 500_000n, provenance: 'observed' });
  });

  it('captures a second date without disturbing the first', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await captureSnapshot(prisma, DAY);

    await prisma.account.update({ where: { id: account.id }, data: { balanceCents: 600_000n } });
    const nextDay = new Date(Date.UTC(2026, 7, 28));
    await captureSnapshot(prisma, nextDay);

    const rows = await prisma.accountSnapshot.findMany({ orderBy: { snapshotDate: 'asc' } });
    expect(rows.map((row) => row.balanceCents)).toEqual([500_000n, 600_000n]);
  });
});

describe('the aggregate', () => {
  /**
   * The stored identity must be the same figure the chip beside the Budget title
   * shows. If these drift, the drift chart reads as miscategorisation when it is
   * only two different sums.
   */
  it('stores the same identity the Budget page computes, pending term included', async () => {
    const checking = await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 500_000n,
    });
    await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 120_000n,
      actorId: null,
    });

    // A categorized pending charge: the fourth term, which the account balance
    // does not carry yet.
    const pending = await prisma.transaction.create({
      data: {
        accountId: checking.id,
        postedAt: new Date('2026-08-27T12:00:00Z'),
        amountCents: -7_500n,
        descriptionRaw: 'GROCERY STORE',
        description: 'Grocery Store',
        pending: true,
      },
      select: { id: true },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: pending.id, delegationId: grocery.id, amountCents: -7_500n },
    });

    const identity = await computeBudgetIdentity(prisma);
    await captureSnapshot(prisma, DAY);

    const aggregate = await prisma.aggregateSnapshot.findFirstOrThrow();
    expect(aggregate.identityValueCents).toBe(identity.differenceCents);
    expect(aggregate.pendingCategorizedCents).toBe(identity.pendingCents);
    expect(aggregate.budgetAssetsCents).toBe(identity.assetsCents);
    expect(aggregate.budgetDebtsCents).toBe(identity.debtsCents);
    expect(aggregate.totalDelegationsCents).toBe(identity.delegationsCents);
  });

  /**
   * The two scopes are different sums, and the house is the reason they exist.
   * A mortgage in net worth and out of the budget must move one and not the
   * other.
   */
  it('keeps the net worth scope and the budget scope apart', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 40_000_000n,
      inBudget: false,
      inNetWorth: true,
    });
    await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
      inNetWorth: true,
    });

    await captureSnapshot(prisma, DAY);
    const aggregate = await prisma.aggregateSnapshot.findFirstOrThrow();

    expect(aggregate.netWorthAssetsCents).toBe(40_500_000n);
    expect(aggregate.netWorthDebtsCents).toBe(25_000_000n);
    expect(aggregate.netWorthCents).toBe(15_500_000n);

    // The budget sees only the checking account.
    expect(aggregate.budgetAssetsCents).toBe(500_000n);
    expect(aggregate.budgetDebtsCents).toBe(0n);
  });

  /**
   * Archived delegations are summed exactly as the identity sums them. Archiving
   * requires $0 so they contribute nothing in practice, but excluding them would
   * let a nonzero archived line quietly break the identity instead of showing up
   * in it.
   */
  it('counts every delegation in the total, archived ones included', async () => {
    const delegation = await makeDelegation({ name: 'Retired' });
    await adjustDelegationByDelta(prisma, {
      delegationId: delegation.id,
      deltaCents: 4_200n,
      actorId: null,
    });
    await prisma.delegation.update({
      where: { id: delegation.id },
      data: { archivedAt: new Date() },
    });

    await captureSnapshot(prisma, DAY);
    const aggregate = await prisma.aggregateSnapshot.findFirstOrThrow();

    // No detail row for it, but it is still in the total — which is the point.
    expect(await prisma.delegationSnapshot.count()).toBe(0);
    expect(aggregate.totalDelegationsCents).toBe(4_200n);
  });
});

describe('a Bitcoin holding', () => {
  it('is valued at the market, with the quantity and price kept beside it', async () => {
    await prisma.bitcoinPrice.create({
      data: { priceDate: DAY, priceCents: 10_000_000n, source: 'test', isClose: true },
    });
    await makeHolding({ name: 'Cold storage', sats: 50_000_000n });

    await captureSnapshot(prisma, DAY);
    const row = await prisma.accountSnapshot.findFirstOrThrow({
      select: { balanceCents: true, quantitySats: true, priceCents: true, provenance: true },
    });

    // Half a Bitcoin at $100,000.
    expect(row.balanceCents).toBe(5_000_000n);
    expect(row.quantitySats).toBe(50_000_000n);
    expect(row.priceCents).toBe(10_000_000n);
    expect(row.provenance).toBe('observed');
  });

  /**
   * The quantity was seen; the price was guessed. A holding valued at a price
   * nobody recorded for that date is an estimate and says so — which is also how
   * the aggregate learns the day was not a clean observation.
   */
  it('is an estimate when the price had to be carried from an earlier day', async () => {
    await prisma.bitcoinPrice.create({
      data: {
        priceDate: new Date(Date.UTC(2026, 7, 20)),
        priceCents: 9_000_000n,
        source: 'test',
        isClose: true,
      },
    });
    await makeHolding({ name: 'Cold storage', sats: 50_000_000n });

    await captureSnapshot(prisma, DAY);

    const row = await prisma.accountSnapshot.findFirstOrThrow({ select: { provenance: true } });
    expect(row.provenance).toBe('interpolated');
  });

  it('contributes nothing and says so when no price has ever been recorded', async () => {
    await makeHolding({ name: 'Cold storage', sats: 50_000_000n });
    await captureSnapshot(prisma, DAY);

    const row = await prisma.accountSnapshot.findFirstOrThrow({
      select: { balanceCents: true, provenance: true, priceCents: true },
    });
    expect(row.balanceCents).toBe(0n);
    expect(row.priceCents).toBeNull();
    expect(row.provenance).toBe('interpolated');
  });
});

describe('provenance of the aggregate', () => {
  /**
   * One estimated account makes the whole day's total an estimate, however many
   * exact rows sat beside it.
   */
  it('takes the weakest provenance among its inputs', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeAccount({ name: 'Savings', type: 'asset', balanceCents: 100_000n });
    await makeDelegation({ name: 'Grocery' });
    // No price, so the holding is interpolated and everything else is observed.
    await makeHolding({ name: 'Cold storage', sats: 50_000_000n });

    await captureSnapshot(prisma, DAY);

    const accounts = await prisma.accountSnapshot.findMany({ select: { provenance: true } });
    expect(accounts.filter((row) => row.provenance === 'observed')).toHaveLength(2);

    const aggregate = await prisma.aggregateSnapshot.findFirstOrThrow();
    expect(aggregate.provenance).toBe('interpolated');
  });

  it('is observed when every row was', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeDelegation({ name: 'Grocery' });

    await captureSnapshot(prisma, DAY);
    const aggregate = await prisma.aggregateSnapshot.findFirstOrThrow();
    expect(aggregate.provenance).toBe('observed');
  });
});

describe('the status reading', () => {
  it('reports nothing recorded, and calls that stale', async () => {
    const status = await snapshotStatus(prisma);
    expect(status).toEqual({
      latestDate: null,
      latestProvenance: null,
      days: 0,
      stale: true,
    });
  });

  /**
   * A run is for the previous day, so the newest date is always a day behind
   * even when everything is working. A threshold of one day would warn every
   * morning, and a warning that fires in the ordinary case is one nobody reads.
   */
  it('does not call yesterday stale', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n });
    await captureSnapshot(prisma, DAY);

    const theNextMorning = new Date(Date.UTC(2026, 7, 28, 3, 10));
    const status = await snapshotStatus(prisma, theNextMorning);
    expect(status.days).toBe(1);
    expect(status.latestProvenance).toBe('observed');
    expect(status.stale).toBe(false);
  });

  it('calls it stale once the job has missed more than a night', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n });
    await captureSnapshot(prisma, DAY);

    const threeDaysOn = new Date(Date.UTC(2026, 7, 30, 3, 10));
    expect((await snapshotStatus(prisma, threeDaysOn)).stale).toBe(true);
  });
});

/** A second account at the ordinary `user` role, with a session. */
async function housemate(): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie },
    payload: { username: 'housemate', temporaryPassword: 'temporary-pass-phrase', role: 'user' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'housemate', password: 'temporary-pass-phrase' },
  });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie: sessionCookie(login.headers) },
    payload: { currentPassword: 'temporary-pass-phrase', newPassword: 'housemate-pass-phrase' },
  });
  await markTwoFactorEnrolled();
  return sessionCookie(changed.headers);
}

describe('the routes', () => {
  it('reports status to any signed-in person', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/snapshots/status',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ days: number; cron: string; timezone: string }>();
    expect(body.days).toBe(0);
    expect(body.cron).toBe('10 3 * * *');
    expect(body.timezone).toBeTruthy();
  });

  it('runs a snapshot for a given date on request', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });

    const response = await app.inject({
      method: 'POST',
      url: '/api/snapshots/run',
      headers: { cookie },
      payload: { date: '2026-08-27' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accountsWritten: number }>().accountsWritten).toBe(1);
    expect((await rowsFor()).aggregate).toBe(1);
  });

  /**
   * A date that has not finished has nothing to observe: the state it would
   * record is today's, filed under a day that has not happened.
   */
  it('refuses a date in the future rather than storing today under it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/snapshots/run',
      headers: { cookie },
      payload: { date: '2099-01-01' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'snapshot_date_in_the_future',
    );
  });

  it('is administrator-only, because it is maintenance rather than budgeting', async () => {
    const theirCookie = await housemate();

    // They can read it — plain Users have full budget access, and Insights needs
    // this — but they cannot make it run.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/snapshots/status',
          headers: { cookie: theirCookie },
        })
      ).statusCode,
    ).toBe(200);

    const response = await app.inject({
      method: 'POST',
      url: '/api/snapshots/run',
      headers: { cookie: theirCookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('needs a session at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/snapshots/status' });
    expect(response.statusCode).toBe(401);
  });
});
