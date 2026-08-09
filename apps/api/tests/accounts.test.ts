import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { makeAccount, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * The account list.
 *
 * It exists so a transaction can be entered by hand against any real account,
 * including the off-budget ones the Main Budget deliberately does not carry. The
 * assertions below are mostly about what it must *not* leave out.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

interface AccountsBody {
  accounts: {
    id: string;
    name: string;
    type: string;
    balanceCents: string;
    inBudget: boolean;
    archivedAt: string | null;
  }[];
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

async function list(query = ''): Promise<AccountsBody> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/accounts${query}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<AccountsBody>();
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/accounts', () => {
  it('returns live accounts alphabetically', async () => {
    await makeAccount({ name: 'Zephyr Savings', type: 'asset', balanceCents: 100n });
    await makeAccount({ name: 'Ambient Checking', type: 'asset', balanceCents: 200n });

    const body = await list();
    expect(body.accounts.map((account) => account.name)).toEqual([
      'Ambient Checking',
      'Zephyr Savings',
    ]);
  });

  /**
   * The reason this route exists at all: an off-budget account has no row on the
   * Main Budget, and if it were missing here too its register could never be
   * corrected by hand.
   */
  it('includes off-budget accounts, which the budget view omits', async () => {
    await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
    });

    const body = await list();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.inBudget).toBe(false);
  });

  it('hides archived accounts unless they are asked for', async () => {
    const live = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500n });
    const gone = await makeAccount({ name: 'Old Card', type: 'debt', balanceCents: 0n });
    await prisma.account.update({
      where: { id: gone.id },
      data: { archivedAt: new Date('2026-07-01T00:00:00Z') },
    });

    const live_only = await list();
    expect(live_only.accounts.map((account) => account.id)).toEqual([live.id]);

    const all = await list('?includeArchived=true');
    expect(all.accounts).toHaveLength(2);
    expect(all.accounts.find((account) => account.id === gone.id)?.archivedAt).not.toBeNull();
  });

  it('carries balances as decimal strings of cents', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 1234567890123n });

    const body = await list();
    // Beyond Number.MAX_SAFE_INTEGER territory is the point: a JSON number would
    // already have lost precision by the time it arrived.
    expect(body.accounts[0]?.balanceCents).toBe('1234567890123');
  });
});

describe('POST /api/accounts', () => {
  it('creates a manual account with its balance confirmed as of now', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { cookie },
      payload: { name: 'Physical Cash', type: 'asset', balanceCents: '20000' },
    });

    expect(response.statusCode).toBe(201);
    const created = await prisma.account.findFirstOrThrow({ where: { name: 'Physical Cash' } });
    expect(created.source).toBe('manual');
    expect(created.balanceCents).toBe(20000n);
    // Typing a balance is confirming it, so staleness has something to count from.
    expect(created.balanceAsOf).not.toBeNull();
  });
});

describe('PATCH /api/accounts/:id', () => {
  it('changes the two booleans independently', async () => {
    const account = await makeAccount({ name: 'The house', type: 'asset', balanceCents: 100n });

    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { inBudget: false, inNetWorth: true },
    });

    const updated = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    // This independence is exactly what keeps a mortgage out of the identity.
    expect(updated.inBudget).toBe(false);
    expect(updated.inNetWorth).toBe(true);
  });

  it('sets a manual balance and restamps when it was confirmed', async () => {
    const account = await makeAccount({
      name: 'Physical Cash',
      type: 'asset',
      balanceCents: 20000n,
      balanceAsOf: new Date('2026-01-01T00:00:00Z'),
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { balanceCents: '17550' },
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.balanceCents).toBe(17550n);
    expect(updated.balanceAsOf?.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });

  /**
   * The next sync would overwrite it within the hour, so accepting it would be a
   * lie that corrects itself — which is harder to notice than a refusal.
   */
  it('refuses to set the balance of a SimpleFIN account', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500n });
    await prisma.account.update({
      where: { id: account.id },
      data: { source: 'simplefin', externalId: 'acct-1' },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { balanceCents: '999999' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('balance_not_editable');
    const unchanged = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(unchanged.balanceCents).toBe(500n);
  });

  it('rejects a staleness interval of less than a day', async () => {
    const account = await makeAccount({ name: 'Physical Cash', type: 'asset', balanceCents: 1n });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { stalenessIntervalDays: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('staleness_interval_invalid');
  });

  it('clears the review flag a sync raised', async () => {
    const account = await makeAccount({ name: 'Discovered', type: 'asset', balanceCents: 100n });
    await prisma.account.update({ where: { id: account.id }, data: { needsReview: true } });

    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      headers: { cookie },
      payload: { type: 'debt', needsReview: false },
    });

    const updated = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(updated.type).toBe('debt');
    expect(updated.needsReview).toBe(false);
  });
});

describe('archiving', () => {
  /**
   * The identity subtracts what the in-budget accounts hold, so archiving real
   * money would move the bottom line with nothing on screen to explain it.
   */
  it('is refused while an in-budget account still holds money', async () => {
    const account = await makeAccount({
      name: 'Everyday',
      type: 'asset',
      balanceCents: 40000n,
      inBudget: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/archive`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    const error = errorOf(response);
    expect(error.code).toBe('account_balance_not_zero');
    // The balance is carried so the UI can say what has to happen next.
    expect(error.details?.['balanceCents']).toBe('40000');
  });

  /** The house and the mortgage are not part of the identity, so there is nothing to protect. */
  it('is allowed for an off-budget account with a balance', async () => {
    const account = await makeAccount({
      name: 'The house',
      type: 'asset',
      balanceCents: 45_000_000n,
      inBudget: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/archive`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const archived = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('archives an emptied account and restores it again', async () => {
    const account = await makeAccount({ name: 'Old Card', type: 'debt', balanceCents: 0n });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/accounts/${account.id}/archive`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    // Nothing is hard-deleted: the row is still there, and comes back.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/accounts/${account.id}/restore`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);

    const restored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(restored.archivedAt).toBeNull();
  });
});

describe('GET /api/archived', () => {
  it('lists what is archived, and nothing that is not', async () => {
    const live = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500n });
    const gone = await makeAccount({ name: 'Old Card', type: 'debt', balanceCents: 0n });
    await app.inject({
      method: 'POST',
      url: `/api/accounts/${gone.id}/archive`,
      headers: { cookie },
    });

    const delegation = await prisma.delegation.create({
      data: { name: 'Retired envelope', archivedAt: new Date() },
      select: { id: true },
    });

    const response = await app.inject({ method: 'GET', url: '/api/archived', headers: { cookie } });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      accounts: { id: string; name: string }[];
      delegations: { id: string }[];
      groupings: { id: string }[];
    }>();

    expect(body.accounts.map((account) => account.id)).toEqual([gone.id]);
    expect(body.accounts.map((account) => account.id)).not.toContain(live.id);
    expect(body.delegations.map((row) => row.id)).toEqual([delegation.id]);
    expect(body.groupings).toEqual([]);
  });
});
