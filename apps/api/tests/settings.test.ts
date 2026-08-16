import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { makeDelegation, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * Settings → Budget, and the go-live stamp.
 *
 * The tolerance decides when the Budget page stops reading "Balanced" and the
 * undo window decides how long a Delegate press can be taken back, so both are
 * bounded rather than free. The go-live date is written once, by the first
 * Reconcile commit, and never moved by a later one.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

interface SettingsBody {
  undoWindowHours: number;
  identityToleranceCents: string;
  goLiveAt: string | null;
}

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

async function readSettings(): Promise<SettingsBody> {
  const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<SettingsBody>();
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/settings', () => {
  it('returns the configured values, with cents as a string', async () => {
    const body = await readSettings();
    expect(body.undoWindowHours).toBe(12);
    expect(body.identityToleranceCents).toBe('500');
    expect(body.goLiveAt).toBeNull();
  });
});

describe('PATCH /api/settings', () => {
  it('changes the tolerance, and the Budget page reads it', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '2500' },
    });
    expect(response.statusCode).toBe(200);

    // The banner's thresholds derive from this value rather than being fixed, so
    // the budget view has to be reading the same number.
    const view = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    expect(view.json<{ identity: { toleranceCents: string } }>().identity.toleranceCents).toBe(
      '2500',
    );
  });

  it('changes one value without disturbing the other', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { undoWindowHours: 24 },
    });

    const body = await readSettings();
    expect(body.undoWindowHours).toBe(24);
    expect(body.identityToleranceCents).toBe('500');
  });

  it('refuses a negative tolerance, which would make every reading over-delegated', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '-100' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('tolerance_negative');
  });

  it('refuses an undo window outside one hour to one week', async () => {
    for (const undoWindowHours of [0, 169]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { undoWindowHours },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('undo_window_out_of_range');
    }
  });
});

describe('go-live', () => {
  it('is stamped by the first reconcile and left alone by the next', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });

    const first = await app.inject({
      method: 'POST',
      url: '/api/budget/reconcile',
      headers: { cookie },
      payload: { lines: [{ delegationId: grocery.id, actualBalanceCents: '72500' }] },
    });
    expect(first.statusCode).toBe(200);

    const stamped = (await readSettings()).goLiveAt;
    expect(stamped).not.toBeNull();

    // A later reconcile is ordinary maintenance. Moving the date would rewrite
    // which history counts as backfill.
    const second = await app.inject({
      method: 'POST',
      url: '/api/budget/reconcile',
      headers: { cookie },
      payload: { lines: [{ delegationId: grocery.id, actualBalanceCents: '80000' }] },
    });
    expect(second.statusCode).toBe(200);
    expect((await readSettings()).goLiveAt).toBe(stamped);
  });

  it('corrects every line in one batch, and the cached balances agree', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const household = await makeDelegation({ name: 'Household' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/budget/reconcile',
      headers: { cookie },
      payload: {
        lines: [
          { delegationId: grocery.id, actualBalanceCents: '72500' },
          { delegationId: household.id, actualBalanceCents: '-1200' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ adjustedCount: number; batchId: string }>();
    expect(body.adjustedCount).toBe(2);

    const events = await prisma.delegationEvent.findMany({
      where: { batchId: body.batchId },
      select: { delegationId: true, deltaCents: true, eventType: true },
    });
    // One batch, one commit — not sixty separate writes that could half-apply.
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.eventType === 'adjust')).toBe(true);

    const balances = await prisma.delegation.findMany({
      where: { id: { in: [grocery.id, household.id] } },
      select: { id: true, balanceCents: true },
      orderBy: { name: 'asc' },
    });
    expect(balances.map((row) => row.balanceCents)).toEqual([72500n, -1200n]);
  });
});
