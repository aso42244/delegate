import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * Cross-site request forgery.
 *
 * The scenario under test: the household is signed in, visits an unrelated
 * page, and that page tries to make their browser move money. The session
 * cookie would be attached; the request must still be refused.
 */

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      AUTH_RATE_LIMIT_MAX: '100000',
      TRUSTED_ORIGINS: 'https://budget.example',
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

async function signIn(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  expect(response.statusCode).toBe(201);
  return sessionCookie(response.headers);
}

describe('state-changing requests', () => {
  it('refuses one sent from another site, session cookie and all', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie, origin: 'https://evil.example', host: 'budget.local:8088' },
      payload: { name: 'Groceries' },
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('cross_origin_refused');
  });

  it('allows one from the origin it is served on', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie, origin: 'http://budget.local:8088', host: 'budget.local:8088' },
      payload: { name: 'Groceries' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('allows one from a configured trusted origin behind a proxy', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie, origin: 'https://budget.example', host: 'localhost:8088' },
      payload: { name: 'Groceries' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('falls back to Referer when Origin is absent', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: {
        cookie,
        referer: 'https://evil.example/attack.html',
        host: 'budget.local:8088',
      },
      payload: { name: 'Groceries' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses before the route runs, so an unauthenticated forgery is refused too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example', host: 'budget.local:8088' },
      payload: OWNER,
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('cross_origin_refused');
  });
});

describe('reads', () => {
  it('are left alone — they change nothing, and blocking them breaks links', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie, origin: 'https://evil.example', host: 'budget.local:8088' },
    });

    expect(response.statusCode).toBe(200);
  });
});
