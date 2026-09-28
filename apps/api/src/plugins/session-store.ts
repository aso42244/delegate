import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import type { Db } from '../db/client.js';

/**
 * A PostgreSQL-backed session store for @fastify/session.
 *
 * The default store keeps sessions in process memory, which logs the household
 * out on every container restart — including the nightly Synology package
 * updates — and grows without bound because nothing evicts expired entries.
 * Sessions live in the database instead. Redis is explicitly out of scope for a
 * two-person workload.
 *
 * The `sessions` table requires a `user_id`, so only authenticated sessions can
 * be persisted. That is enforced by `saveUninitialized: false`: an anonymous
 * visitor never reaches the store at all, and `set` refuses anything without a
 * user rather than writing a row that violates the foreign key.
 */
/**
 * How long a destroyed session id is remembered as destroyed.
 *
 * Only needs to outlive requests that were already in flight when the session
 * was destroyed. A minute is far longer than any of them and short enough that
 * the set stays small.
 */
const TOMBSTONE_MS = 60_000;

export class PrismaSessionStore implements SessionStore {
  /**
   * Session ids destroyed recently, and when they may be forgotten.
   *
   * This exists because of a race that made signing out unreliable, which is a
   * security bug rather than an annoyance:
   *
   * 1. The page has several ordinary requests in flight — the sync poll, the
   *    notification poll — each holding a loaded session.
   * 2. Logout runs and deletes the session row.
   * 3. One of those requests finishes. Sessions are `rolling`, so responding
   *    re-saves the session to push its expiry out — and `upsert` **re-creates
   *    the row that logout just deleted**.
   *
   * The user is then signed out in every visible sense and still signed in as
   * far as their cookie is concerned. It was intermittent, because it depended
   * on what happened to be in flight.
   *
   * In-process is the right scope: one process serves this household (ADR 001),
   * and a restart both clears the map and drops every in-flight request that the
   * map exists to outlive.
   */
  private readonly destroyed = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly defaultTtlSeconds: number,
    private readonly absoluteTtlSeconds: number,
  ) {}

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    const userId = readUserId(session);

    // A session that has been destroyed is not written again, whatever a request
    // that started earlier still believes.
    if (this.isDestroyed(sessionId)) {
      callback();
      return;
    }

    if (!userId) {
      // Not an error: an unauthenticated session simply has nowhere to live.
      // Dropping it silently keeps login working when a request touches the
      // session before credentials have been checked.
      callback();
      return;
    }

    const data = JSON.parse(JSON.stringify(session)) as object;
    const expiresAt = this.expiryOf(session);

    this.db.session
      .upsert({
        where: { id: sessionId },
        create: { id: sessionId, userId, data, expiresAt },
        update: { userId, data, expiresAt },
      })
      .then(async () => {
        // Checked again, because the check above cannot cover a write that was
        // already on its way to the database when the logout deleted the row.
        // In that ordering the upsert lands last and re-creates it, so the
        // remedy is to undo it rather than to prevent it.
        if (this.isDestroyed(sessionId)) {
          await this.db.session.deleteMany({ where: { id: sessionId } });
        }
        callback();
      })
      .catch(callback);
  }

  get(sessionId: string, callback: (err: unknown, result?: Session | null) => void): void {
    this.db.session
      .findUnique({
        where: { id: sessionId },
        select: { data: true, expiresAt: true, createdAt: true },
      })
      .then(async (row) => {
        if (!row) {
          callback(null, null);
          return;
        }

        // Expired rows are deleted on read as well as by the sweep at sign-in,
        // so a stale cookie can never be resurrected by a store that simply has
        // not been swept yet.
        //
        // Two expiries, and they answer different questions. `expires_at` rolls
        // forward on every response and asks "has this been idle too long";
        // `created_at` never moves and asks "has this existed too long". Without
        // the second, a cookie that is being used cannot expire at all — which
        // is precisely the cookie somebody else might be holding.
        if (row.expiresAt.getTime() <= Date.now() || this.pastAbsoluteLifetime(row.createdAt)) {
          await this.db.session.deleteMany({ where: { id: sessionId } });
          callback(null, null);
          return;
        }

        callback(null, row.data as unknown as Session);
      })
      .catch(callback);
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    this.remember(sessionId);

    // deleteMany, not delete: destroying an already-absent session is success,
    // and `delete` would throw on the logout-twice path.
    this.db.session
      .deleteMany({ where: { id: sessionId } })
      .then(() => {
        callback();
      })
      .catch(callback);
  }

  private remember(sessionId: string): void {
    const now = Date.now();
    // Swept here rather than on a timer: the map is only touched on logout, so
    // it cannot grow without something clearing it in the same breath.
    for (const [id, expiry] of this.destroyed) {
      if (expiry <= now) this.destroyed.delete(id);
    }
    this.destroyed.set(sessionId, now + TOMBSTONE_MS);
  }

  private isDestroyed(sessionId: string): boolean {
    const expiry = this.destroyed.get(sessionId);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.destroyed.delete(sessionId);
      return false;
    }
    return true;
  }

  private pastAbsoluteLifetime(createdAt: Date): boolean {
    return createdAt.getTime() + this.absoluteTtlSeconds * 1000 <= Date.now();
  }

  private expiryOf(session: Session): Date {
    const cookieExpires = session.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires);
    return new Date(Date.now() + this.defaultTtlSeconds * 1000);
  }
}

function readUserId(session: Session): string | undefined {
  const value: unknown = (session as unknown as Record<string, unknown>)['userId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Deletes every session that has expired, by either measure.
 *
 * **Called at sign-in, not on a schedule.** The comment here used to claim a
 * nightly job and there has never been one — signing in is the moment there is
 * something worth sweeping, and expired rows are refused on read regardless, so
 * the sweep is housekeeping rather than a control.
 */
export async function pruneExpiredSessions(db: Db, absoluteTtlSeconds: number): Promise<number> {
  const now = new Date();
  const { count } = await db.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { createdAt: { lte: new Date(now.getTime() - absoluteTtlSeconds * 1000) } },
      ],
    },
  });
  return count;
}
