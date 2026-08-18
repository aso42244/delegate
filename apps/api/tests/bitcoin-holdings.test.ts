import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { recordSpotPrice } from '../src/domain/bitcoin.js';
import {
  costBasis,
  recomputeHoldings,
  recordHoldingEvent,
  reverseHoldingEvent,
  satsOnDate,
} from '../src/domain/bitcoin-holdings.js';
import { netWorthSeries } from '../src/domain/history.js';
import { makeHolding, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The Bitcoin holdings ledger.
 *
 * The bug it closes: a quantity was one number on the account, so the net worth
 * chart applied *today's* quantity to every past date. Bitcoin bought last week
 * appeared to have been held all year, and the chart said so in a comment
 * because there was nowhere else to read a quantity from.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const HALF_BTC = 50_000_000n;

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
});

describe('what was held on a date', () => {
  it('counts everything up to that day and nothing after it', async () => {
    const { id } = await makeHolding({
      name: 'Hardware wallet',
      sats: HALF_BTC,
      heldSince: new Date('2026-03-01T00:00:00Z'),
    });

    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: HALF_BTC,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 6_000_000n,
      }),
    );

    // Before anything was held at all.
    expect(await satsOnDate(prisma, new Date('2026-02-28T00:00:00Z'))).toBe(0n);
    // After the opening, before the purchase.
    expect(await satsOnDate(prisma, new Date('2026-06-14T00:00:00Z'))).toBe(HALF_BTC);
    // On the day of the purchase — inclusive, because it happened that day.
    expect(await satsOnDate(prisma, new Date('2026-06-15T00:00:00Z'))).toBe(HALF_BTC * 2n);
  });

  it('is what the net worth chart values, rather than today s quantity', async () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const { id } = await makeHolding({
      name: 'Hardware wallet',
      sats: HALF_BTC,
      heldSince: new Date('2026-08-06T00:00:00Z'),
      inNetWorth: true,
    });

    // One price all week, so the quantity is the only thing that can move the line.
    await recordSpotPrice(
      prisma,
      { priceCents: 10_000_000n, source: 'test' },
      new Date('2026-08-06T12:00:00Z'),
    );

    // A second half bought on the 9th.
    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: HALF_BTC,
        occurredAt: new Date('2026-08-09T00:00:00Z'),
        priceCents: 10_000_000n,
      }),
    );

    const series = await netWorthSeries(prisma, 5, now);
    const at = (day: string): bigint | undefined =>
      series.points.find((point) => point.date.toISOString().startsWith(day))?.valueCents;

    // Half a Bitcoin on the 8th, a whole one on the 9th. Before this, both days
    // read the same because today's quantity was applied backwards.
    expect(at('2026-08-08')).toBe(5_000_000n);
    expect(at('2026-08-09')).toBe(10_000_000n);
  });

  it('starts the chart where the Bitcoin starts, not at zero before it', async () => {
    const now = new Date('2026-08-10T12:00:00Z');
    await makeHolding({
      name: 'Hardware wallet',
      sats: HALF_BTC,
      heldSince: new Date('2026-08-09T00:00:00Z'),
      inNetWorth: true,
    });
    // A price from before the holding existed. Having a price is not the same
    // as having something to value with it.
    await recordSpotPrice(
      prisma,
      { priceCents: 10_000_000n, source: 'test' },
      new Date('2026-08-06T12:00:00Z'),
    );

    const series = await netWorthSeries(prisma, 5, now);

    // History starts at the later of the two things it needs — a quantity and a
    // price — so the chart says "known from the 9th" rather than drawing a flat
    // line through days it cannot speak for.
    expect(series.earliestKnown?.toISOString()).toBe('2026-08-09T00:00:00.000Z');
    expect(series.points.every((point) => point.date >= new Date('2026-08-09T00:00:00Z'))).toBe(
      true,
    );
    expect(series.points[series.points.length - 1]?.valueCents).toBe(5_000_000n);
  });
});

