import { merchantKey } from '@budget/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { API_TOKEN_PREFIX, digestOf, issueApiToken } from '../src/domain/api-tokens.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { writeCheck } from '../src/domain/checks.js';
import { buildPanel } from '../src/domain/overview.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  makeUser,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * The read door and the credential that opens it (ADRs 069 and 070).
 *
 * What is asserted here is the shape of the door rather than the figures behind
 * it — those are proved where the domain functions are. Three things a mistake
 * in which is a security hole rather than a bug: that only a bearer token opens
 * it and a session cannot; that a token opens it and nothing else; and that an
 * unknown token, a revoked one and an archived account's are indistinguishable
 * from outside.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const ONION = 'delegatehqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion';

interface TokenPayload {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedFrom: string | null;
  readonly revokedAt: string | null;
}

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

async function issue(name = 'Eventide'): Promise<{ token: TokenPayload; secret: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: { cookie },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ token: TokenPayload; secret: string }>();
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe('issuing a token', () => {
  it('returns the secret once, prefixed, and stores only its digest', async () => {
    const { token, secret } = await issue();

    expect(secret.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token).toMatchObject({ name: 'Eventide', lastUsedAt: null, revokedAt: null });

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(row.tokenHash).toBe(digestOf(secret));
    expect(row.tokenHash).not.toContain(secret.slice(API_TOKEN_PREFIX.length));

    // And the list never carries it either.
    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    expect(list.body).not.toContain(secret);
    expect(list.json<{ tokens: TokenPayload[] }>().tokens).toHaveLength(1);
  });

  it('needs a name, and trims it', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: { cookie },
      payload: { name: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const { token } = await issue('  Eventide  ');
    expect(token.name).toBe('Eventide');
  });

  it('needs a session — a token cannot mint a token', async () => {
    const { secret } = await issue();
    const response = await app.inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: bearer(secret),
      payload: { name: 'Another' },
    });
    expect(response.statusCode).toBe(401);
    expect(await prisma.apiToken.count()).toBe(1);
  });

  it('is recorded in the credential log', async () => {
    await issue();
    const events = await app.inject({
      method: 'GET',
      url: '/api/auth-events',
      headers: { cookie },
    });
    expect(
      events.json<{ events: { kind: string }[] }>().events.map((event) => event.kind),
    ).toContain('api_token_created');
  });
});

