import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { recordSpotPrice, revalueBitcoinHoldings } from '../src/domain/bitcoin.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { makeAccount, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Bitcoin holdings and properties, created where they are managed.
 *
 * The bug this closes was quiet and expensive: setting a quantity never wrote
 * `balance_cents`, and the identity sums that column directly. An in-budget
 * holding therefore counted as zero in the one number the owner reads, while
 * every other screen showed it at its real worth.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

// $100,000.00 a Bitcoin. Round, so the arithmetic below can be read.
const PRICE_CENTS = 10_000_000n;

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

async function addHolding(payload: Record<string, unknown>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/bitcoin/holdings',
    headers: { cookie },
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ holding: { id: string } }>().holding.id;
}

async function addProperty(payload: Record<string, unknown>): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/properties',
    headers: { cookie },
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ property: { id: string } }>().property.id;
}

describe('a Bitcoin holding', () => {
  it('becomes an asset without an account being made first', async () => {
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000' });

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.type).toBe('asset');
    expect(account.source).toBe('manual');
    expect(account.managedAs).toBe('bitcoin');
    expect(account.bitcoinSats).toBe(50_000_000n);
    // Net worth by default, budget only when asked for.
    expect(account.inNetWorth).toBe(true);
    expect(account.inBudget).toBe(false);
  });

  it('contributes its real worth to the identity when it is in the budget', async () => {
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, new Date());
    // 0.5 BTC at $100,000.00 is $50,000.00.
    await addHolding({ name: 'Hardware wallet', sats: '50000000', inBudget: true });

    const identity = await computeBudgetIdentity(prisma);
    expect(identity.assetsCents).toBe(5_000_000n);
    expect(identity.differenceCents).toBe(5_000_000n);
  });

  it('contributes nothing to the identity when it is net worth only', async () => {
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, new Date());
    await addHolding({ name: 'Hardware wallet', sats: '50000000' });

    // Not a rounding question — the account is not part of the budget at all.
    expect((await computeBudgetIdentity(prisma)).assetsCents).toBe(0n);
  });

  it('is revalued the moment its quantity changes, not at the next daily pass', async () => {
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, new Date());
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000', inBudget: true });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/bitcoin/holdings/${id}`,
      headers: { cookie },
      payload: { sats: '100000000' },
    });
    expect(response.statusCode).toBe(200);

    // A day-old figure would be visibly wrong here, so it does not wait.
    expect((await computeBudgetIdentity(prisma)).assetsCents).toBe(10_000_000n);
  });

  it('gives up its budget figure when it leaves the budget', async () => {
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, new Date());
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000', inBudget: true });

    await app.inject({
      method: 'PATCH',
      url: `/api/bitcoin/holdings/${id}`,
      headers: { cookie },
      payload: { inBudget: false },
    });

    // Left behind, it would go on counting after the toggle said it should not.
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.balanceCents).toBe(0n);
    expect(account.bitcoinRevaluedAt).toBeNull();
    expect((await computeBudgetIdentity(prisma)).assetsCents).toBe(0n);
  });
});

describe('revaluation', () => {
  it('holds the figure for a day rather than following the price hourly', async () => {
    // Anchored to real time, because creating the holding stamps it with the
    // wall clock and the route has no seam for one.
    const base = new Date();
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, base);
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000', inBudget: true });
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).balanceCents).toBe(
      5_000_000n,
    );

    // The market doubles. The banner is a reading of spending, so it does not.
    await recordSpotPrice(prisma, { priceCents: 20_000_000n, source: 'coingecko' }, base);
    const anHourLater = new Date(base.getTime() + 60 * 60 * 1000);
    expect((await revalueBitcoinHoldings(prisma, {}, anHourLater)).revalued).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).balanceCents).toBe(
      5_000_000n,
    );

    // A day later it catches up, and the identity moves once rather than hourly.
    const nextDay = new Date(base.getTime() + 25 * 60 * 60 * 1000);
    expect((await revalueBitcoinHoldings(prisma, {}, nextDay)).revalued).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).balanceCents).toBe(
      10_000_000n,
    );
  });

  it('leaves a net-worth-only holding alone', async () => {
    await recordSpotPrice(prisma, { priceCents: PRICE_CENTS, source: 'coingecko' }, new Date());
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000' });

    // Nothing sums `balance_cents` for these — the chart and the composition
    // tile both derive quantity × price on read — so writing one would be a
    // second copy of a number already computed correctly elsewhere.
    expect((await revalueBitcoinHoldings(prisma, { force: true })).revalued).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).balanceCents).toBe(0n);
  });

  it('does nothing at all before a price has ever been fetched', async () => {
    await addHolding({ name: 'Hardware wallet', sats: '50000000', inBudget: true });
    // Never a zero, never a blank — the rule the whole price module follows.
    expect((await revalueBitcoinHoldings(prisma, { force: true })).revalued).toBe(0);
  });
});

