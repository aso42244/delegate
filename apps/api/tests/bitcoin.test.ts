import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import {
  fetchAndRecordPrice,
  latestPrice,
  priceOnDate,
  recordSpotPrice,
  type PriceProvider,
} from '../src/domain/bitcoin.js';
import { makeAccount, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * The Bitcoin price feed.
 *
 * The property that matters most is that the net worth chart uses the price that
 * actually applied on each date. Applying today's price backwards would rewrite
 * history every time it moved, which is the specific error the daily close cache
 * exists to prevent.
 *
 * The second is that an unreachable feed never produces a zero. A holding that
 * silently reads $0.00 looks like an answer; one that reads yesterday's price
 * marked stale is the truth.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

const DAY_ONE = new Date('2026-08-01T12:00:00Z');
const DAY_TWO = new Date('2026-08-02T12:00:00Z');
const DAY_THREE = new Date('2026-08-03T12:00:00Z');

/** A provider that answers with whatever it is told, or refuses. */
function stubProvider(name: string, priceCents: bigint | Error): PriceProvider {
  return {
    name,
    fetchSpotPriceCents: () =>
      priceCents instanceof Error ? Promise.reject(priceCents) : Promise.resolve(priceCents),
  };
}

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
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

describe('recording a price', () => {
  it('keeps one intraday row per day, updated in place', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);
    await recordSpotPrice(
      prisma,
      { priceCents: 10_500_000n, source: 'coingecko' },
      new Date('2026-08-01T18:00:00Z'),
    );

    const rows = await prisma.bitcoinPrice.findMany({ where: { isClose: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.priceCents).toBe(10_500_000n);
  });

  it('refuses a price that is not positive', async () => {
    await expect(
      recordSpotPrice(prisma, { priceCents: 0n, source: 'coingecko' }, DAY_ONE),
    ).rejects.toThrow(/positive/);
  });

  /**
   * Settled by the next day's fetch rather than a midnight job: a container that
   * was stopped overnight would miss a midnight job entirely and leave a
   * permanent hole in the chart.
   */
  it('settles the previous day close on the next day fetch', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);
    const result = await recordSpotPrice(
      prisma,
      { priceCents: 11_000_000n, source: 'coingecko' },
      DAY_TWO,
    );

    expect(result.closesSettled).toBe(1);
    const close = await prisma.bitcoinPrice.findFirst({ where: { isClose: true } });
    expect(close?.priceCents).toBe(10_000_000n);
    expect(close?.priceDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not re-settle a close it already wrote', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);
    await recordSpotPrice(prisma, { priceCents: 11_000_000n, source: 'coingecko' }, DAY_TWO);
    const third = await recordSpotPrice(
      prisma,
      { priceCents: 12_000_000n, source: 'coingecko' },
      DAY_THREE,
    );

    // Only day two needed settling this time.
    expect(third.closesSettled).toBe(1);
    expect(await prisma.bitcoinPrice.count({ where: { isClose: true } })).toBe(2);
  });
});

describe('falling back between providers', () => {
  it('uses the fallback when the primary refuses', async () => {
    const result = await fetchAndRecordPrice(
      prisma,
      [
        stubProvider('coingecko', new Error('502 from the primary')),
        stubProvider('coinbase', 10_250_000n),
      ],
      DAY_ONE,
    );

    expect(result?.source).toBe('coinbase');
    expect(result?.priceCents).toBe(10_250_000n);
  });

  it('reports when neither answers, and records nothing', async () => {
    await expect(
      fetchAndRecordPrice(
        prisma,
        [
          stubProvider('coingecko', new Error('primary down')),
          stubProvider('coinbase', new Error('fallback down')),
        ],
        DAY_ONE,
      ),
    ).rejects.toThrow(/No Bitcoin price source answered/);

    expect(await prisma.bitcoinPrice.count()).toBe(0);
  });
});

describe('reading a price for a date', () => {
  /** The whole reason the close cache exists. */
  it('uses the price that applied on that date, not the newest one', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);
    await recordSpotPrice(prisma, { priceCents: 20_000_000n, source: 'coingecko' }, DAY_TWO);

    const reading = await priceOnDate(prisma, DAY_ONE);
    expect(reading?.priceCents).toBe(10_000_000n);
    expect(reading?.stale).toBe(false);
  });

  it('carries the previous close forward for a day with no price, and says so', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);
    await recordSpotPrice(prisma, { priceCents: 20_000_000n, source: 'coingecko' }, DAY_THREE);

    // Nothing was recorded on day two — the application was not running.
    const reading = await priceOnDate(prisma, DAY_TWO);
    expect(reading?.priceCents).toBe(10_000_000n);
    expect(reading?.stale).toBe(true);
  });

  it('is null before any price has ever been fetched', async () => {
    expect(await priceOnDate(prisma, DAY_ONE)).toBeNull();
    expect(await latestPrice(prisma)).toBeNull();
  });

  it('marks the latest price stale once the day has moved on', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, DAY_ONE);

    expect((await latestPrice(prisma, DAY_ONE))?.stale).toBe(false);
    expect((await latestPrice(prisma, DAY_THREE))?.stale).toBe(true);
  });
});

describe('GET /api/bitcoin', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bitcoin' });
    expect(response.statusCode).toBe(401);
  });

  it('values the holding at the current price', async () => {
    const account = await makeAccount({
      name: 'Hardware wallet',
      type: 'asset',
      balanceCents: 0n,
      inBudget: false,
    });
    // 0.5 BTC
    await prisma.account.update({
      where: { id: account.id },
      data: { bitcoinSats: 50_000_000n },
    });
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, new Date());

    const response = await app.inject({ method: 'GET', url: '/api/bitcoin', headers: { cookie } });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      price: { priceCents: string; stale: boolean } | null;
      holdings: { sats: string; valueCents: string | null }[];
    }>();

    expect(body.price?.priceCents).toBe('10000000');
    expect(body.holdings[0]?.sats).toBe('50000000');
    // Half of $100,000.00.
    expect(body.holdings[0]?.valueCents).toBe('5000000');
  });

  /** Never a zero: a holding worth nothing and a price nobody has are different. */
  it('reports no value rather than zero before any price exists', async () => {
    const account = await makeAccount({
      name: 'Hardware wallet',
      type: 'asset',
      balanceCents: 0n,
    });
    await prisma.account.update({
      where: { id: account.id },
      data: { bitcoinSats: 50_000_000n },
    });

    const response = await app.inject({ method: 'GET', url: '/api/bitcoin', headers: { cookie } });
    const body = response.json<{
      price: unknown;
      holdings: { valueCents: string | null }[];
    }>();

    expect(body.price).toBeNull();
    expect(body.holdings[0]?.valueCents).toBeNull();
  });
});

describe('PATCH /api/accounts/:id/bitcoin', () => {
  it('stores a quantity, not a value', async () => {
    const account = await makeAccount({ name: 'Hardware wallet', type: 'asset', balanceCents: 0n });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}/bitcoin`,
      headers: { cookie },
      payload: { sats: '12345678' },
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.bitcoinSats).toBe(12_345_678n);
    // The dollar balance is untouched: the quantity is the fact.
    expect(updated.balanceCents).toBe(0n);
  });

  it('rejects a fractional or negative quantity', async () => {
    const account = await makeAccount({ name: 'Hardware wallet', type: 'asset', balanceCents: 0n });

    for (const sats of ['1.5', '-1']) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${account.id}/bitcoin`,
        headers: { cookie },
        payload: { sats },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_request');
    }
  });
});