describe('the read door', () => {
  it('opens for a bearer token and answers money as strings of cents', async () => {
    const { secret } = await issue();
    await makeAccount({ name: 'Everyday Checking', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 25000n });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.json<{
      asOf: string;
      identity: { status: string; differenceCents: string; assetsCents: string };
      delegations: { id: string; name: string; balanceCents: string; grouping: null }[];
      accounts: { name: string; type: string; balanceCents: string }[];
    }>();

    // $5,000.00 is "500000", never 5000 and never 500000 as a number.
    expect(body.identity.assetsCents).toBe('500000');
    expect(typeof body.identity.differenceCents).toBe('string');
    expect(body.identity.status).toBe('to_delegate');
    expect(body.accounts).toEqual([
      expect.objectContaining({ name: 'Everyday Checking', type: 'asset', balanceCents: '500000' }),
    ]);
    expect(body.delegations).toEqual([
      expect.objectContaining({
        id: grocery.id,
        name: 'Grocery',
        balanceCents: '0',
        amountToDelegateCents: '25000',
        grouping: null,
      }),
    ]);
    expect(new Date(body.asOf).getTime()).not.toBeNaN();
  });

  it('describes a check, and says null rather than nothing on an envelope', async () => {
    const { secret } = await issue();
    await makeDelegation({ name: 'Grocery' });
    const check = await prisma.delegation.create({
      data: {
        name: 'Check 1042 — Roof repair',
        kind: 'check',
        checkNumber: '1042',
        checkMemo: 'Roof repair',
        checkIssuedAt: new Date('2026-09-12T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);

    const rows = response.json<{
      delegations: {
        id: string;
        kind: string;
        checkNumber: string | null;
        checkMemo: string | null;
        checkIssuedAt: string | null;
      }[];
    }>().delegations;

    expect(rows.find((row) => row.id === check.id)).toMatchObject({
      kind: 'check',
      checkNumber: '1042',
      checkMemo: 'Roof repair',
      // An instant, in UTC, like every other instant the door sends.
      checkIssuedAt: '2026-09-12T00:00:00.000Z',
    });

    // Present and null, never absent: a key that comes and goes is two shapes.
    const envelope = rows.find((row) => row.kind === 'envelope');
    expect(envelope).toBeDefined();
    for (const key of ['checkNumber', 'checkMemo', 'checkIssuedAt'] as const) {
      expect(envelope).toHaveProperty(key, null);
    }
  });

  it('sends null, never an empty string, for a check written without a memo', async () => {
    const { secret } = await issue();
    const source = await makeDelegation({ name: 'Home Repairs' });
    // Through the real write path, with the memo box left blank — the case
    // that could otherwise reach Eventide as "" rather than null.
    const check = await writeCheck(prisma, {
      checkNumber: '1062',
      amountCents: 50_00n,
      issuedAt: new Date('2026-09-12T14:03:00.000Z'),
      memo: '   ',
      sourceDelegationId: source.id,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);

    const row = response
      .json<{ delegations: { id: string }[] }>()
      .delegations.find((line) => line.id === check.id);
    expect(row).toMatchObject({
      kind: 'check',
      checkNumber: '1062',
      checkIssuedAt: '2026-09-12T14:03:00.000Z',
    });
    expect(row).toHaveProperty('checkMemo', null);
  });

  it('answers the overview: every figure, the cycle, the backlog, the overspent', async () => {
    const { secret } = await issue();
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100000n });
    await makeTransaction({ accountId: account.id, amountCents: -4210n, postedAt: new Date() });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/overview',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      payCycle: null | { start: string };
      figures: { key: string; valueCents: string | null; count: number | null }[];
      uncategorized: { count: number; oldestPostedAt: string | null };
      overspent: unknown[];
      spendingByGrouping: { entries: { spendCents: string }[] };
    }>();

    // No payday anchor means no cycle, and the figures that need one say null
    // rather than inventing a divisor.
    expect(body.payCycle).toBeNull();
    expect(body.figures.map((figure) => figure.key)).toEqual([
      'inflow',
      'spent',
      'left_to_spend',
      'uncategorized',
      'safe_per_day',
      'net_worth',
      'days_to_payday',
    ]);
    expect(body.figures.find((figure) => figure.key === 'spent')?.valueCents).toBe('4210');
    expect(body.figures.find((figure) => figure.key === 'safe_per_day')?.valueCents).toBeNull();
    expect(body.uncategorized.count).toBe(1);
    expect(body.overspent).toEqual([]);
  });

  it("sends this cycle's spend per line, one entry for every active line", async () => {
    const { secret } = await issue();
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const fuel = await makeDelegation({ name: 'Fuel' });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      postedAt: new Date(),
    });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/overview',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);
    const { spending } = response.json<{ spending: { id: string; spentCents: string }[] }>();

    // Every active line, spent or not: the selection decides what Eventide
    // shows, never what is computed. Whole cents as a string (ADR 002).
    expect(spending).toHaveLength(2);
    expect(spending.find((line) => line.id === grocery.id)?.spentCents).toBe('4210');
    expect(spending.find((line) => line.id === fuel.id)?.spentCents).toBe('0');
    expect(spending.every((line) => typeof line.spentCents === 'string')).toBe(true);

    // The same figure the Overview page's panel draws — no new arithmetic.
    const panel = await buildPanel(prisma, { since: null, timeZone: 'UTC' });
    expect(spending).toEqual(
      panel.map((line) => ({ id: line.id, spentCents: line.spentCents.toString() })),
    );
  });

  it('stamps when the token was last used and from where', async () => {
    const { token, secret } = await issue();

    await app.inject({ method: 'GET', url: '/api/read/overview', headers: bearer(secret) });

    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    const [used] = list.json<{ tokens: TokenPayload[] }>().tokens;
    expect(used?.id).toBe(token.id);
    expect(used?.lastUsedAt).not.toBeNull();
    expect(used?.lastUsedFrom).toBe('127.0.0.1');
  });

  it('refuses a session cookie: a signed-in browser cannot reach it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('bearer_required');
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a cookie even when a bearer token rides beside it', async () => {
    // The guard reads the header and only the header; an invalid token is not
    // rescued by a live session sitting in the same request.
    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: { cookie, ...bearer(`${API_TOKEN_PREFIX}not-a-real-one`) },
    });
    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('invalid_token');
  });

  it('has no write path: nothing here answers a POST', async () => {
    const { secret } = await issue();
    for (const url of [
      '/api/read/budget',
      '/api/read/overview',
      '/api/read/transactions',
      '/api/read/transactions/00000000-0000-4000-8000-000000000000',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: bearer(secret),
        payload: { amountCents: '100' },
      });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('route_not_found');
    }
  });

  it('says nothing over the onion address while remote access is off', async () => {
    const { secret } = await issue();
    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: { ...bearer(secret), host: ONION },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('');
  });
});

