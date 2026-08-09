import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { equityFor, recordValuation, valueOnDate } from '../src/domain/valuations.js';
import { makeAccount, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * Property values, their history, and equity.
 *
 * Two properties carry the risk. A value recorded for an earlier date must not
 * change what the house is worth today — entering a figure you forgot from March
 * is not a revaluation. And equity is computed on read, because a stored copy
 * would drift from the mortgage balance on every payment, in the direction that
 * flatters.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

const MARCH = new Date('2026-03-15T00:00:00Z');
const JUNE = new Date('2026-06-15T00:00:00Z');

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

async function makeProperty(): Promise<{ id: string }> {
  return makeAccount({
    name: 'The house',
    type: 'asset',
    balanceCents: 0n,
    inBudget: false,
    inNetWorth: true,
  });
}

describe('recording a value', () => {
  it('sets the current balance when it is the newest', async () => {
    const property = await makeProperty();

    const result = await recordValuation(prisma, {
      accountId: property.id,
      valueCents: 45_000_000n,
      asOf: JUNE,
    });

    expect(result.isCurrent).toBe(true);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: property.id } });
    expect(account.balanceCents).toBe(45_000_000n);
  });

  /**
   * The property this test exists for: entering a figure you forgot from March
   * is not a revaluation, and must not move what the house is worth today.
   */
  it('does not move the current balance when an older date is filled in', async () => {
    const property = await makeProperty();

    await recordValuation(prisma, {
      accountId: property.id,
      valueCents: 45_000_000n,
      asOf: JUNE,
    });
    const older = await recordValuation(prisma, {
      accountId: property.id,
      valueCents: 42_000_000n,
      asOf: MARCH,
    });

    expect(older.isCurrent).toBe(false);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: property.id } });
    expect(account.balanceCents).toBe(45_000_000n);
  });

  it('replaces a value already recorded for the same date', async () => {
    const property = await makeProperty();

    await recordValuation(prisma, { accountId: property.id, valueCents: 44_000_000n, asOf: JUNE });
    await recordValuation(prisma, { accountId: property.id, valueCents: 45_000_000n, asOf: JUNE });

    const rows = await prisma.accountValuation.findMany({ where: { accountId: property.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueCents).toBe(45_000_000n);
  });

  it('refuses a negative value', async () => {
    const property = await makeProperty();

    await expect(
      recordValuation(prisma, { accountId: property.id, valueCents: -1n, asOf: JUNE }),
    ).rejects.toThrow(/cannot be negative/);
  });

  /** A fed balance is the institution's to state; the next sync would overwrite it. */
  it('refuses to value a SimpleFIN account', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 100n });
    await prisma.account.update({
      where: { id: account.id },
      data: { source: 'simplefin', externalId: 'acct-1' },
    });

    await expect(
      recordValuation(prisma, { accountId: account.id, valueCents: 100n, asOf: JUNE }),
    ).rejects.toThrow(/keep by hand/);
  });
});

describe('reading a value for a date', () => {
  it('uses the most recent value at or before that date', async () => {
    const property = await makeProperty();
    await recordValuation(prisma, { accountId: property.id, valueCents: 42_000_000n, asOf: MARCH });
    await recordValuation(prisma, { accountId: property.id, valueCents: 45_000_000n, asOf: JUNE });

    // April: still worth the March figure, because nothing revalued it.
    expect(await valueOnDate(prisma, property.id, new Date('2026-04-01T00:00:00Z'))).toBe(
      42_000_000n,
    );
    expect(await valueOnDate(prisma, property.id, new Date('2026-07-01T00:00:00Z'))).toBe(
      45_000_000n,
    );
  });

  /** The same error as applying today's Bitcoin price backwards. */
  it('never reaches forward to a later value', async () => {
    const property = await makeProperty();
    await recordValuation(prisma, { accountId: property.id, valueCents: 45_000_000n, asOf: JUNE });

    expect(await valueOnDate(prisma, property.id, MARCH)).toBeNull();
  });
});

describe('equity', () => {
  it('is the property value less what is still owed, computed on read', async () => {
    const mortgage = await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
    });
    const property = await makeProperty();
    await prisma.account.update({
      where: { id: property.id },
      data: { mortgageAccountId: mortgage.id },
    });
    await recordValuation(prisma, { accountId: property.id, valueCents: 45_000_000n, asOf: JUNE });

    const equity = await equityFor(prisma, property.id);
    expect(equity?.equityCents).toBe(20_000_000n);

    // Paying the mortgage down moves equity without anything being restated.
    await prisma.account.update({
      where: { id: mortgage.id },
      data: { balanceCents: 24_000_000n },
    });
    expect((await equityFor(prisma, property.id))?.equityCents).toBe(21_000_000n);
  });

  it('is null when no mortgage is linked', async () => {
    const property = await makeProperty();
    expect(await equityFor(prisma, property.id)).toBeNull();
  });
});

describe('the routes', () => {
  it('require a session', async () => {
    const property = await makeProperty();
    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts/${property.id}/valuations`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('records and lists a history, newest first', async () => {
    const property = await makeProperty();

    for (const [value, asOf] of [
      ['42000000', '2026-03-15'],
      ['45000000', '2026-06-15'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${property.id}/valuations`,
        headers: { cookie },
        payload: { valueCents: value, asOf },
      });
      expect(response.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: 'GET',
      url: `/api/accounts/${property.id}/valuations`,
      headers: { cookie },
    });
    const body = list.json<{ valuations: { valueCents: string; asOf: string }[] }>();

    expect(body.valuations.map((row) => row.valueCents)).toEqual(['45000000', '42000000']);
  });

  it('rejects a value that is not a whole number of cents', async () => {
    const property = await makeProperty();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${property.id}/valuations`,
      headers: { cookie },
      payload: { valueCents: '450000.50', asOf: '2026-06-15' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('invalid_request');
  });

  it('returns equity through the API', async () => {
    const mortgage = await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
    });
    const property = await makeProperty();

    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${property.id}`,
      headers: { cookie },
      payload: { mortgageAccountId: mortgage.id },
    });
    await app.inject({
      method: 'POST',
      url: `/api/accounts/${property.id}/valuations`,
      headers: { cookie },
      payload: { valueCents: '45000000', asOf: '2026-06-15' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts/${property.id}/equity`,
      headers: { cookie },
    });
    expect(response.json<{ equity: { equityCents: string } }>().equity.equityCents).toBe(
      '20000000',
    );
  });
});
