import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generate as generateOtp } from 'otplib';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The findings from the OWASP review that are small enough to be proved outright.
 */

let app: FastifyInstance;
let owner: string;
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

let ownerTotpSecret: string;

beforeEach(async () => {
  await resetDatabase();
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  owner = sessionCookie(response.headers);

  /*
   * The owner enrols for real, through the API, keeping the secret.
   *
   * The shortcut used elsewhere in this suite writes a placeholder that no code
   * can be generated from — fine where nothing signs in twice, and useless
   * here: one test below opens a *second* session for this account, and every
   * sign-in demands a second factor once one is confirmed.
   */
  const begun = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/begin',
    headers: { cookie: owner },
    payload: { currentPassword: OWNER.password },
  });
  ownerTotpSecret = begun.json<{ secret: string }>().secret;

  await app.inject({
    method: 'POST',
    url: '/api/auth/totp/confirm',
    headers: { cookie: owner },
    payload: { code: await generateOtp({ secret: ownerTotpSecret }) },
  });
});

/** Signs in as the owner all the way through the second factor. */
async function signInAsOwner(password: string): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { ...OWNER, password },
  });
  const { challenge } = login.json<{ challenge: string }>();

  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/second-factor',
    payload: { challenge, code: await generateOtp({ secret: ownerTotpSecret }) },
  });
  return sessionCookie(second.headers);
}

/** A second account with a session, at the ordinary `user` role. */
async function partner(): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: owner },
    payload: { username: 'partner', temporaryPassword: 'temporary-pass-phrase', role: 'user' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'partner', password: 'temporary-pass-phrase' },
  });
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { cookie: sessionCookie(login.headers) },
    payload: { currentPassword: 'temporary-pass-phrase', newPassword: 'partner-pass-phrase' },
  });
  await markTwoFactorEnrolled();
  return sessionCookie(changed.headers);
}

describe('changing your own password', () => {
  it('throws every other session out', async () => {
    // Two sessions for one account, the way a phone and a laptop are.
    const laptop = await signInAsOwner(OWNER.password);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: laptop } }))
        .statusCode,
    ).toBe(200);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: owner },
      payload: { currentPassword: OWNER.password, newPassword: 'a-brand-new-passphrase' },
    });
    expect(changed.statusCode).toBe(204);

    // The commonest reason to change a password is thinking somebody else has
    // it. The session that matters is theirs, and it used to survive.
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: laptop } }))
        .statusCode,
    ).toBe(401);

    // And the person who did it stays signed in.
    const stillHere = sessionCookie(changed.headers);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: stillHere } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('household settings', () => {
  it('can be read by anyone but changed only by an administrator', async () => {
    const user = await partner();

    expect(
      (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: user } }))
        .statusCode,
    ).toBe(200);

    // `remoteOverTorEnabled` decides whether the budget answers anything from
    // outside the house, and `payCadence` changes what every suggestion on the
    // Utilities page reads. An ordinary account able to set either would make
    // every other protection worth what the weakest session is worth.
    for (const payload of [{ remoteOverTorEnabled: true }, { payCadence: 'weekly' }]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: user },
        payload,
      });
      expect(refused.statusCode, JSON.stringify(payload)).toBe(403);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe(
        'settings_management_required',
      );
    }

    // Unchanged by the attempt.
    expect(
      (await prisma.budgetSettings.findUniqueOrThrow({ where: { id: 1 } })).remoteOverTorEnabled,
    ).toBe(false);

    const allowed = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: owner },
      payload: { remoteOverTorEnabled: true },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('response headers', () => {
  it('keep authenticated JSON out of caches', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: owner },
    });
    // A shared browser serving a previous reader's balances from disk after they
    // signed out is the failure this prevents.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('deny the device APIs nothing here uses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: owner },
    });
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['permissions-policy']).toContain('geolocation=()');
  });
});