describe('reading the register', () => {
  interface ReadTransaction {
    readonly id: string;
    readonly postedAt: string;
    readonly amountCents: string;
    readonly description: string;
    readonly merchantName: string | null;
    readonly pending: boolean;
    readonly kind: string;
    readonly archivedAt: string | null;
    readonly account: { id: string; name: string; type: string };
    readonly allocations: { delegationId: string; name: string; amountCents: string }[];
  }
  interface ReadList {
    readonly transactions: ReadTransaction[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }

  it('lists newest first, whole: the account, the lines, and the merchant by its own name', async () => {
    const { secret } = await issue();
    const card = await makeAccount({ name: 'Rewards Visa', type: 'debt', balanceCents: 0n });
    const home = await makeDelegation({ name: 'Household' });
    const older = await makeTransaction({
      accountId: card.id,
      amountCents: -1_299n,
      description: 'ACE HARDWARE #4411',
      postedAt: new Date('2026-09-01T15:00:00Z'),
    });
    const tv = await makeTransaction({
      accountId: card.id,
      amountCents: -64_999n,
      description: 'BESTBUY 00012 ONLINE',
      postedAt: new Date('2026-09-14T15:00:00Z'),
    });
    await categorizeTransaction(prisma, tv.id, home.id);
    await prisma.billOverride.create({
      data: {
        merchantKey: merchantKey('BESTBUY 00012 ONLINE'),
        label: 'BESTBUY 00012 ONLINE',
        displayName: 'Best Buy',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/read/transactions',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ReadList>();
    expect(body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(body.transactions.map((row) => row.id)).toEqual([tv.id, older.id]);
    expect(body.transactions[0]).toEqual({
      id: tv.id,
      postedAt: '2026-09-14T15:00:00.000Z',
      amountCents: '-64999',
      description: 'BESTBUY 00012 ONLINE',
      merchantName: 'Best Buy',
      pending: false,
      kind: 'normal',
      archivedAt: null,
      account: { id: card.id, name: 'Rewards Visa', type: 'debt' },
      allocations: [{ delegationId: home.id, name: 'Household', amountCents: '-64999' }],
    });
  });

  it('finds one purchase by words, the household name, a window and a direction', async () => {
    const { secret } = await issue();
    const card = await makeAccount({ name: 'Rewards Visa', type: 'debt', balanceCents: 0n });
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    const tv = await makeTransaction({
      accountId: card.id,
      amountCents: -64_999n,
      description: 'BESTBUY 00012 ONLINE',
      postedAt: new Date('2026-09-14T15:00:00Z'),
    });
    await makeTransaction({
      accountId: card.id,
      amountCents: 64_999n,
      description: 'BESTBUY 00012 RETURN',
      postedAt: new Date('2026-09-20T15:00:00Z'),
    });
    await makeTransaction({
      accountId: checking.id,
      amountCents: -2_500n,
      description: 'BESTBUY 00012 ONLINE',
      postedAt: new Date('2026-08-02T15:00:00Z'),
    });
    await prisma.billOverride.create({
      data: {
        merchantKey: merchantKey('BESTBUY 00012 ONLINE'),
        label: 'BESTBUY 00012 ONLINE',
        displayName: 'Best Buy',
      },
    });

    const ids = async (query: string): Promise<string[]> => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/read/transactions?${query}`,
        headers: bearer(secret),
      });
      expect(response.statusCode, query).toBe(200);
      return response.json<ReadList>().transactions.map((row) => row.id);
    };

    // The household's name finds what the bank calls something else.
    expect(await ids('search=best%20buy')).toHaveLength(3);
    expect(
      await ids(`search=best%20buy&sign=out&accountId=${card.id}&dateFrom=2026-09-01T00:00:00Z`),
    ).toEqual([tv.id]);
    // The end of a window is exclusive.
    expect(await ids('dateBefore=2026-09-14T15:00:00Z')).toHaveLength(1);
    expect(await ids('limit=1&offset=1')).toHaveLength(1);
  });

  it('lists no archived row, and still answers one by its id', async () => {
    const { secret } = await issue();
    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    const gone = await makeTransaction({ accountId: account.id, amountCents: -500n });
    await prisma.transaction.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });

    const list = await app.inject({
      method: 'GET',
      url: '/api/read/transactions',
      headers: bearer(secret),
    });
    expect(list.json<ReadList>().total).toBe(0);

    const one = await app.inject({
      method: 'GET',
      url: `/api/read/transactions/${gone.id}`,
      headers: bearer(secret),
    });
    expect(one.statusCode).toBe(200);
    const { transaction } = one.json<{ transaction: ReadTransaction }>();
    expect(transaction.id).toBe(gone.id);
    expect(transaction.archivedAt).not.toBeNull();
  });

  it('answers 404 for an id that is no transaction, and 400 for a query it cannot read', async () => {
    const { secret } = await issue();
    const missing = await app.inject({
      method: 'GET',
      url: '/api/read/transactions/00000000-0000-4000-8000-000000000000',
      headers: bearer(secret),
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('not_found');

    for (const query of ['limit=101', 'sign=sideways', 'accountId=nope']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/read/transactions?${query}`,
        headers: bearer(secret),
      });
      expect(response.statusCode, query).toBe(400);
      expect(errorOf(response).code).toBe('invalid_request');
    }
  });

  it('refuses a session cookie here too', async () => {
    for (const url of [
      '/api/read/transactions',
      '/api/read/transactions/00000000-0000-4000-8000-000000000000',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(401);
      expect(errorOf(response).code).toBe('bearer_required');
    }
  });
});

describe('what a token cannot reach', () => {
  it('opens nothing guarded by a session', async () => {
    const { secret } = await issue();

    for (const [method, url] of [
      ['GET', '/api/budget'],
      ['GET', '/api/overview'],
      ['GET', '/api/transactions'],
      ['GET', '/api/auth/me'],
      ['GET', '/api/api-tokens'],
      ['POST', '/api/delegations'],
      ['POST', '/api/budget/delegate'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: bearer(secret),
        ...(method === 'POST' ? { payload: { name: 'Grocery' } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await prisma.delegation.count()).toBe(0);
  });
});

describe('a token that is not accepted', () => {
  async function knock(secret: string): Promise<{ status: number; body: string; auth: unknown }> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/read/budget',
      headers: bearer(secret),
    });
    return {
      status: response.statusCode,
      body: response.body,
      auth: response.headers['www-authenticate'],
    };
  }

  it('answers identically whether it is unknown, revoked, or an archived account’s', async () => {
    const unknown = await knock(`${API_TOKEN_PREFIX}nobody-ever-issued-this`);
    expect(unknown.status).toBe(401);
    expect(JSON.parse(unknown.body)).toEqual({
      error: { code: 'invalid_token', message: 'This token is not accepted.' },
    });

    const { token, secret } = await issue();
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${token.id}/revoke`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<{ token: TokenPayload }>().token.revokedAt).not.toBeNull();
    expect(await knock(secret)).toEqual(unknown);

    const other = await makeUser('other');
    const theirs = await issueApiToken(prisma, other.id, 'Their laptop');
    expect((await knock(theirs.secret)).status).toBe(200);
    await prisma.user.update({ where: { id: other.id }, data: { archivedAt: new Date() } });
    expect(await knock(theirs.secret)).toEqual(unknown);

    // A wrong prefix never reaches the database at all, and answers the same.
    expect(await knock('evv_someone-elses-kind-of-key')).toEqual(unknown);
  });

  it('stays revoked, and the row stays: nothing is hard-deleted', async () => {
    const { token } = await issue();
    await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${token.id}/revoke`,
      headers: { cookie },
    });
    // A second revoke is the state asked for, not an error.
    const again = await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${token.id}/revoke`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    const [row] = list.json<{ tokens: TokenPayload[] }>().tokens;
    expect(row?.revokedAt).not.toBeNull();
    expect(await prisma.apiToken.count()).toBe(1);

    const events = await app.inject({
      method: 'GET',
      url: '/api/auth-events',
      headers: { cookie },
    });
    expect(
      events.json<{ events: { kind: string }[] }>().events.map((event) => event.kind),
    ).toContain('api_token_revoked');
  });
});

describe('whose tokens these are', () => {
  it('lists and revokes your own only, and a token that is not yours does not exist', async () => {
    const other = await makeUser('other');
    const theirs = await issueApiToken(prisma, other.id, 'Their laptop');
    await issue('Mine');

    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    expect(list.json<{ tokens: TokenPayload[] }>().tokens.map((token) => token.name)).toEqual([
      'Mine',
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${theirs.token.id}/revoke`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);

    // And it still works for them.
    const knock = await app.inject({
      method: 'GET',
      url: '/api/read/overview',
      headers: bearer(theirs.secret),
    });
    expect(knock.statusCode).toBe(200);
  });

  it('lists live tokens first, newest first, then the revoked', async () => {
    const first = await issue('First');
    const second = await issue('Second');
    const third = await issue('Third');
    await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${second.token.id}/revoke`,
      headers: { cookie },
    });

    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    expect(list.json<{ tokens: TokenPayload[] }>().tokens.map((token) => token.id)).toEqual([
      third.token.id,
      first.token.id,
      second.token.id,
    ]);
  });
});
