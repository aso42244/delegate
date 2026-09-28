import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { resetDatabase } from './helpers.js';
import { errorOf } from './http.js';

/**
 * Running behind a proxy, which is how this is reached from outside the LAN.
 *
 * The whole subject is the sign-in rate limit, and it fails in opposite
 * directions depending on which way `TRUST_PROXY` is wrong:
 *
 * - **Not trusting a real proxy** puts the entire internet in one bucket. Ten
 *   failures from anywhere lock the household out, and no individual attacker
 *   can be singled out.
 * - **Trusting a header nobody vetted** removes the limit altogether, because a
 *   forged address gets a fresh bucket on every request.
 *
 * Both are tested. Neither is theoretical.
 */

const CREDENTIALS = { username: 'owner', password: 'not-the-right-password' };
const LIMIT = 3;

function config(trustProxy: string): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    SESSION_COOKIE_SECURE: 'false',
    AUTH_RATE_LIMIT_MAX: String(LIMIT),
    AUTH_RATE_LIMIT_WINDOW: '5 minutes',
    TRUST_PROXY: trustProxy,
  });
}

/** Signs in badly `count` times from one claimed address, returning the statuses. */
async function attempt(
  app: FastifyInstance,
  count: number,
  forwardedFor: string,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': forwardedFor },
      payload: CREDENTIALS,
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

describe('with a trusted proxy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(config('true'));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('counts each forwarded client separately', async () => {
    const attacker = await attempt(app, LIMIT + 1, '203.0.113.10');
    expect(attacker.at(-1)).toBe(429);
    expect(
      errorOf(
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': '203.0.113.10' },
          payload: CREDENTIALS,
        }),
      ).code,
    ).toBe('too_many_requests');

    // The household, arriving from a different address, is unaffected. Without
    // this the first guessing loop from anywhere locks everyone out.
    const household = await attempt(app, 1, '198.51.100.20');
    expect(household[0]).toBe(401);
  });
});

describe('with no proxy trusted', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(config(''));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * The reason `TRUST_PROXY` is opt-in. Reachable directly, anyone can send an
   * `X-Forwarded-For` of their choosing; if it were believed, every guess would
   * arrive with a fresh address and the limit would not exist.
   */
  it('ignores a forwarded address, so it cannot be used to escape the limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 2; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        // A different claimed address every time.
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
        payload: CREDENTIALS,
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.at(-1)).toBe(429);
  });
});
