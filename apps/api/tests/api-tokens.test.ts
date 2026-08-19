import type { FastifyInstance, HTTPMethods } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { TOKEN_READ_ROUTES, TOKEN_WRITE_ROUTES } from '../src/plugins/api-token.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * API tokens — the credential the MCP server authenticates with.
 *
 * The assertions that matter here are the refusals. A token that reads the
 * budget is useful; a token that could quietly move money between delegations
 * because a model was talked into it is the thing this design exists to
 * prevent, and only a test proves the allowlist is doing its job.
 */

let app: FastifyInstance;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      AUTH_RATE_LIMIT_MAX: '100000',
      GLOBAL_RATE_LIMIT_MAX: '100000',
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
});

async function setUpOwner(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  expect(response.statusCode).toBe(201);
  return sessionCookie(response.headers);
}

interface CreatedToken {
  readonly secret: string;
  readonly id: string;
}

async function issueToken(
  cookie: string,
  scope: 'read' | 'read_write',
  expiresInDays: number | null = 90,
): Promise<CreatedToken> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: { cookie },
    payload: { name: `${scope} token`, scope, expiresInDays },
  });
  expect(response.statusCode).toBe(201);

  const body = response.json<{ secret: string; token: { id: string } }>();
  return { secret: body.secret, id: body.token.id };
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

describe('issuing tokens', () => {
  it('returns the secret exactly once and never again', async () => {
    const cookie = await setUpOwner();
    const { secret, id } = await issueToken(cookie, 'read');

    expect(secret).toMatch(/^dlg_[0-9a-f]{16}_[A-Za-z0-9_-]+$/);

    const list = await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } });
    expect(list.statusCode).toBe(200);

    const body = list.json<{ tokens: { id: string }[] }>();
    expect(body.tokens).toHaveLength(1);
    // The whole response, not just the token object: the secret must not be
    // hiding under some other key.
    expect(list.payload).not.toContain(secret);
    expect(body.tokens[0]!.id).toBe(id);
  });

  it('stores no part of the secret in the database', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read');
    const parts = secret.split('_');

    const row = await prisma.apiToken.findFirstOrThrow();
    // The selector is public by design; the secret half is not, in any form.
    expect(row.selector).toBe(parts[1]);
    expect(row.secretHash).not.toContain(parts[2]);
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a non-administrator', async () => {
    const cookie = await setUpOwner();
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'helper', temporaryPassword: 'temporary-password-1', role: 'user' },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'helper', password: 'temporary-password-1' },
    });
    const helperCookie = sessionCookie(login.headers);

    const response = await app.inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: { cookie: helperCookie },
      payload: { name: 'sneaky', scope: 'read_write', expiresInDays: null },
    });
    // Blocked before the capability check by the temporary password, which is
    // the correct order — either way it never reaches the domain.
    expect(response.statusCode).toBe(403);
    expect(await prisma.apiToken.count()).toBe(0);
  });
});

describe('authenticating with a token', () => {
  it('reads the budget with no cookie at all', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read');

    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a garbled, unknown or malformed token with the same answer', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read');

    const wrongSecret = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    for (const presented of [
      'nonsense',
      'dlg_short_secret',
      'dlg_0123456789abcdef_wrong-secret-entirely',
      wrongSecret,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/budget',
        headers: bearer(presented),
      });
      expect(response.statusCode, presented).toBe(401);
      expect(errorOf(response).code).toBe('invalid_token');
    }
  });

  it('stops working the moment it is revoked', async () => {
    const cookie = await setUpOwner();
    const { secret, id } = await issueToken(cookie, 'read');

    const before = await app.inject({ method: 'GET', url: '/api/budget', headers: bearer(secret) });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/api-tokens/${id}/revoke`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/budget', headers: bearer(secret) });
    expect(after.statusCode).toBe(401);
  });

  it('stops working once it has expired', async () => {
    const cookie = await setUpOwner();
    const { secret, id } = await issueToken(cookie, 'read', 1);

    await prisma.apiToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(401);
  });

  it('dies with the account that made it', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read');

    await prisma.user.updateMany({ data: { archivedAt: new Date() } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(401);
  });

  it('records that it was used', async () => {
    const cookie = await setUpOwner();
    const { secret, id } = await issueToken(cookie, 'read');

    expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();
    await app.inject({ method: 'GET', url: '/api/budget', headers: bearer(secret) });
    expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
  });
});

describe('the scope allowlist', () => {
  it('refuses every write to a read-only token', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read');

    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    const transaction = await makeTransaction({ accountId: account.id, amountCents: -2_500n });
    const delegation = await makeDelegation({ name: 'Groceries' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: bearer(secret),
      payload: { delegationId: delegation.id },
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('token_scope');
  });

  it('lets a write token categorize', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read_write');

    const account = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    const transaction = await makeTransaction({ accountId: account.id, amountCents: -2_500n });
    const delegation = await makeDelegation({ name: 'Groceries' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/transactions/${transaction.id}/categorize`,
      headers: bearer(secret),
      payload: { delegationId: delegation.id },
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * The heart of the design. Each of these is reachable by the household from
   * the UI and must never be reachable by a program holding a token, whatever
   * the scope says.
   */
  it.each([
    ['POST', '/api/budget/delegate', {}],
    ['POST', '/api/budget/transfer', {}],
    ['POST', '/api/budget/reconcile', {}],
    ['POST', '/api/rules/apply', {}],
    ['PATCH', '/api/settings', {}],
    ['POST', '/api/users', {}],
    ['POST', '/api/sync', {}],
    ['POST', '/api/accounts', {}],
    ['PUT', '/api/bitcoin/node', {}],
    ['POST', '/api/api-tokens', {}],
  ])('refuses %s %s even with the write scope', async (method, url, payload) => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read_write');

    const response = await app.inject({
      method: method as 'POST',
      url,
      headers: bearer(secret),
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('token_scope');
  });

  it.each([
    ['/api/settings', 'carries the onion address'],
    ['/api/users', 'is the household'],
  ])('refuses to read %s, which %s', async (url) => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read_write');

    const response = await app.inject({ method: 'GET', url, headers: bearer(secret) });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a route that does not exist rather than falling through', async () => {
    const cookie = await setUpOwner();
    const { secret } = await issueToken(cookie, 'read_write');

    const response = await app.inject({
      method: 'POST',
      url: '/api/does-not-exist',
      headers: bearer(secret),
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * A rename in a routes file would otherwise silently drop an entry from the
   * allowlist. That fails closed, which is safe — and invisible, which is not:
   * the tool that used it starts answering 403 with no clue why.
   */
  it('names only routes that actually exist', () => {
    for (const entry of [...TOKEN_READ_ROUTES, ...TOKEN_WRITE_ROUTES]) {
      const [method, url] = entry.split(' ') as [HTTPMethods, string];
      expect(app.hasRoute({ method, url }), entry).toBe(true);
    }
  });
});
