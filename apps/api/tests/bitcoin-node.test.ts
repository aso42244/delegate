import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { EsploraNode } from '../src/bitcoin/esplora.js';
import { checkNode, readNodeSettings, saveNodeSettings } from '../src/domain/bitcoin-node.js';
import { resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The node configuration, and the client that talks to it.
 *
 * Nothing here reaches a real node: the fetch is handed in, so the client's
 * behaviour is provable without a network. What is worth proving is that a URL
 * cannot be stored in a state that would leak addresses, and that a failure is
 * recorded rather than thrown away.
 */

let app: FastifyInstance;
let cookie: string;
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

/** A fetch that answers from a table rather than a network. */
function stubFetch(routes: Record<string, { status?: number; body: string }>) {
  return (url: string): Promise<Response> => {
    const match = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!match) return Promise.resolve(new Response('not found', { status: 404 }));
    const [, answer] = match;
    return Promise.resolve(new Response(answer.body, { status: answer.status ?? 200 }));
  };
}

describe('storing a node', () => {
  it('refuses a public endpoint over plain http', async () => {
    // Stored, it would sit there looking fine and send every address lookup
    // across the internet in the clear the first time a wallet was scanned.
    const response = await app.inject({
      method: 'PUT',
      url: '/api/bitcoin/node',
      headers: { cookie },
      payload: { mode: 'esplora', baseUrl: 'http://mempool.space/api' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('node_url_insecure');
  });

  it('accepts https, a private address and an onion', async () => {
    // The onion needs no extra flag: Tor is inferred from the address, because
    // it is the only way one can be reached. See ADR 026.
    for (const baseUrl of [
      'https://mempool.space/api',
      'http://192.168.1.50:3002',
      'http://abcdefghijklmnop.onion/api',
    ]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/bitcoin/node',
        headers: { cookie },
        payload: { mode: 'esplora', baseUrl },
      });
      expect(response.statusCode, baseUrl).toBe(200);
      expect((await readNodeSettings(prisma)).baseUrl).toBe(baseUrl);
    }
  });

  it('clears everything when the node is turned off', async () => {
    await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: 'https://mempool.space/api' });
    await saveNodeSettings(prisma, { mode: 'none' });

    const settings = await readNodeSettings(prisma);
    expect(settings.mode).toBe('none');
    expect(settings.baseUrl).toBeNull();
  });

  it('forgets the last result when the URL changes', async () => {
    await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: 'https://mempool.space/api' });
    await prisma.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { lastCheckedAt: new Date(), lastHeight: 900_000 },
    });

    await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: 'https://blockstream.info/api' });

    // Carrying it forward would claim the new URL had answered when it never has.
    const settings = await readNodeSettings(prisma);
    expect(settings.lastHeight).toBeNull();
    expect(settings.lastCheckedAt).toBeNull();
  });
});

describe('asking a node', () => {
  it('reads a chain tip and an address balance', async () => {
    const node = new EsploraNode(
      'https://node.example/api',
      stubFetch({
        '/blocks/tip/height': { body: '912004' },
        '/address/bc1qexample': {
          body: JSON.stringify({
            chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000, tx_count: 3 },
            mempool_stats: { funded_txo_sum: 999_999, spent_txo_sum: 0, tx_count: 1 },
          }),
        },
      }),
    );

    expect(await node.tipHeight()).toBe(912_004);

    const stats = await node.addressStats('bc1qexample');
    // Confirmed only: the mempool figure is deliberately ignored, or a holding
    // would flicker between syncs for money that has not settled.
    expect(stats.fundedSats).toBe(150_000n);
    expect(stats.balanceSats).toBe(100_000n);
    expect(stats.txCount).toBe(3);
  });

  it('says plainly when a URL answers but is not a node', async () => {
    const node = new EsploraNode(
      'https://node.example/api',
      stubFetch({ '/blocks/tip/height': { body: '<!doctype html><html>hello</html>' } }),
    );

    // Pointing at the explorer's web page rather than its API is the ordinary
    // mistake, and "unreadable" would not help anybody fix it.
    await expect(node.tipHeight()).rejects.toThrow(/usually ends in \/api/);
  });

  it('refuses to be built on a URL that would leak', () => {
    expect(() => new EsploraNode('http://mempool.space/api')).toThrow(/only allowed to an onion/);
  });

  it('records a failure rather than throwing it away', async () => {
    await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: 'https://127.0.0.2:1/api' });

    const result = await checkNode(prisma);
    expect(result.ok).toBe(false);

    // "Never reached", "reached, height 912,004" and "failing since Tuesday"
    // are three different states, and only the last is worth acting on.
    const settings = await readNodeSettings(prisma);
    expect(settings.lastError).not.toBeNull();
    expect(settings.lastCheckedAt).not.toBeNull();
  });
});
