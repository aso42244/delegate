import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The sync routes.
 *
 * The property worth guarding here is that the access URL never leaves the
 * server: it embeds Basic Auth credentials for the household's bank data.
 */

let app: FastifyInstance;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const FAKE_ACCESS_URL = 'https://demo:demo-secret@bridge.example.test/simplefin';

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      SIMPLEFIN_ACCESS_URL: FAKE_ACCESS_URL,
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

describe('sync status', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sync/status' });
    expect(response.statusCode).toBe(401);
  });

  it('never returns the access URL or its credentials', async () => {
    const cookie = await setUpOwner();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { cookie },
    });

    const body = response.body;
    expect(body).not.toContain('demo-secret');
    expect(body).not.toContain('bridge.example.test');
    // Only whether one is set, never what it is.
    expect(response.json<{ configured: boolean }>().configured).toBe(true);
  });

  it('reports a failing run so the banner can show', async () => {
    const cookie = await setUpOwner();
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-08T10:00:00Z'),
        finishedAt: new Date('2026-08-08T10:00:05Z'),
        correlationId: 'sync-failed',
        error: 'SimpleFIN returned 403',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { cookie },
    });

    const body = response.json<{ failing: boolean; runs: { error: string | null }[] }>();
    expect(body.failing).toBe(true);
    expect(body.runs[0]?.error).toMatch(/403/);
  });

  it('clears the failure once a later run succeeds', async () => {
    const cookie = await setUpOwner();
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-08T10:00:00Z'),
        correlationId: 'sync-failed',
        error: 'boom',
      },
    });
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-08T11:00:00Z'),
        finishedAt: new Date('2026-08-08T11:00:05Z'),
        correlationId: 'sync-ok',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/sync/status',
      headers: { cookie },
    });

    expect(response.json<{ failing: boolean }>().failing).toBe(false);
  });
});

describe('manual sync', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses to start a second run while one is in flight', async () => {
    const cookie = await setUpOwner();
    await prisma.syncRun.create({
      data: { status: 'running', startedAt: new Date(), correlationId: 'sync-in-flight' },
    });

    const response = await app.inject({ method: 'POST', url: '/api/sync', headers: { cookie } });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('sync_already_running');
  });
});
