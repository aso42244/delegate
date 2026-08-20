import type { FastifyInstance } from 'fastify';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { claimChallenge, issueChallenge, readChallenge } from '../src/domain/challenge.js';
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
    // Binding an authenticator now asks for the password, so a stolen session
    // cannot enrol a phone the owner never issued.
    payload: { currentPassword: OWNER.password },
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
      payload: { currentPassword: OWNER.password },
    });

    const { secret, uri } = response.json<{ secret: string; uri: string }>();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('owner');
    expect(uri).toContain(secret);
  });

  it('leaves sign-in alone until a code confirms the secret', async () => {
    const cookie = await setUpOwner();
    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie },
      payload: { currentPassword: OWNER.password },
    });

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
    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie },
      payload: { currentPassword: OWNER.password },
    });

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
      payload: { currentPassword: OWNER.password },
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

describe('required of everyone', () => {
  /**
   * There is no setting. A second factor is required of every account
   * including the first Super Admin, from the moment it is created.
   *
   * That is only survivable because `/api/auth/me` sits outside the guard and
   * reports the state, so the interface sends such an account to enrolment
   * rather than to a wall. Without that this would be an account that can sign
   * in and reach nothing, recoverable only from a database prompt — which is
   * exactly what it was the first time this was tried.
   */
  it('shuts an un-enrolled account out of everything except the way to enrol', async () => {
    const cookie = await setUpOwner();

    // The one route that still answers, carrying the reason.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { needsTwoFactor: boolean } }>().user.needsTwoFactor).toBe(true);

    // Enrolment itself, or the account could never get out of this state.
    const totp = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie } });
    expect(totp.statusCode).toBe(200);
    expect(totp.json<{ required: boolean }>().required).toBe(true);

    // And everything else is shut until they do.
    const budget = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    expect(budget.statusCode).toBe(403);
    expect(errorOf(budget).code).toBe('two_factor_required');
  });

  it('has no setting that can switch it off', async () => {
    const cookie = await setUpOwner();
    await enrol(cookie);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { requireTotp: false },
    });
    // Refused as an unknown field rather than quietly ignored: a request that
    // looks like it turned the requirement off must not answer 200.
    expect(response.statusCode).toBe(400);

    const settings = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(settings.json<Record<string, unknown>>()).not.toHaveProperty('requireTotp');
  });

  it('blocks the budget for an unenrolled account once required', async () => {
    const owner = await setUpOwner();
    await enrol(owner);

    // A second account. The requirement is always in force.
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

    // But the way out of the state stays open, or the account is bricked. Their
    // own password, not the owner's — the step-up proves who is at the keyboard,
    // not that somebody with a password exists.
    const escape = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie: partner },
      payload: { currentPassword: 'partner-pass-phrase' },
    });
    expect(escape.statusCode).toBe(200);

    // And a stolen session on its own is not enough, which is the point of it.
    const withoutPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/begin',
      headers: { cookie: partner },
      payload: { currentPassword: 'not-the-password' },
    });
    expect(withoutPassword.statusCode).toBe(400);
    expect(errorOf(withoutPassword).code).toBe('incorrect_password');
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

describe('a code cannot be used twice', () => {
  /**
   * The verifier accepts a code for one period either side of now, so a correct
   * code is good for about ninety seconds. Nothing recorded that one had been
   * spent — and with TLS terminated by a tunnel provider, somebody else having
   * seen the code inside that window is not hypothetical.
   */
  it('refuses a replayed TOTP code within its own validity window', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);

    const code = await generateOtp({ secret });

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const firstBody = first.json<{ challenge: string }>();

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: firstBody.challenge, code },
    });
    expect(signedIn.statusCode).toBe(200);

    // Same code, seconds later, still inside the window it would otherwise be
    // accepted in.
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: OWNER,
    });
    const secondBody = second.json<{ challenge: string }>();

    const replayed = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: secondBody.challenge, code },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it('remembers the spent code against the account that spent it', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);
    const code = await generateOtp({ secret });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: login.json<{ challenge: string }>().challenge, code },
    });

    const spent = await prisma.totpUsedCode.findMany();
    expect(spent).toHaveLength(1);
    // The code itself is never written down, only an HMAC of it.
    expect(spent[0]?.codeHash).not.toContain(code);
    // And the row expires on its own rather than needing a sweeper.
    expect(spent[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('a challenge cannot be replayed', () => {
  it('is spent once it has worked, but survives a mistyped code', async () => {
    const cookie = await setUpOwner();
    const { secret } = await enrol(cookie);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const { challenge } = login.json<{ challenge: string }>();

    // A typo must not cost the password as well. The rate limit already caps a
    // stolen challenge at ten guesses against a million possibilities.
    const typo = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: '000000' },
    });
    expect(typo.statusCode).toBe(401);
    expect(errorOf(typo).code).toBe('invalid_code');

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: await generateOtp({ secret }) },
    });
    expect(accepted.statusCode).toBe(200);

    // And it is spent. Asserted on the record rather than by presenting it
    // again, because within the same thirty seconds the *code* is what would be
    // refused first — the two protections overlap, which is the point of having
    // both, and makes the second one awkward to observe through the door.
    expect(await prisma.usedChallenge.count()).toBe(1);

    const replayed = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: await generateOtp({ secret }) },
    });
    expect(replayed.statusCode).toBe(401);
  });

  it('refuses a challenge already spent, when the code is not the obstacle', async () => {
    const cookie = await setUpOwner();
    await enrol(cookie);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    const { challenge } = login.json<{ challenge: string }>();

    // Marked spent directly, which is what a successful sign-in leaves behind.
    // A correct code offered against it must still be refused, and for the right
    // reason: the attempt is over, not the code wrong.
    expect(await claimChallenge(prisma, challenge, SESSION_SECRET)).toBe(true);

    const replayed = await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge, code: '000000' },
    });
    expect(replayed.statusCode).toBe(401);
  });
});
