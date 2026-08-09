import type { FastifyInstance } from 'fastify';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { issueChallenge, readChallenge } from '../src/domain/challenge.js';
import { resetDatabase } from './helpers.js';
import { errorOf, sessionCookie, userOf } from './http.js';

/**
 * Two-factor authentication end to end: enrolment, the two-step sign-in, and
 * the ways it can be got wrong.
 *
 * The assertions that matter most are the negative ones. A second factor that
 * can be skipped is worse than none, because the household would believe they
 * had one.
 */

const SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
const OWNER = { username: 'owner', password: 'correct-horse-battery' };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET,
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
});

async function setUpOwner(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  expect(response.statusCode).toBe(201);
  return sessionCookie(response.headers);
}

interface Enrolment {
  readonly secret: string;
  readonly recoveryCodes: string[];
}

/** Runs a full enrolment and returns what the user would have kept. */
async function enrol(cookie: string): Promise<Enrolment> {
  const begun = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/begin',
    headers: { cookie },
  });
  expect(begun.statusCode).toBe(200);
  const { secret } = begun.json<{ secret: string; uri: string }>();

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/confirm',
    headers: { cookie },
    payload: { code: await generateOtp({ secret }) },
  });
  expect(confirmed.statusCode).toBe(200);
  const { recoveryCodes } = confirmed.json<{ recoveryCodes: string[] }>();

  return { secret, recoveryCodes };
}

describe('enrolment', () => {
  it('offers a secret and a scannable URI naming the account', async () => {
    const cookie = await setUpOwner();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie },
    });

    const { secret, uri } = response.json<{ secret: string; uri: string }>();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('owner');
    expect(uri).toContain(secret);
  });

  it('leaves sign-in alone until a code confirms the secret', async () => {
    const cookie = await setUpOwner();
    await app.inject({ method: 'POST', url: '/api/auth/totp/begin', headers: { cookie } });

    // Someone who closed the tab after scanning nothing must still get in.
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });

    expect(response.statusCode).toBe(200);
    expect(userOf(response).username).toBe('owner');
  });

  it('refuses to confirm on a wrong code', async () => {
    const cookie = await setUpOwner();
    await app.inject({ method: 'POST', url: '/api/auth/totp/begin', headers: { cookie } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirm',
      headers: { cookie },
      payload: { code: '000000' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('totp_code_invalid');

    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie } });
    expect(status.json<{ enrolled: boolean }>().enrolled).toBe(false);
  });

  it('issues ten recovery codes and reports them as unspent', async () => {
    const cookie = await setUpOwner();
    const { recoveryCodes } = await enrol(cookie);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie } });
    expect(status.json<{ enrolled: boolean; recoveryCodesRemaining: number }>()).toMatchObject({
      enrolled: true,
      recoveryCodesRemaining: 10,
    });
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const cookie = await setUpOwner();
    const { secret, recoveryCodes } = await enrol(cookie);

    const stored = await prisma.user.findFirstOrThrow({
      where: { username: 'owner' },
      select: { totpSecretEncrypted: true },
    });

    // The nightly pg_dump is the copy most likely to leave the device.
    expect(stored.totpSecretEncrypted).not.toContain(secret);

    const codes = await prisma.recoveryCode.findMany({ select: { codeHash: true } });
    for (const { codeHash } of codes) {
      expect(codeHash).toMatch(/^\$argon2id\$/);
      expect(recoveryCodes).not.toContain(codeHash);
    }
  });

  it('will not enrol twice over an existing second factor', async () => {
    const cookie = await setUpOwner();
    await enrol(cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('totp_already_enrolled');
  });
});