describe('a property', () => {
  it('becomes an asset with its opening value, without an account being made first', async () => {
    const id = await addProperty({
      name: '1505 E Otonka Trail',
      valueCents: '35000000',
      asOf: '2026-08-01',
    });

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.managedAs).toBe('property');
    expect(account.type).toBe('asset');
    expect(account.balanceCents).toBe(35_000_000n);
    // A house is not spendable, so counting it as budget money is a decision.
    expect(account.inBudget).toBe(false);
    expect(account.inNetWorth).toBe(true);

    // The opening figure is history from the start, so the net worth chart has
    // something to read for that date rather than a hole.
    const valuations = await prisma.accountValuation.findMany({ where: { accountId: id } });
    expect(valuations).toHaveLength(1);
    expect(valuations[0]?.valueCents).toBe(35_000_000n);
  });

  it('reports equity against its mortgage, computed on read', async () => {
    const mortgage = await makeAccount({
      name: 'Frontier Bank Mortgage',
      type: 'debt',
      balanceCents: 21_000_000n,
      inBudget: false,
    });
    await addProperty({
      name: '1505 E Otonka Trail',
      valueCents: '35000000',
      asOf: '2026-08-01',
      mortgageAccountId: mortgage.id,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/properties',
      headers: { cookie },
    });
    const body = response.json<{ properties: { equityCents: string | null }[] }>();
    expect(body.properties[0]?.equityCents).toBe('14000000');
  });

  it('refuses a mortgage that is not a debt', async () => {
    const savings = await makeAccount({ name: 'Savings', type: 'asset', balanceCents: 100n });
    const id = await addProperty({
      name: '1505 E Otonka Trail',
      valueCents: '35000000',
      asOf: '2026-08-01',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/properties/${id}`,
      headers: { cookie },
      payload: { mortgageAccountId: savings.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('mortgage_not_a_debt');
  });
});

describe('the guard in the other direction', () => {
  it('refuses to edit a managed account from Settings → Accounts', async () => {
    const id = await addHolding({ name: 'Hardware wallet', sats: '50000000' });

    // Flipping the flag here would not write the dollar figure the identity
    // reads, which is exactly the bug this change closes. Closing it by
    // convention rather than construction would leave one route that still does.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      headers: { cookie },
      payload: { inBudget: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'account_managed_elsewhere',
    );
  });

  it('refuses to treat an ordinary account as a holding', async () => {
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/bitcoin/holdings/${account.id}`,
      headers: { cookie },
      payload: { sats: '1' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'account_not_managed_here',
    );
  });
});

describe('the in-budget warning', () => {
  it('is due once, and not again', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/bitcoin', headers: { cookie } });
    expect(before.json<{ inBudgetWarningDue: boolean }>().inBudgetWarningDue).toBe(true);

    await app.inject({
      method: 'POST',
      url: '/api/bitcoin/in-budget-acknowledgement',
      headers: { cookie },
    });

    // Repeated on every toggle, it would be a warning nobody reads.
    const after = await app.inject({ method: 'GET', url: '/api/bitcoin', headers: { cookie } });
    expect(after.json<{ inBudgetWarningDue: boolean }>().inBudgetWarningDue).toBe(false);
  });
});
