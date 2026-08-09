import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { resetDatabase } from './helpers.js';
import { errorOf, sessionCookie, userOf } from './http.js';

/**
 * Authentication, sessions and user management, driven through the real HTTP
 * stack via `app.inject()`.
 *
 * These assert behaviour a mistake in which is a security hole rather than a
 * bug: session fixation, user enumeration, Super Admin immunity, and the
 * temporary-password lockout.
 */

let app: FastifyInstance;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      // Fastify would otherwise log a line per injected request.
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
});

/** Creates the first Super Admin through the setup route and returns its cookie. */
async function setUpOwner(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  expect(response.statusCode).toBe(201);
  return sessionCookie(response.headers);
}

async function loginAs(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response.headers);
}

describe('first-run setup', () => {
  it('reports that setup is needed on an empty database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    expect(response.json()).toEqual({ needsSetup: true });
  });

  it('makes the first account a Super Admin that need not change its password', async () => {
    await setUpOwner();

    const user = await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } });
    expect(user.role).toBe('super_admin');
    expect(user.mustChangePassword).toBe(false);
  });

  it('signs the new Super Admin in immediately', async () => {
    const cookie = await setUpOwner();

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: OWNER.username, role: 'super_admin' } });
  });

  it('refuses a second setup once an account exists', async () => {
    await setUpOwner();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'intruder', password: 'correct-horse-battery' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('setup_already_complete');
    expect(await prisma.user.count()).toBe(1);
  });

  it('refuses setup with a password below the minimum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'owner', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('password_too_short');
    expect(await prisma.user.count()).toBe(0);
  });

  it('stores usernames lower-cased so case cannot create a second account', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: '  OWNER  ', password: OWNER.password },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'owner' } });
    expect(user.username).toBe('owner');
  });
});

describe('login', () => {
  beforeEach(setUpOwner);

  it('accepts correct credentials and records the login time', async () => {
    await loginAs(OWNER.username, OWNER.password);

    const user = await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } });
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('matches the username case-insensitively', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'OWNER', password: OWNER.password },
    });
    expect(response.statusCode).toBe(200);
  });

  it('gives an unknown user and a wrong password the identical response', async () => {
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: OWNER.password },
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: OWNER.username, password: 'wrong-password-entirely' },
    });

    // Any difference here enumerates valid usernames.
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.json()).toEqual(wrongPassword.json());
  });

  it('issues a new session id on login, so a pre-login cookie cannot be ridden', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
      ...(before.headers['set-cookie']
        ? { headers: { cookie: sessionCookie(before.headers) } }
        : {}),
    });

    expect(first.statusCode).toBe(200);
    expect(sessionCookie(first.headers)).not.toBe(before.headers['set-cookie']);
  });

  it('refuses an archived account without revealing that it is archived', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } });
    await prisma.user.update({ where: { id: owner.id }, data: { archivedAt: new Date() } });

    const archived = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: OWNER.password },
    });

    expect(archived.statusCode).toBe(401);
    expect(archived.json()).toEqual(unknown.json());
  });

  it('sets an HttpOnly, SameSite=Lax cookie, and not Secure while on plain http', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const raw = response.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw[0]! : String(raw);

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Secure arrives with TLS in Phase 3; setting it now would break login
    // over http on the LAN.
    expect(cookie).not.toMatch(/Secure/i);
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await setUpOwner();
    // Setup signs the owner in, which is correct but leaves a row behind. These
    // tests count session rows, so clear it and let each one create its own.
    await prisma.session.deleteMany();
  });

  it('rejects a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('unauthenticated');
  });

  it('persists the session in Postgres rather than in memory', async () => {
    await loginAs(OWNER.username, OWNER.password);

    const stored = await prisma.session.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('writes no session row for an unauthenticated visitor', async () => {
    await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    expect(await prisma.session.count()).toBe(0);
  });

  it('destroys the stored session on logout, so a copied cookie is useless', async () => {
    const cookie = await loginAs(OWNER.username, OWNER.password);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(await prisma.session.count()).toBe(0);

    const replay = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects a live session whose user has since been archived', async () => {
    const cookie = await loginAs(OWNER.username, OWNER.password);
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } });

    await prisma.user.update({ where: { id: owner.id }, data: { archivedAt: new Date() } });

    // The user is re-read on every request precisely so this takes effect at
    // once rather than whenever the cookie happens to expire.
    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a session whose stored row has expired', async () => {
    const cookie = await loginAs(OWNER.username, OWNER.password);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
    // Expired rows are swept on read, not left to accumulate.
    expect(await prisma.session.count()).toBe(0);
  });
});

