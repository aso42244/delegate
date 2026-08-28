import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { errorOf, sessionCookie } from './http.js';

/**
 * Settings → Budget.
 *
 * The tolerance decides when the Budget page stops reading "Balanced" and the
 * undo window decides how long a Delegate press can be taken back, so both are
 * bounded rather than free. The go-live date is written once, by the first
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

interface SettingsBody {
  undoWindowHours: number;
  identityToleranceCents: string;
  goLiveAt: string | null;
}

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      // These suites sign in on every test from one address. The limit itself
      // is proved in auth.test.ts, which builds an app with a low one.
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

async function readSettings(): Promise<SettingsBody> {
  const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<SettingsBody>();
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/settings', () => {
  it('returns the configured values, with cents as a string', async () => {
    const body = await readSettings();
    expect(body.undoWindowHours).toBe(12);
    expect(body.identityToleranceCents).toBe('500');
    expect(body.goLiveAt).toBeNull();
  });
});

describe('PATCH /api/settings', () => {
  it('changes the tolerance, and the Budget page reads it', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '2500' },
    });
    expect(response.statusCode).toBe(200);

    // The banner's thresholds derive from this value rather than being fixed, so
    // the budget view has to be reading the same number.
    const view = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    expect(view.json<{ identity: { toleranceCents: string } }>().identity.toleranceCents).toBe(
      '2500',
    );
  });

  it('changes one value without disturbing the other', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { undoWindowHours: 24 },
    });

    const body = await readSettings();
    expect(body.undoWindowHours).toBe(24);
    expect(body.identityToleranceCents).toBe('500');
  });

  it('refuses a negative tolerance, which would make every reading over-delegated', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '-100' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('tolerance_negative');
  });

  it('refuses an undo window outside one hour to one week', async () => {
    for (const undoWindowHours of [0, 169]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { undoWindowHours },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('undo_window_out_of_range');
    }
  });
});

describe('pay cadence', () => {
  it('reports biweekly and 26 until somebody chooses otherwise', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    const body = response.json<{ payCadence: string; cyclesPerYear: number }>();

    expect(body.payCadence).toBe('biweekly');
    // Resolved by the server, so the interface never keeps its own copy of the
    // mapping and cannot disagree with the figures it is labelling.
    expect(body.cyclesPerYear).toBe(26);
  });

  it.each([
    ['weekly', 52],
    ['semimonthly', 24],
    ['monthly', 12],
  ])('accepts %s and reports %i a year', async (payCadence, cyclesPerYear) => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { payCadence },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ payCadence: string; cyclesPerYear: number }>();
    expect(body.payCadence).toBe(payCadence);
    expect(body.cyclesPerYear).toBe(cyclesPerYear);
  });

  it('refuses a cadence that is not one of the four', async () => {
    for (const payCadence of ['fortnightly', 'daily', 'BIWEEKLY', 'every_four_weeks', '']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { payCadence },
      });
      expect(response.statusCode, payCadence).toBe(400);
    }
  });

  it('leaves the tolerance and the undo window alone', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '1000', undoWindowHours: 24 },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { payCadence: 'weekly' },
    });

    const body = response.json<{
      identityToleranceCents: string;
      undoWindowHours: number;
      payCadence: string;
    }>();
    expect(body.identityToleranceCents).toBe('1000');
    expect(body.undoWindowHours).toBe(24);
    expect(body.payCadence).toBe('weekly');
  });
});

/**
 * The schedule time zone, which decides when every job fires — including the
 * nightly snapshot, whose rows are labelled for the local day that just ended.
 * See ADR 036.
 */
describe('schedule timezone', () => {
  interface TimezoneBody {
    scheduleTimezone: string | null;
    environmentTimezone: string;
    effectiveTimezone: string;
    availableTimezones: string[];
  }

  async function readTimezone(): Promise<TimezoneBody> {
    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json<TimezoneBody>();
  }

  /**
   * The state that matters most on upgrade: nobody has chosen, so the schedules
   * keep running exactly where the environment put them. This migration must
   * change when nothing fires.
   */
  it('follows the environment until somebody chooses', async () => {
    const body = await readTimezone();
    expect(body.scheduleTimezone).toBeNull();
    expect(body.effectiveTimezone).toBe(body.environmentTimezone);
  });

  it('takes a chosen zone, and reports it as the one in force', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { scheduleTimezone: 'America/Chicago' },
    });
    expect(response.statusCode).toBe(200);

    const body = await readTimezone();
    expect(body.scheduleTimezone).toBe('America/Chicago');
    expect(body.effectiveTimezone).toBe('America/Chicago');
  });

  /**
   * Null is a value here, not an absence. Clearing the choice goes back to
   * following the environment, which is the only way out of a zone somebody set
   * by mistake without knowing what the environment says.
   */
  it('clears back to the environment when set to null', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { scheduleTimezone: 'Europe/London' },
    });
    expect((await readTimezone()).effectiveTimezone).toBe('Europe/London');

    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { scheduleTimezone: null },
    });

    const body = await readTimezone();
    expect(body.scheduleTimezone).toBeNull();
    expect(body.effectiveTimezone).toBe(body.environmentTimezone);
  });

  /**
   * Refused at save time rather than at the next fire. An unknown zone does not
   * throw when a task is scheduled with it — it falls back to the process
   * default — so a typo would leave every schedule running at an hour nobody
   * chose, with nothing on screen saying so.
   */
  it('refuses an abbreviation or a fixed offset, which carry no DST rules', async () => {
    for (const zone of ['CST', '-05:00', 'Mars/Olympus_Mons']) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { scheduleTimezone: zone },
      });
      expect(response.statusCode).toBe(400);
    }

    // And nothing was stored on the way through.
    expect((await readTimezone()).scheduleTimezone).toBeNull();
  });

  it('offers a list the server would accept', async () => {
    const body = await readTimezone();
    expect(body.availableTimezones).toContain('UTC');
    expect(body.availableTimezones).toContain('America/Chicago');

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { scheduleTimezone: body.availableTimezones[42] },
    });
    expect(response.statusCode).toBe(200);
  });

  it('leaves the other settings alone', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { identityToleranceCents: '1000', undoWindowHours: 24 },
    });

    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { scheduleTimezone: 'America/Chicago' },
    });

    const body = await readSettings();
    expect(body.identityToleranceCents).toBe('1000');
    expect(body.undoWindowHours).toBe(24);
  });
});
