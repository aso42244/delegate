import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { resetDatabase } from './helpers.js';
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
});

describe('with remote access off', () => {
  it('refuses a request arriving on the onion address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/budget',
      headers: { cookie, host: ONION },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('remote_access_disabled');
    // Says where to fix it. Whoever reads this is overwhelmingly likely to be
    // the household, on their own phone, having forgotten to turn it on.
    expect(response.json<{ error: { message: string } }>().error.message).toContain('home network');
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

  it('still answers health and still lets a session be ended', async () => {
    // A remote device holding a session must be able to drop it, and a health
    // check that fails when the door is shut is a health check nobody can read.
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host: ONION } });
    expect(health.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, host: ONION, origin: `http://${ONION}` },
    });
    expect(logout.statusCode).toBeLessThan(400);
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
