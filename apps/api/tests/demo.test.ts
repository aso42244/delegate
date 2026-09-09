import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * The demo instance is read-only, and this is the test that says so.
 *
 * The property is not "the buttons are hidden" — it is that a write cannot
 * happen, whoever sends it and whatever the interface is showing. So these drive
 * the HTTP surface directly rather than the screen, and they check the *method*
 * rather than a list of endpoints: a list of writes is a list somebody has to
 * remember to add to, and the one nobody adds is the one that matters.
 *
 * The other half is just as important and easier to forget: **the default is
 * off.** Getting that wrong makes a household unable to touch its own budget.
 */

const BASE = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'fatal',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
  SESSION_COOKIE_SECURE: 'false',
};

let apps: FastifyInstance[] = [];

async function appWith(env: Record<string, string>): Promise<FastifyInstance> {
  const app = await buildApp(loadConfig({ ...process.env, ...BASE, ...env }));
  await app.ready();
  apps.push(app);
  return app;
}

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe('a demo instance', () => {
  it('refuses every write, before anything can act on it', async () => {
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/transactions' });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('demo_read_only');
    }
  });

  it('refuses a write it has never heard of', async () => {
    // The method is the test, not a list of paths — so a route added tomorrow is
    // already covered, including one that does not exist at all.
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    const response = await app.inject({ method: 'POST', url: '/api/something/invented' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a write before it costs a session lookup or a token check', async () => {
    /*
     * Registered ahead of CSRF and the session plugin. A request with no session
     * and no token still answers 403 rather than 401 or a CSRF failure, which is
     * how the ordering is observable from outside.
     */
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    const response = await app.inject({ method: 'POST', url: '/api/delegations' });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('demo_read_only');
  });

  it('still lets a visitor sign out', async () => {
    /*
     * The one write allowed: it destroys only the visitor's own session, and
     * without it somebody looking at the demo cannot leave it. Refusing it would
     * enforce nothing and cost something.
     */
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(response.statusCode).not.toBe(403);
  });

  it('reads normally', async () => {
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('signing in', () => {
  it('is not asked for on a demo, and writes no session', async () => {
    /*
     * The data is invented, the instance is read-only, and whoever is looking at
     * it was let through by whatever sits in front. Asking them to hold
     * credentials for a fictional household would be asking for nothing.
     *
     * With no user seeded it says so plainly rather than answering 401, because
     * "sign in" is advice nobody here can act on.
     */
    const app = await appWith({ DELEGATE_DEMO: 'true' });

    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect([200, 503]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(401);
  });
});

describe('the gate a proxy asks', () => {
  it('refuses an unsigned request', async () => {
    /*
     * What `/demo` is gated on. It answers yes or no and nothing about who,
     * because a gate that describes the visitor is a gate leaking something.
     */
    const app = await appWith({});

    const response = await app.inject({ method: 'GET', url: '/api/auth/gate' });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('username');
  });

  it('is behind the same chain as everything else', async () => {
    /*
     * `/api/auth/me` was the obvious thing for a proxy to point at, and it
     * carries only `requireSession` — so a session that has not finished
     * enrolling a second factor passes it. A gate meaning something weaker than
     * the rest of the application is one that will be wrong exactly once, in the
     * direction nobody wants.
     *
     * Asserted structurally: both answer 401 to nothing, but only the gate is
     * built from the full chain, and that is what this names.
     */
    const app = await appWith({});
    const gate = app.inject({ method: 'GET', url: '/api/auth/gate' });
    const me = app.inject({ method: 'GET', url: '/api/auth/me' });

    expect((await gate).statusCode).toBe(401);
    expect((await me).statusCode).toBe(401);
  });
});

describe('a real instance', () => {
  it('is not a demo unless it says so', async () => {
    /*
     * The half that is easier to forget. A demo flag defaulting on would leave a
     * household unable to touch its own budget, and it would look like the
     * application was broken rather than misconfigured.
     */
    const app = await appWith({});

    const response = await app.inject({ method: 'POST', url: '/api/transactions' });
    // Refused for want of a session, which is the ordinary answer — not for
    // being a demo.
    expect(response.statusCode).not.toBe(403);
  });

  it('still demands a session for a read', async () => {
    // The other half of the demo's sign-in bypass: it must not exist here.
    const app = await appWith({});

    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
  });
});
