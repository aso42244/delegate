import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * What the application says about its own backups.
 *
 * This endpoint exists because the answer used to require an SSH session, and
 * the nightly dump had failed every night since go-live while the application
 * stayed green. It reads the directory rather than a table, because the
 * directory is the truth — a row saying a backup succeeded is a second thing
 * that can be right while the file is missing.
 *
 * The schedule is reported for a smaller version of the same reason. The card
 * used to state "nightly at 02:30 UTC, kept for 30 days" whatever the deployment
 * was configured to do.
 */

interface BackupsBody {
  readonly directory: string;
  readonly hostDirectory: string | null;
  readonly cron: string;
  readonly timezone: string;
  readonly retentionDays: number;
  readonly count: number;
  readonly newestAt: string | null;
  readonly recent: readonly unknown[];
}

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
      BACKUP_DIR: '/backups',
      BACKUP_HOST_DIR: '/volume1/backups/delegate',
      BACKUP_CRON: '30 2 * * *',
      BACKUP_RETENTION_DAYS: '14',
      SCHEDULE_TIMEZONE: 'America/Chicago',
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
  cookie = sessionCookie(setup.headers);
  await markTwoFactorEnrolled();
});

describe('GET /api/backups', () => {
  it('needs a session, like everything else that describes this deployment', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(response.statusCode).toBe(401);
  });

  it('reports the schedule this deployment is actually configured with', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/backups',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<BackupsBody>();
    expect(body.cron).toBe('30 2 * * *');
    expect(body.timezone).toBe('America/Chicago');
    expect(body.retentionDays).toBe(14);
  });

  /**
   * Two names for one directory. `/backups` is the only true path inside the
   * container and is no use to somebody standing on the NAS looking for the
   * file, which is exactly what a person chasing a missing dump is doing.
   */
  it('names the directory as the host knows it as well as the container', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/backups',
      headers: { cookie },
    });

    const body = response.json<BackupsBody>();
    expect(body.directory).toBe('/backups');
    expect(body.hostDirectory).toBe('/volume1/backups/delegate');
  });

  /**
   * A missing or unreadable directory is the answer, not an error to throw. The
   * caller reports "no backups", which is what somebody needs to see.
   */
  it('reports no backups rather than failing when the directory is not there', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/backups',
      headers: { cookie },
    });

    const body = response.json<BackupsBody>();
    expect(response.statusCode).toBe(200);
    expect(body.count).toBe(0);
    expect(body.newestAt).toBeNull();
    expect(body.recent).toEqual([]);
  });
});
