import type { FastifyInstance } from 'fastify';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { pruneAuthEvents } from '../src/domain/auth-events.js';
import { previousTotpPeriod, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The record of what happened to credentials, and the rules about what it is
 * allowed to write down.
 *
 * The assertion that matters most is the negative one. This table exists to be
 * read by a person, and the login form has two fields — so a password typed into
 * the top one must never reach it. Everything else here is bookkeeping; that one
 * is the reason the `subject` column has a rule at all.
 */

const SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
const OWNER = { username: 'owner', password: 'correct-horse-battery' };

let app: FastifyInstance;
let ownerCookie: string;
let ownerTotpSecret: string;

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET,
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

  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  ownerCookie = sessionCookie(setup.headers);

  const begun = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/begin',
    headers: { cookie: ownerCookie },
    payload: { currentPassword: OWNER.password },
  });
  ownerTotpSecret = begun.json<{ secret: string }>().secret;

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/auth/totp/confirm',
    headers: { cookie: ownerCookie },
    payload: { code: await generateOtp({ secret: ownerTotpSecret, epoch: previousTotpPeriod() }) },
  });

  /*
   * Asserted, because failing here is invisible otherwise.
   *
   * The previous period's code is used so that a later sign-in still has an
   * unspent one — a TOTP code is spent when used (ADR 028). A run that crosses a
   * period boundary at the wrong moment can offer a code just outside the window
   * the server accepts, and enrolment silently does not happen. Every later test
   * then reads `/api/auth-events` as an un-enrolled account and gets a 403,
   * which surfaces as "expected 403 to be 200" in a helper thirty lines away
   * with nothing pointing at the cause. Seen once, on a loaded machine.
   */
  expect(confirmed.statusCode, confirmed.body).toBe(200);
});

interface EventView {
  readonly kind: string;
  readonly subject: string;
  readonly actor: string | null;
  readonly ip: string | null;
}

async function listEvents(cookie = ownerCookie): Promise<EventView[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/auth-events',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ events: EventView[] }>().events;
}

/** Signs in all the way through the second factor. */
async function signIn(): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
  const { challenge } = login.json<{ challenge: string }>();
  const second = await app.inject({
    method: 'POST',
    url: '/api/auth/second-factor',
    payload: { challenge, code: await generateOtp({ secret: ownerTotpSecret }) },
  });
  expect(second.statusCode).toBe(200);
  return sessionCookie(second.headers);
}

describe('what is recorded', () => {
  it('records the first account, the enrolment, and a completed sign-in', async () => {
    await signIn();

    const kinds = (await listEvents()).map((event) => event.kind);
    // Newest first.
    expect(kinds).toEqual(['signed_in', 'two_factor_enrolled', 'account_created']);
  });

  it('records a sign-out, after the session is gone', async () => {
    const cookie = await signIn();

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(out.statusCode).toBe(204);

    // The session it names is genuinely destroyed, which is the ordering that
    // could plausibly have been got wrong: the username has to be read before
    // the destroy and written after it, and a record written *through* the
    // session would have resurrected the row it was reporting the end of.
    const [newest] = await listEvents();
    expect(newest?.kind).toBe('signed_out');
    expect(newest?.subject).toBe(OWNER.username);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('records a refused password and a refused code apart', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: OWNER.username, password: 'not-the-password' },
    });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: OWNER });
    await app.inject({
      method: 'POST',
      url: '/api/auth/second-factor',
      payload: { challenge: login.json<{ challenge: string }>().challenge, code: '000000' },
    });

    const kinds = (await listEvents()).map((event) => event.kind);
    expect(kinds.slice(0, 2)).toEqual(['second_factor_failed', 'sign_in_failed']);
  });

  it('names the administrator who reset somebody else’s credential', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { username: 'partner', temporaryPassword: 'temporary-pass-phrase', role: 'user' },
    });
    const { id } = created.json<{ user: { id: string } }>().user;

    await app.inject({
      method: 'POST',
      url: `/api/users/${id}/reset-password`,
      headers: { cookie: ownerCookie },
      payload: { temporaryPassword: 'another-temporary-phrase' },
    });

    const [reset, createdEvent] = await listEvents();
    expect(reset?.kind).toBe('password_reset');
    // The subject is who it was done to; the actor is who did it. A record that
    // conflated them would be unable to answer the only question worth asking
    // about an administrator action.
    expect(reset?.subject).toBe('partner');
    expect(reset?.actor).toBe(OWNER.username);
    expect(createdEvent?.kind).toBe('account_created');
    expect(createdEvent?.actor).toBe(OWNER.username);
  });
});

describe('what is never recorded', () => {
  /**
   * The rule this table has to obey. The login form has two fields, and typing
   * a password into the top one is common enough that "log the username" and
   * "never log a password" are the same instruction here.
   */
  it('does not store a username that matches no account', async () => {
    const typedPassword = 'correct-horse-battery-staple-typed-into-the-wrong-box';

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: typedPassword, password: 'whatever' },
    });

    const [failure] = await listEvents();
    expect(failure?.kind).toBe('sign_in_failed');
    expect(failure?.subject).not.toContain(typedPassword);
    expect(failure?.subject).toMatch(/^unknown:[A-Za-z0-9_-]{8}$/);

    // And nowhere else in the row either.
    const stored = await prisma.authEvent.findMany();
    expect(JSON.stringify(stored)).not.toContain(typedPassword);
  });

  it('stores the name when it does match an account, which is what makes it readable', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: OWNER.username, password: 'not-the-password' },
    });

    const [failure] = await listEvents();
    expect(failure?.subject).toBe(OWNER.username);
  });

  it('gives the same digest to the same unknown name, so a guessing loop is still one line of enquiry', async () => {
    for (const _attempt of [1, 2]) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'guess' },
      });
    }

    const [first, second] = await listEvents();
    expect(first?.subject).toBe(second?.subject);
  });
});

describe('who may read it', () => {
  it('is refused to an account that cannot manage users', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
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
      payload: {
        currentPassword: 'temporary-pass-phrase',
        newPassword: 'partner-pass-phrase-here',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth-events',
      headers: { cookie: sessionCookie(changed.headers) },
    });
    // 403 rather than an empty list: this is a record about the household, and
    // an empty answer would read as "nothing has happened".
    expect(response.statusCode).toBe(403);
  });

  it('is refused to nobody at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth-events' });
    expect(response.statusCode).toBe(401);
  });
});

describe('retention', () => {
  /**
   * The one table in this schema an unauthenticated stranger can cause writes
   * to — every refused sign-in is a row. The rate limit makes that slow; only
   * the sweep makes it bounded.
   */
  it('forgets events past the window and keeps the rest', async () => {
    const old = await prisma.authEvent.create({
      data: { kind: 'sign_in_failed', subject: 'unknown:aaaaaaaa' },
    });
    await prisma.authEvent.update({
      where: { id: old.id },
      data: { occurredAt: new Date(Date.now() - 91 * 24 * 3_600_000) },
    });

    const before = await prisma.authEvent.count();
    expect(await pruneAuthEvents(prisma)).toBe(1);
    expect(await prisma.authEvent.count()).toBe(before - 1);
  });

  it('is swept on the sign-in path, not only when called by hand', async () => {
    const old = await prisma.authEvent.create({
      data: { kind: 'sign_in_failed', subject: 'unknown:bbbbbbbb' },
    });
    await prisma.authEvent.update({
      where: { id: old.id },
      data: { occurredAt: new Date(Date.now() - 91 * 24 * 3_600_000) },
    });

    await signIn();

    expect(await prisma.authEvent.findUnique({ where: { id: old.id } })).toBeNull();
  });
});
