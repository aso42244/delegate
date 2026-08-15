import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * The response headers, asserted rather than assumed.
 *
 * These exist because of a bug the entire suite was structurally blind to. The
 * content security policy carried `upgrade-insecure-requests` — one of helmet's
 * defaults, and our directives merge over those rather than replacing them — so
 * on a plain-http origin the browser re-requested every script over https,
 * nothing answered, and the page rendered blank with only its title.
 *
 * Nothing caught it because browsers exempt `localhost` and `127.0.0.1` from
 * that upgrade as potentially-trustworthy origins, and every test and CI job
 * runs against localhost. It appeared the first time the application was opened
 * at a real address — which is to say, in the household's browser and nowhere
 * else.
 *
 * A header assertion does not depend on the address it is fetched from, which is
 * exactly why it is the right shape of test for this.
 */

const BASE = {
  DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
};

async function policyFor(overrides: Record<string, string>): Promise<string> {
  const app: FastifyInstance = await buildApp(loadConfig({ ...BASE, ...overrides }));
  await app.ready();

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    return String(response.headers['content-security-policy'] ?? '');
  } finally {
    await app.close();
  }
}

describe('over plain http', () => {
  let policy: string;

  beforeAll(async () => {
    policy = await policyFor({ SESSION_COOKIE_SECURE: 'false' });
  });

  /** The bug. A blank page, and nothing on screen explaining it. */
  it('never asks the browser to upgrade requests it cannot serve', () => {
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('still restricts where scripts may come from', () => {
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });
});

describe('with TLS in front', () => {
  it('asks for the upgrade once something can answer it', async () => {
    const policy = await policyFor({ SESSION_COOKIE_SECURE: 'true' });
    expect(policy).toContain('upgrade-insecure-requests');
  });

  /**
   * The other half of the condition — this process terminating TLS itself — is
   * not exercised here. Building the app with `TLS_CERT_PATH` set reads the
   * certificate off disk and refuses to start without it, which is the right
   * behaviour and the wrong thing to make a header test depend on. CI covers
   * that path by starting the real image with a real certificate.
   */
});
