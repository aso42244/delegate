import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { resetDatabase } from './helpers.js';
import { errorOf } from './http.js';

/**
 * Claiming the first account.
 *
 * Creating it cannot be authenticated — there is nobody to authenticate as. For
 * Delegate's whole life that was safe because reaching the address meant being
 * in the house. A one-line deploy that can land on a public address gives that
 * up: the budget then belongs to whoever finds it first.
 *
 * The token stands in for network position, and the tests that matter are the
 * two negative ones — a wrong token creates nothing, and a deployment that
 * predates the token is not locked out of its own application.
 */

const TOKEN = 'ABCDE-FGHJK-LMNPQ-RSTUV';
const CREDENTIALS = { username: 'owner', password: 'correct-horse-battery' };

let app: FastifyInstance;
let dir: string;

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
  dir = mkdtempSync(join(tmpdir(), 'delegate-setup-'));
  // The domain reads this at call time, so a test can decide per case whether
  // this deployment has a token at all.
  process.env['SECRETS_DIR'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['SECRETS_DIR'];
});

function writeToken(value: string): void {
  writeFileSync(join(dir, 'setup-token'), `${value}\n`);
}

function setup(payload: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return app
    .inject({ method: 'POST', url: '/api/auth/setup', payload })
    .then((response) => ({ statusCode: response.statusCode, body: response.body }));
}

describe('a deployment with a token', () => {
  beforeEach(() => writeToken(TOKEN));

  it('creates the account when the token matches', async () => {
    const response = await setup({ ...CREDENTIALS, setupToken: TOKEN });

    expect(response.statusCode).toBe(201);
    expect(await prisma.user.count()).toBe(1);
  });

  it('creates nothing on a wrong token', async () => {
    const response = await setup({ ...CREDENTIALS, setupToken: 'WRONG-WRONG-WRONG-WRON' });

    expect(response.statusCode).toBe(403);
    // The assertion that matters: refused *and* nothing was written.
    expect(await prisma.user.count()).toBe(0);
  });

  it('creates nothing when no token is offered at all', async () => {
    const response = await setup(CREDENTIALS);

    expect(response.statusCode).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it('accepts it lower case and untrimmed, because it is read off a terminal', async () => {
    const response = await setup({ ...CREDENTIALS, setupToken: `  ${TOKEN.toLowerCase()}  ` });

    expect(response.statusCode).toBe(201);
  });

  it('tells the interface to ask for it, without saying what it is', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    const state = response.json<{ needsSetup: boolean; needsSetupToken: boolean }>();

    expect(state).toEqual({ needsSetup: true, needsSetupToken: true });
    expect(response.body).not.toContain(TOKEN);
  });

  it('says the token is wrong without hinting at the right one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { ...CREDENTIALS, setupToken: 'NOPE' },
    });

    expect(errorOf(response).code).toBe('setup_token_invalid');
    expect(response.body).not.toContain(TOKEN);
  });
});

describe('a deployment with no token', () => {
  /**
   * Every deployment older than the secrets volume. It has already been set up,
   * so there is nothing here to guard — and refusing it would lock somebody out
   * of their own application over a file they have never had.
   */
  it('is not locked out of setting up', async () => {
    const response = await setup(CREDENTIALS);

    expect(response.statusCode).toBe(201);
    expect(await prisma.user.count()).toBe(1);
  });

  it('does not ask the interface for a code it cannot check', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });

    expect(response.json<{ needsSetupToken: boolean }>().needsSetupToken).toBe(false);
  });
});

describe('once the budget has an account', () => {
  it('reports that setup is done and stops asking for a code', async () => {
    writeToken(TOKEN);
    expect((await setup({ ...CREDENTIALS, setupToken: TOKEN })).statusCode).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/api/auth/setup-state' });
    expect(response.json<{ needsSetup: boolean; needsSetupToken: boolean }>()).toEqual({
      needsSetup: false,
      needsSetupToken: false,
    });
  });

  it('refuses a second claim even with the right token', async () => {
    writeToken(TOKEN);
    await setup({ ...CREDENTIALS, setupToken: TOKEN });

    const second = await setup({
      username: 'intruder',
      password: 'another-passphrase-here',
      setupToken: TOKEN,
    });

    // The domain's advisory-locked check, not the token, is what refuses this —
    // and it still has to.
    expect(second.statusCode).toBe(409);
    expect(await prisma.user.count()).toBe(1);
  });
});
