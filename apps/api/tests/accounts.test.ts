import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { makeAccount, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

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
