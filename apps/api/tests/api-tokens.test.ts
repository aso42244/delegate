import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { API_TOKEN_PREFIX, digestOf, issueApiToken } from '../src/domain/api-tokens.js';
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
    for (const url of ['/api/read/budget', '/api/read/overview']) {
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