describe('recording an event', () => {
  it('takes a magnitude and gets the direction from what kind it is', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });

    // Asking for a negative number *and* the word "sale" would be asking twice,
    // and a disagreement between the two would be a silent wrong balance.
    const result = await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'sale',
        sats: 10_000_000n,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 6_000_000n,
      }),
    );

    expect(result.balanceSats).toBe(40_000_000n);
  });

  it('refuses to sell more than is held', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });

    await expect(
      prisma.$transaction((tx) =>
        recordHoldingEvent(tx, {
          accountId: id,
          eventType: 'sale',
          sats: HALF_BTC + 1n,
          occurredAt: new Date('2026-06-15T00:00:00Z'),
        }),
      ),
    ).rejects.toThrow(/more Bitcoin than this holding has/);
  });

  it('refuses a price on a transfer, which buys nothing', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });

    // A price here would invent a gain out of moving your own money.
    await expect(
      prisma.$transaction((tx) =>
        recordHoldingEvent(tx, {
          accountId: id,
          eventType: 'transfer_in',
          sats: 1_000n,
          occurredAt: new Date('2026-06-15T00:00:00Z'),
          priceCents: 6_000_000n,
        }),
      ),
    ).rejects.toThrow(/buys nothing/);
  });

  it('backs one out by stamping it, and is idempotent', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });
    const event = await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: 10_000_000n,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 6_000_000n,
      }),
    );

    expect((await prisma.$transaction((tx) => reverseHoldingEvent(tx, event.id))).reversed).toBe(
      true,
    );
    expect(await satsOnDate(prisma, new Date('2026-12-31T00:00:00Z'))).toBe(HALF_BTC);

    // A retried request must not move the quantity a second time.
    expect((await prisma.$transaction((tx) => reverseHoldingEvent(tx, event.id))).reversed).toBe(
      false,
    );
    expect(await satsOnDate(prisma, new Date('2026-12-31T00:00:00Z'))).toBe(HALF_BTC);

    // Stamped rather than deleted: the history of what the chart showed stays
    // readable.
    const row = await prisma.bitcoinHoldingEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.reversedAt).not.toBeNull();
  });
});

describe('cost basis', () => {
  it('is what was actually paid for what is still held', async () => {
    // 0.5 at $60,000 = $30,000. Then 0.5 at $80,000 = $40,000. $70,000 for 1.
    const { id } = await makeHolding({
      name: 'Hardware wallet',
      sats: HALF_BTC,
      priceCents: 6_000_000n,
    });
    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: HALF_BTC,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 8_000_000n,
      }),
    );

    const basis = await costBasis(prisma);
    expect(basis.costCents).toBe(7_000_000n);
    expect(basis.basisSats).toBe(100_000_000n);
    expect(basis.unpricedSats).toBe(0n);
  });

  it('reports Bitcoin of unknown cost separately rather than as free', async () => {
    // An opening balance from before the ledger: nobody knows what it cost, and
    // calling it zero would read as "free" — a lie in the flattering direction.
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });
    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: HALF_BTC,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 8_000_000n,
      }),
    );

    const basis = await costBasis(prisma);
    expect(basis.costCents).toBe(4_000_000n);
    expect(basis.basisSats).toBe(HALF_BTC);
    expect(basis.unpricedSats).toBe(HALF_BTC);
  });

  it('reduces both pools in proportion when some is sold', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });
    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'purchase',
        sats: HALF_BTC,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        priceCents: 8_000_000n,
      }),
    );
    // Half of everything. Taking it from either pool first would flatter the
    // basis in one direction or the other.
    await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: 'sale',
        sats: HALF_BTC,
        occurredAt: new Date('2026-07-01T00:00:00Z'),
        priceCents: 9_000_000n,
      }),
    );

    const basis = await costBasis(prisma);
    expect(basis.basisSats).toBe(25_000_000n);
    expect(basis.unpricedSats).toBe(25_000_000n);
    expect(basis.costCents).toBe(2_000_000n);
  });
});

describe('the cached quantity', () => {
  it('is checkable against the ledger, and repairable', async () => {
    const { id } = await makeHolding({ name: 'Hardware wallet', sats: HALF_BTC });

    // Corrupt it out of band, the way a bad migration or a stray write would.
    await prisma.account.update({ where: { id }, data: { bitcoinSats: 1n } });

    const checked = await recomputeHoldings(prisma, { check: true });
    expect(checked.drifted).toHaveLength(1);
    expect(checked.drifted[0]?.actual).toBe(HALF_BTC);
    // --check writes nothing.
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).bitcoinSats).toBe(1n);

    await recomputeHoldings(prisma);
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).bitcoinSats).toBe(HALF_BTC);
  });
});

describe('the API', () => {
  it('records a dated purchase and reports the basis with it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/bitcoin/holdings',
      headers: { cookie },
      payload: { name: 'Hardware wallet' },
    });
    const id = created.json<{ holding: { id: string } }>().holding.id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/bitcoin/holdings/${id}/events`,
      headers: { cookie },
      payload: {
        eventType: 'purchase',
        sats: HALF_BTC.toString(),
        occurredAt: '2026-06-15',
        priceCents: '6000000',
      },
    });
    expect(response.statusCode).toBe(201);

    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'test' }, new Date());

    const history = await app.inject({
      method: 'GET',
      url: `/api/bitcoin/holdings/${id}/events`,
      headers: { cookie },
    });
    const body = history.json<{
      events: { costCents: string | null; eventType: string }[];
      costBasis: { costCents: string };
      unrealizedCents: string | null;
      worthCents: string | null;
    }>();

    expect(body.events[0]?.eventType).toBe('purchase');
    // Half of $60,000.
    expect(body.events[0]?.costCents).toBe('3000000');
    expect(body.costBasis.costCents).toBe('3000000');
    // Worth half of $100,000, cost half of $60,000.
    expect(body.worthCents).toBe('5000000');
    expect(body.unrealizedCents).toBe('2000000');
  });
});
