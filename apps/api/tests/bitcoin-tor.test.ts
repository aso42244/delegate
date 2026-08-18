import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { torDispatcher } from '../src/bitcoin/tor.js';
import { readNodeSettings, saveNodeSettings } from '../src/domain/bitcoin-node.js';
import { resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Reaching a node over Tor.
 *
 * No Tor daemon here, and none needed for the parts worth proving: that an onion
 * address cannot be saved in a state where it could never answer, and that the
 * dispatcher is built from configuration rather than assumed.
 */

let app: FastifyInstance;
let cookie: string;
const OWNER = { username: 'owner', password: 'correct-horse-battery' };

const ONION = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api';

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

describe('an onion address', () => {
  it('cannot be saved with Tor off', async () => {
    // It has no DNS entry and no route except through the proxy, so saving one
    // without Tor would be saving a node that can never answer — and the owner
    // would find out as a scan failure days later rather than now.
    const response = await app.inject({
      method: 'PUT',
      url: '/api/bitcoin/node',
      headers: { cookie },
      payload: { mode: 'esplora', baseUrl: ONION, useTor: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('tor_required_for_onion');
  });

  it('is accepted with Tor on', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/bitcoin/node',
      headers: { cookie },
      payload: { mode: 'esplora', baseUrl: ONION, useTor: true },
    });

    expect(response.statusCode).toBe(200);
    const settings = await readNodeSettings(prisma);
    expect(settings.useTor).toBe(true);
    expect(settings.baseUrl).toBe(ONION);
  });

  it('is still allowed over plain http, which is not a downgrade', async () => {
    // A v3 onion name is a public key: the transport is already encrypted and
    // authenticated by the address. This is the one place the https rule bends,
    // and it bends on purpose.
    await expect(
      saveNodeSettings(prisma, { mode: 'esplora', baseUrl: ONION, useTor: true }),
    ).resolves.toBeUndefined();
  });
});

describe('an ordinary node', () => {
  it('can use Tor without being an onion', async () => {
    // Reaching a clearnet node through Tor hides which household is asking,
    // which is a reason to do it even where the address resolves normally.
    await saveNodeSettings(prisma, {
      mode: 'esplora',
      baseUrl: 'https://mempool.space/api',
      useTor: true,
    });
    expect((await readNodeSettings(prisma)).useTor).toBe(true);
  });

  it('drops Tor when the node is turned off', async () => {
    await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: ONION, useTor: true });
    await saveNodeSettings(prisma, { mode: 'none' });
    expect((await readNodeSettings(prisma)).useTor).toBe(false);
  });
});

describe('the dispatcher', () => {
  it('is built from the configured proxy', () => {
    expect(torDispatcher('socks5h://tor:9050')).toBeDefined();
    expect(torDispatcher('socks5h://127.0.0.1:9150')).toBeDefined();
  });

  it('says which setting is wrong rather than failing at request time', () => {
    expect(() => torDispatcher('not a url')).toThrow(/TOR_SOCKS_URL/);
  });
});
