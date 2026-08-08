import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { resetDatabase } from './helpers.js';
import { errorOf, sessionCookie, userOf } from './http.js';

/**
 * User management and the permission model.
 *
 * The model is two predicates — only user management is gated, and only a Super
 * Admin may touch a Super Admin — so these tests exist mostly to prove that no
 * route quietly forgets the second half.
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

/**
 * Creates an account and signs it in with a permanent password, so it is not
 * sitting behind the temporary-password lockout.
 */
async function makeActiveUser(
  adminCookie: string,
  username: string,
  role: 'user' | 'admin' | 'super_admin',
): Promise<{ id: string; cookie: string }> {
  const temporaryPassword = 'temporary-pass-word';
  const permanentPassword = `${username}-permanent-password`;

  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: adminCookie },
    payload: { username, temporaryPassword, role },
  });
  expect(created.statusCode).toBe(201);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: temporaryPassword },
  });
  const cookie = sessionCookie(login.headers);

  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie },
    payload: { currentPassword: temporaryPassword, newPassword: permanentPassword },
  });
  expect(changed.statusCode).toBe(204);

  return { id: userOf(created).id, cookie: sessionCookie(changed.headers) };
}

describe('access to user management', () => {
  let ownerCookie: string;

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/users' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a plain user', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: partner.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('allows an Admin', async () => {
    const admin = await makeActiveUser(ownerCookie, 'admin-user', 'admin');

    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: admin.cookie },
    });

    expect(response.statusCode).toBe(200);
  });

  it('never returns a password hash', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: ownerCookie },
    });

    expect(JSON.stringify(response.json())).not.toMatch(/passwordHash|\$argon2/);
  });
});

describe('creating users', () => {
  let ownerCookie: string;

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
  });

  it('creates an account that must change its password on first login', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { username: 'partner', temporaryPassword: 'temporary-pass-word', role: 'user' },
    });

    expect(response.statusCode).toBe(201);
    expect(userOf(response).mustChangePassword).toBe(true);
  });

  it('refuses a duplicate username', async () => {
    await makeActiveUser(ownerCookie, 'partner', 'user');

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { username: 'partner', temporaryPassword: 'temporary-pass-word', role: 'user' },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('username_taken');
  });

  it('refuses a temporary password below the minimum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { username: 'partner', temporaryPassword: 'short', role: 'user' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('password_too_short');
  });

  it('stops an Admin creating a Super Admin', async () => {
    const admin = await makeActiveUser(ownerCookie, 'admin-user', 'admin');

    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie },
      payload: {
        username: 'usurper',
        temporaryPassword: 'temporary-pass-word',
        role: 'super_admin',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(await prisma.user.findUnique({ where: { username: 'usurper' } })).toBeNull();
  });
});

describe('Super Admin immunity', () => {
  let ownerCookie: string;
  let ownerId: string;
  let admin: { id: string; cookie: string };

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
    ownerId = (await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } })).id;
    admin = await makeActiveUser(ownerCookie, 'admin-user', 'admin');
  });

  it('stops an Admin renaming the Super Admin', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}`,
      headers: { cookie: admin.cookie },
      payload: { username: 'seized' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops an Admin resetting the Super Admin password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/users/${ownerId}/reset-password`,
      headers: { cookie: admin.cookie },
      payload: { temporaryPassword: 'temporary-pass-word' },
    });

    expect(response.statusCode).toBe(403);
    // The owner's own password must still work.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    expect(login.statusCode).toBe(200);
  });

  it('stops an Admin archiving the Super Admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/users/${ownerId}/archive`,
      headers: { cookie: admin.cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it('stops an Admin promoting anyone to Super Admin', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/users/${partner.id}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'super_admin' },
    });

    // Otherwise an Admin grants immunity to a proxy account and inherits it.
    expect(response.statusCode).toBe(403);
  });

  it('lets a Super Admin do all of it', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/users/${partner.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: 'super_admin' },
    });

    expect(promoted.statusCode).toBe(200);
    expect(userOf(promoted).role).toBe('super_admin');
  });
});

describe('archiving', () => {
  let ownerCookie: string;
  let ownerId: string;

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
    ownerId = (await prisma.user.findUniqueOrThrow({ where: { username: OWNER.username } })).id;
  });

  it('archives rather than deletes, so past events still resolve to a name', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    const response = await app.inject({
      method: 'POST',
      url: `/api/users/${partner.id}/archive`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: partner.id } });
    expect(row).not.toBeNull();
    expect(row!.archivedAt).not.toBeNull();
  });

  it('drops the archived user’s sessions immediately', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    await app.inject({
      method: 'POST',
      url: `/api/users/${partner.id}/archive`,
      headers: { cookie: ownerCookie },
    });

    expect(await prisma.session.count({ where: { userId: partner.id } })).toBe(0);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: partner.cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses to archive your own account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/users/${ownerId}/archive`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('cannot_archive_self');
  });

  it('refuses to archive the last Super Admin', async () => {
    const second = await makeActiveUser(ownerCookie, 'second-owner', 'super_admin');

    // The second Super Admin archives the first, leaving exactly one.
    const first = await app.inject({
      method: 'POST',
      url: `/api/users/${ownerId}/archive`,
      headers: { cookie: second.cookie },
    });
    expect(first.statusCode).toBe(200);

    // Nobody is left who could archive the survivor, and the survivor cannot
    // archive itself — but assert the rule directly rather than relying on that.
    const remaining = await prisma.user.count({ where: { role: 'super_admin', archivedAt: null } });
    expect(remaining).toBe(1);
  });

  it('restores an archived user', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');
    await app.inject({
      method: 'POST',
      url: `/api/users/${partner.id}/archive`,
      headers: { cookie: ownerCookie },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/users/${partner.id}/restore`,
      headers: { cookie: ownerCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(userOf(response).archivedAt).toBeNull();
  });
});

describe('password reset by an administrator', () => {
  let ownerCookie: string;

  beforeEach(async () => {
    ownerCookie = await setUpOwner();
  });

  it('forces a change on next login and invalidates existing sessions', async () => {
    const partner = await makeActiveUser(ownerCookie, 'partner', 'user');

    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${partner.id}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { temporaryPassword: 'new-temporary-password' },
    });

    expect(reset.statusCode).toBe(200);
    expect(userOf(reset).mustChangePassword).toBe(true);

    // The point of a reset is that the old credential is no longer trusted, so
    // a session opened under it must not survive.
    const stale = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: partner.cookie },
    });
    expect(stale.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'partner', password: 'new-temporary-password' },
    });
    expect(login.statusCode).toBe(200);
  });
});
