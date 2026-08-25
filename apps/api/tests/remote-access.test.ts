import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Reaching the budget over Tor, and refusing to.
 *
 * The onion service existing and being open are two different things. An onion
 * address is unguessable, but "unguessable" and "closed" are different
 * properties — and only one of them survives the address being written down.
 */

let app: FastifyInstance;
let cookie: string;
const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const ONION = 'delegatehqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion';

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

describe('with remote access off', () => {
  /**
   * An empty 404, and nothing that says why.
   *
   * The reply used to explain itself — "remote access is switched off, turn it
   * on from Settings" — on the reasoning that whoever read it was the household
   * having forgotten. To anyone else holding the address it confirmed that a
   * service is there, that it is this application, that remote access exists,
   * and that the address is live and worth keeping for later.
   */
  it('says nothing at all to a request on the onion address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: { cookie, host: ONION },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('');
    // Neither the state nor the feature nor the way to change it.
    expect(response.body).not.toContain('remote_access_disabled');
  });

  /**
   * Every path, including the one Docker probes.
   *
   * `/health` was exempt so a health check would keep working, which sounded
   * reasonable and was the loudest signal here — a 200 confirms a live service
   * unconditionally, to anyone with the address. Docker's own check runs inside
   * the compose network and never carries an onion `Host`, so the exemption
   * bought nothing.
   */
  it('does not answer health either', async () => {
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host: ONION } });

    expect(health.statusCode).toBe(404);
    expect(health.body).toBe('');
  });

  it('does not refuse the same request from the local network', async () => {
    // This is the whole shape of it: the setting is reachable from exactly one
    // place, and that place is where the household already is.
    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: { cookie, host: '10.0.3.4:8088' },
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * Logging out was exempt too, so a remote device could drop its session.
   *
   * A session that cannot reach anything does not need ending from here, and it
   * can be ended from the LAN — or by changing a password, which revokes every
   * other session outright.
   */
  it('does not let a session be ended over Tor either', async () => {
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, host: ONION, origin: `http://${ONION}` },
    });

    expect(logout.statusCode).toBe(404);
  });

  /** The LAN is unaffected: that is where the switch is, and where it is read. */
  it('still answers health on the local network', async () => {
    const health = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '10.0.3.4:8088' },
    });

    expect(health.statusCode).toBe(200);
  });
});

describe('with remote access on', () => {
  beforeEach(async () => {
    await prisma.budgetSettings.update({
      where: { id: 1 },
      data: { remoteOverTorEnabled: true },
    });
  });

  it('answers on the onion address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: { cookie, host: ONION },
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts a state-changing request without extra origin configuration', async () => {
    // The CSRF check compares the stated origin against the Host, and over Tor
    // those agree by construction — so nothing has to be added to
    // TRUSTED_ORIGINS for the onion address to work.
    const response = await app.inject({
      method: 'POST',
      url: '/api/groupings',
      headers: { cookie, host: ONION, origin: `http://${ONION}` },
      payload: { name: 'Essentials', section: 'delegations' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('still refuses a forged origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/groupings',
      headers: { cookie, host: ONION, origin: 'https://evil.example' },
      payload: { name: 'Essentials', section: 'delegations' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('cross_origin_refused');
  });
});

describe('the rate-limit bucket', () => {
  /**
   * Tor does not tell the destination who connected — that is the point of it —
   * so every onion visitor arrives from the tor container's own address. Keyed
   * on that address, ten wrong guesses from a stranger probing the onion would
   * lock out the laptop in the kitchen.
   */
  it('separates onion visitors from the local network', async () => {
    const strict = await buildApp(
      loadConfig({
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
        SESSION_COOKIE_SECURE: 'false',
        // Small enough to exhaust deliberately.
        AUTH_RATE_LIMIT_MAX: '3',
        GLOBAL_RATE_LIMIT_MAX: '100000',
      }),
    );
    await strict.ready();

    // Remote access on, or the gate refuses these before the limiter counts them.
    await prisma.budgetSettings.update({
      where: { id: 1 },
      data: { remoteOverTorEnabled: true },
    });

    try {
      const guess = (host: string): Promise<{ statusCode: number }> =>
        strict.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { host },
          payload: { username: 'owner', password: 'wrong-password-entirely' },
        });

      // A stranger burns the onion allowance.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await guess(ONION);
      }
      expect((await guess(ONION)).statusCode).toBe(429);

      // The household, on the local network, is unaffected.
      expect((await guess('10.0.3.4:8088')).statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });
});
