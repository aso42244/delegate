import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { recordSpotPrice } from '../src/domain/bitcoin.js';
import { buildNotifications } from '../src/domain/notifications.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';
import { categorizeTransaction } from '../src/domain/allocations.js';

/**
 * The banners the application raises about itself.
 *
 * Each of these is a condition the owner would otherwise discover only by
 * noticing a number was wrong. The test that matters most is the negative one:
 * a condition that has resolved must stop being reported, because these are
 * computed rather than stored and nothing ever "clears" them.
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

const kinds = async (now = NOW): Promise<string[]> =>
  (await buildNotifications(prisma, now)).map((notification) => notification.kind);

describe('a quiet system', () => {
  it('raises nothing at all', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 100n });
    expect(await kinds()).toEqual([]);
  });
});

describe('a failing sync', () => {
  it('is reported, because a failure must be visible outside the logs', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-07T03:00:00Z'),
        finishedAt: new Date('2026-08-07T03:00:05Z'),
        error: 'the bridge refused',
        correlationId: 'test-run-1',
      },
    });

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.kind).toBe('sync_failing');
    expect(notifications[0]?.severity).toBe('danger');
    // How long it has been broken is the part that decides whether to act.
    expect(notifications[0]?.message).toContain('2 days ago');
  });

  it('stops being reported once a later run succeeds', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-07T03:00:00Z'),
        correlationId: 'test-run-1',
      },
    });
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-08T03:00:00Z'),
        correlationId: 'test-run-2',
      },
    });

    expect(await kinds()).not.toContain('sync_failing');
  });
});

describe('stale balances', () => {
  it('names the accounts nobody has confirmed lately', async () => {
    await makeAccount({
      name: 'Physical Cash',
      type: 'asset',
      balanceCents: 20000n,
      stalenessIntervalDays: 30,
      balanceAsOf: new Date('2026-06-01T00:00:00Z'),
    });

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.kind).toBe('stale_balances');
    expect(notifications[0]?.message).toContain('Physical Cash');
  });

  /** A null interval means "never goes stale" — cash you check weekly, say. */
  it('says nothing about an account with no staleness interval', async () => {
    await makeAccount({
      name: 'Physical Cash',
      type: 'asset',
      balanceCents: 20000n,
      stalenessIntervalDays: null,
      balanceAsOf: new Date('2020-01-01T00:00:00Z'),
    });

    expect(await kinds()).toEqual([]);
  });

  it('summarizes rather than listing every one', async () => {
    for (const name of ['Cash', 'Wallet', 'House', 'Boat', 'Vault']) {
      await makeAccount({
        name,
        type: 'asset',
        balanceCents: 1n,
        stalenessIntervalDays: 30,
        balanceAsOf: new Date('2026-06-01T00:00:00Z'),
      });
    }

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.message).toContain('2 more');
  });
});

describe('the uncategorized backlog', () => {
  it('is informational rather than a fault, and reports its age', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      postedAt: new Date('2026-07-30T00:00:00Z'),
    });

    const notifications = await buildNotifications(prisma, NOW);
    const backlog = notifications.find((n) => n.kind === 'uncategorized_backlog');
    expect(backlog?.severity).toBe('info');
    expect(backlog?.message).toContain('10 days ago');
  });

  it('disappears once everything is categorized', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({ accountId: account.id, amountCents: -4210n });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    expect(await kinds()).not.toContain('uncategorized_backlog');
  });

  /** Income and confirmed transfers allocate to nothing; they are not a backlog. */
  it('ignores transactions that are not spending', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    await makeTransaction({ accountId: account.id, amountCents: 489000n, kind: 'income' });

    expect(await kinds()).not.toContain('uncategorized_backlog');
  });
});

describe('a stale Bitcoin price', () => {
  it('is flagged, since holdings are still valued at it', async () => {
    await recordSpotPrice(
      prisma,
      { priceCents: 10_000_000n, source: 'coingecko' },
      new Date('2026-08-07T12:00:00Z'),
    );

    const notifications = await buildNotifications(prisma, NOW);
    const stale = notifications.find((n) => n.kind === 'bitcoin_price_stale');
    expect(stale?.severity).toBe('warning');
    expect(stale?.message).toContain('2 days ago');
  });

  it('says nothing when the price is today', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, NOW);
    expect(await kinds()).not.toContain('bitcoin_price_stale');
  });
});

describe('accounts a sync discovered', () => {
  it('are flagged, because their type is a guess', async () => {
    const account = await makeAccount({ name: 'Discovered', type: 'asset', balanceCents: 1n });
    await prisma.account.update({ where: { id: account.id }, data: { needsReview: true } });

    expect(await kinds()).toContain('accounts_need_review');
  });
});

describe('the route', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(response.statusCode).toBe(401);
  });

  it('carries the action so a banner can lead somewhere', async () => {
    await prisma.syncRun.create({
      data: { status: 'failed', startedAt: new Date(), correlationId: 'test-run-3' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie },
    });
    const body = response.json<{ notifications: { actionPath: string }[] }>();

    expect(body.notifications[0]?.actionPath).toBe('/settings/sync');
  });
});
