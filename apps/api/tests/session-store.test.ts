import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { PrismaSessionStore } from '../src/plugins/session-store.js';
import { resetDatabase, makeUser } from './helpers.js';

/**
 * The session store, driven directly.
 *
 * Through HTTP this behaviour is a race, and a race is not something to assert
 * on — it passes when the timing happens to be kind. Calling the store in the
 * order the race produces makes it deterministic.
 */

const store = new PrismaSessionStore(prisma, 3600);

/** The store speaks callbacks; these make it awaitable. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function set(sessionId: string, session: object): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sessionId, session as never, (error) => (error ? reject(asError(error)) : resolve()));
  });
}

function destroy(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.destroy(sessionId, (error) => (error ? reject(asError(error)) : resolve()));
  });
}

function get(sessionId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    store.get(sessionId, (error, result) => (error ? reject(asError(error)) : resolve(result)));
  });
}

let userId: string;

beforeEach(async () => {
  await resetDatabase();
  userId = (await makeUser('owner')).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('signing out', () => {
  /**
   * The bug this is here for. Signing out deleted the row, and then a request
   * that had been in flight since before the logout finished, re-saved its
   * session — sessions are rolling, so responding pushes the expiry out — and
   * `upsert` created the row again.
   *
   * The user was signed out everywhere visible and still signed in as far as
   * their cookie was concerned. It appeared intermittently, because it depended
   * on what the page happened to have in flight.
   */
  it('does not let an in-flight request resurrect a destroyed session', async () => {
    const session = { userId, cookie: { expires: new Date(Date.now() + 3_600_000) } };

    await set('session-1', session);
    expect(await prisma.session.count()).toBe(1);

    await destroy('session-1');
    expect(await prisma.session.count()).toBe(0);

    // The straggler finishes and writes what it still believes.
    await set('session-1', session);

    expect(await prisma.session.count()).toBe(0);
    expect(await get('session-1')).toBeNull();
  });

  it('still allows a new session to be created afterwards', async () => {
    const session = { userId, cookie: { expires: new Date(Date.now() + 3_600_000) } };

    await set('session-1', session);
    await destroy('session-1');

    // Signing in again mints a fresh id, which was never destroyed.
    await set('session-2', session);

    expect(await prisma.session.count()).toBe(1);
    expect(await get('session-2')).not.toBeNull();
  });
});

/**
 * Ids are unique per test on purpose. The store remembers a destroyed id for a
 * minute, and that memory outlives a `beforeEach` — reusing an id across cases
 * would have one test refuse the next one's session, which is the store working
 * correctly and the test being wrong.
 */
describe('ordinary use', () => {
  it('stores and reads a session back', async () => {
    await set('ordinary-1', { userId, cookie: { expires: new Date(Date.now() + 3_600_000) } });

    const loaded = (await get('ordinary-1')) as { userId: string } | null;
    expect(loaded?.userId).toBe(userId);
  });

  it('refuses to store a session with no user, rather than failing the request', async () => {
    await set('ordinary-anonymous', { cookie: { expires: new Date(Date.now() + 3_600_000) } });
    expect(await prisma.session.count()).toBe(0);
  });

  it('treats an expired row as absent, and clears it', async () => {
    await set('ordinary-expired', { userId, cookie: { expires: new Date(Date.now() - 1000) } });

    expect(await get('ordinary-expired')).toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });
});