describe('temporary passwords', () => {
  let ownerCookie: string;

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { username: 'partner', temporaryPassword: 'temporary-pass-word', role: 'user' },
    });
  });

  it('locks a new account out of everything until the password is changed', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const response = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('password_change_required');
  });

  it('still allows reading its own identity, so the change screen can render', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(userOf(response).mustChangePassword).toBe(true);
  });

  it('clears the flag once a new password is set', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'temporary-pass-word', newPassword: 'a-longer-new-password' },
    });
    expect(change.statusCode).toBe(204);

    const fresh = await loginAs('partner', 'a-longer-new-password');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: fresh } });
    expect(userOf(me).mustChangePassword).toBe(false);
  });

  it('refuses a change when the current password is wrong', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'not-the-password', newPassword: 'a-longer-new-password' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('incorrect_password');
  });

  it('refuses reusing the same password', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'temporary-pass-word', newPassword: 'temporary-pass-word' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('password_unchanged');
  });

  it('rotates the session id when the password changes', async () => {
    const cookie = await loginAs('partner', 'temporary-pass-word');

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'temporary-pass-word', newPassword: 'a-longer-new-password' },
    });

    expect(sessionCookie(change.headers)).not.toBe(cookie);
  });
});

/**
 * The rate limit, proved against an app configured with a low one.
 *
 * Until this existed, nothing throttled password guessing beyond the ~50 ms an
 * argon2id hash costs — roughly twenty attempts a second, forever. ADR 007 named
 * that as the single strongest reason this application must not leave the LAN.
 */
describe('rate limiting the credential routes', () => {
  let limited: FastifyInstance;

  beforeAll(async () => {
    limited = await buildApp(
      loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
        SESSION_COOKIE_SECURE: 'false',
        AUTH_RATE_LIMIT_MAX: '3',
        AUTH_RATE_LIMIT_WINDOW: '5 minutes',
      }),
    );
    await limited.ready();
  });

  afterAll(async () => {
    await limited.close();
  });

  it('stops a guessing loop after the configured number of attempts', async () => {
    await limited.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: OWNER.username, password: 'not-the-password' },
      });
      statuses.push(response.statusCode);
    }

    // The first few are ordinary rejections; the rest never reach the hash.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  /**
   * The refusal must not become an oracle. A 429 that named the account, or
   * differed for a real username, would hand back exactly what the uniform
   * failure response is designed to withhold.
   */
  it('says nothing about whether the username exists', async () => {
    const responses: string[] = [];
    for (const username of ['definitely-not-a-user', OWNER.username]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await limited.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username, password: 'wrong' },
        });
        if (response.statusCode === 429) responses.push(response.body);
      }
    }

    expect(responses.length).toBeGreaterThan(0);
    expect(new Set(responses).size).toBe(1);
    expect(responses[0]).not.toContain(OWNER.username);
  });
});

describe('response headers', () => {
  it('refuses to be framed, and confines what the page may load', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });

    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  /**
   * HSTS is meaningless over plain http and actively harmful early: a browser
   * that has seen it refuses http afterwards, which would lock the household
   * out of their own LAN deployment. It arrives with TLS.
   */
  it('does not send HSTS while there is no TLS', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