describe('signing in with a second factor', () => {
  it('withholds the session until the code is given', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    expect(login.statusCode).toBe(200);
    const body = login.json<{
      secondFactorRequired?: boolean;
      challenge?: string;
      user?: unknown;
    }>();
    expect(body.secondFactorRequired).toBe(true);
    expect(body.user).toBeUndefined();

    // No session cookie is issued at all. A half-finished sign-in has nothing
    // to ride on, so there is nothing for the second factor to be bypassed by.
    expect(login.headers['set-cookie']).toBeUndefined();

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: body.challenge, code: await generateOtp({ secret }) },
    });
    expect(second.statusCode).toBe(200);
    expect(userOf(second).username).toBe('owner');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookie(second.headers) },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a wrong code', async () => {
    const cookie = await setUpOwner();
    await enrol(cookie);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const { challenge } = login.json<{ challenge: string }>();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(errorOf(response).code).toBe('invalid_code');
  });

  it('refuses a challenge this server did not sign', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'owner' } });

    const forged = issueChallenge(user.id, 'a-different-secret-at-least-32-characters');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: forged, code: await generateOtp({ secret }) },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('challenge_invalid');
  });

  it('refuses an expired challenge', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'owner' } });

    const stale = issueChallenge(user.id, SESSION_SECRET, new Date(Date.now() - 10 * 60 * 1000));

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: stale, code: await generateOtp({ secret }) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('accepts a recovery code, and spends it', async () => {
    const cookie = await setUpOwner();
    const { recoveryCodes } = await enrol(cookie);
    const [code] = recoveryCodes;

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: login.json<{ challenge: string }>().challenge, code },
    });
    expect(first.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/totp',
      headers: { cookie: sessionCookie(first.headers) },
    });
    expect(status.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9);

    // Replay: the same slip of paper must not work twice.
    const again = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: again.json<{ challenge: string }>().challenge, code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('refuses an account archived since the password was accepted', async () => {
    const owner = await setUpOwner();
    const { secret } = await enrol(owner);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const { challenge } = login.json<{ challenge: string }>();

    await prisma.user.updateMany({
      where: { username: 'owner' },
      data: { archivedAt: new Date() },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: await generateOtp({ secret }) },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('turning it off', () => {
  it('requires the current password', async () => {
    const cookie = await setUpOwner();
    await enrol(cookie);

    const refused = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/disable',
      headers: { cookie },
      payload: { currentPassword: 'not-the-password' },
    });
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused).code).toBe('password_incorrect');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/disable',
      headers: { cookie },
      payload: { currentPassword: OWNER.password },
    });
    expect(accepted.statusCode).toBe(200);

    // And the recovery codes go with it — they are a way in on their own.
    expect(await prisma.recoveryCode.count()).toBe(0);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    expect(login.json<{ secondFactorRequired?: boolean }>().secondFactorRequired).toBeUndefined();
  });
});

describe('requiring it of everyone', () => {
  it('will not be turned on while an account would be locked out', async () => {
    const cookie = await setUpOwner();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { requireTotp: true },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('totp_not_universal');
  });

  it('blocks the budget for an unenrolled account once required', async () => {
    const owner = await setUpOwner();
    await enrol(owner);

    const enabled = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: owner },
      payload: { requireTotp: true },
    });
    expect(enabled.statusCode).toBe(200);

    // A second account, created after the requirement was in force.
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: owner },
      payload: { username: 'partner', temporaryPassword: 'temporary-pass-phrase', role: 'user' },
    });
    expect(created.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'partner', password: 'temporary-pass-phrase' },
    });
    let partner = sessionCookie(login.headers);

    // Past the temporary-password gate first, so what blocks them next is
    // unambiguously the second-factor requirement.
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: partner },
      payload: { currentPassword: 'temporary-pass-phrase', newPassword: 'partner-pass-phrase' },
    });
    expect(changed.statusCode).toBe(204);
    partner = sessionCookie(changed.headers);

    const blocked = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie: partner },
    });
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked).code).toBe('two_factor_required');

    // But the way out of the state stays open, or the account is bricked.
    const escape = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie: partner },
    });
    expect(escape.statusCode).toBe(200);
  });
});

describe('the challenge token itself', () => {
  it('round-trips the account it was issued for', () => {
    expect(readChallenge(issueChallenge('user-1', SESSION_SECRET), SESSION_SECRET)).toBe('user-1');
  });

  it('rejects a tampered payload', () => {
    const token = issueChallenge('user-1', SESSION_SECRET);
    const forged = `${Buffer.from(
      JSON.stringify({ userId: 'user-2', exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url')}.${token.split('.')[1]}`;

    expect(() => readChallenge(forged, SESSION_SECRET)).toThrow();
  });

  it('rejects nonsense without leaking which part was wrong', () => {
    for (const bad of ['', 'a', 'a.b', '...', 'not-base64.signature']) {
      expect(() => readChallenge(bad, SESSION_SECRET)).toThrowError(/expired/);
    }
  });
});
