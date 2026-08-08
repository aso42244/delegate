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
export class PrismaSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly defaultTtlSeconds: number,
  ) {}

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    const userId = readUserId(session);

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
      .then(() => {
        callback();
      })
      .catch(callback);
  }

  get(sessionId: string, callback: (err: unknown, result?: Session | null) => void): void {
    this.db.session
      .findUnique({ where: { id: sessionId }, select: { data: true, expiresAt: true } })
      .then(async (row) => {
        if (!row) {
          callback(null, null);
          return;
        }

        // Expired rows are deleted on read as well as by the nightly sweep, so a
        // stale cookie can never be resurrected by a store that simply has not
        // been swept yet.
        if (row.expiresAt.getTime() <= Date.now()) {
          await this.db.session.deleteMany({ where: { id: sessionId } });
          callback(null, null);
          return;
        }

        callback(null, row.data as unknown as Session);
      })
      .catch(callback);
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    // deleteMany, not delete: destroying an already-absent session is success,
    // and `delete` would throw on the logout-twice path.
    this.db.session
      .deleteMany({ where: { id: sessionId } })
      .then(() => {
        callback();
      })
      .catch(callback);
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

/** Deletes every expired session. Wired to a nightly job. */
export async function pruneExpiredSessions(db: Db): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  return count;
}
