import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '.env', quiet: true });

/**
 * End-to-end tests.
 *
 * These exist because typechecking and 289 passing tests both said nothing when
 * the server crashed on boot: nothing had ever *started the process* with a UI
 * build present. Unit and integration tests import modules; only a browser
 * driving a real server exercises what the household actually uses.
 *
 * They run against `TEST_DATABASE_URL`, which they truncate, and build their own
 * fixtures through the API. No real account and no real password is involved.
 */

const PORT = 4173;
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';

if (!TEST_DATABASE_URL.includes('_test')) {
  throw new Error(
    'End-to-end tests need TEST_DATABASE_URL pointing at a throwaway database whose name contains _test — they truncate it.',
  );
}

export default defineConfig({
  testDir: 'e2e',
  // Serial: every spec truncates the shared database, so parallel workers would
  // delete each other's fixtures mid-test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    // Kept only for a failure: enough to see what happened without generating a
    // pile of artefacts on every green run.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // The built server, serving the built UI — the same artefact the NAS runs,
    // rather than a dev server that behaves differently.
    command: 'node apps/api/dist/server.js',
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATABASE_URL: TEST_DATABASE_URL,
      SESSION_SECRET: 'end-to-end-session-secret-at-least-32-chars',
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'warn',
      APP_NAME: 'Delegate',
      // Never let an end-to-end run reach a real bridge.
      SIMPLEFIN_ACCESS_URL: '',
      // Nor a real price feed. The scheduler runs inside this server, and a
      // suite that makes outbound calls to a third party is a suite that goes
      // red when somebody else has an outage. Once a year, on a date no run
      // will hit.
      BITCOIN_PRICE_CRON: '0 0 1 1 *',
      // The suite signs in on every test from one address. The limit itself is
      // proved in the integration tests, against an app configured with a low
      // one; here it would only throttle the tests.
      AUTH_RATE_LIMIT_MAX: '100000',
      // The suite is one address making thousands of requests in two minutes,
      // which is exactly what the limit is for and exactly not the subject here.
      GLOBAL_RATE_LIMIT_MAX: '1000000',
    },
  },
});
