import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { makeAccount, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/** The investments routes (ADR 080): positions are read, lots are the household's. */

let app: FastifyInstance;
let cookie: string;
let positionId: string;

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
  const account = await makeAccount({ name: 'Brokerage', type: 'asset', balanceCents: 0n });
  positionId = (
    await prisma.position.create({
      data: {
        accountId: account.id,
        feedKey: 'VTI',
        symbol: 'VTI',
        sharesMicros: 10_000_000n,
        marketValueCents: 300_000n,
        feedCostBasisCents: 250_000n,
        asOf: new Date(),
      },
    })
  ).id;
});

describe('lots', () => {
  it('adds one, reads it back in strings, and archives rather than deletes', async () => {
    const added = await app.inject({
      method: 'POST',
      url: `/api/investments/positions/${positionId}/lots`,
      headers: { cookie },
      payload: { purchasedOn: '2025-03-07', shares: '10', costCents: '250000' },
    });
    expect(added.statusCode).toBe(201);
    const lotId = added.json<{ lot: { id: string } }>().lot.id;

    const reading = (
      await app.inject({ method: 'GET', url: '/api/investments', headers: { cookie } })
    ).json<{
      positions: {
        shares: string;
        shareCoverage: string;
        costDifferenceCents: string | null;
        lots: { shares: string; costCents: string }[];
      }[];
    }>();
    expect(reading.positions[0]).toMatchObject({
      shares: '10',
      shareCoverage: 'matched',
      costDifferenceCents: '0',
      lots: [{ shares: '10', costCents: '250000' }],
    });

    const archived = await app.inject({
      method: 'POST',
      url: `/api/investments/lots/${lotId}/archive`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(200);
    // Still there, and no longer counted.
    expect(await prisma.positionLot.count()).toBe(1);
    expect(await prisma.positionLot.count({ where: { archivedAt: null } })).toBe(0);
  });

  it('refuses a lot it cannot hold exactly', async () => {
    for (const payload of [
      { purchasedOn: '2025-03-07', shares: '1.0000001', costCents: '100' },
      { purchasedOn: '2025-03-07', shares: '0', costCents: '100' },
      { purchasedOn: '2025-03-07', shares: '1', costCents: '-100' },
      { purchasedOn: '2025-03-07T12:00:00Z', shares: '1', costCents: '100' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/investments/positions/${positionId}/lots`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
