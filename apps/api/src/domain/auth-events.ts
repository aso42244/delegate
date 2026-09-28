import type { AuthEventKind } from '@prisma/client';
import type { Db } from '../db/client.js';

/**
 * What happened to credentials, recorded so a person can read it back.
 *
 * The August review asked for this table twice and it was declined twice, for a
 * reason worth keeping rather than quietly dropping: **a table nobody queries is
 * worse than no table**, because it looks like a control while nothing reads it.
 * This project has already paid for that once — the nightly backup failed every
 * night for weeks, correctly recorded, into a log nothing read.
 *
 * So the rule this module is built to is: the screen is the feature, and the
 * table is how it is fed. Settings → Users shows the most recent events without
 * being asked. If that screen ever goes, this should go with it.
 *
 * Two things it deliberately does not do:
 *
 *  * **It does not record reads.** Everyone in this household sees the whole
 *    budget by design, so opening a page is not an event. A row per page view
 *    would bury the dozen lines a year that matter under thousands that do not.
 *  * **It never throws into the path it is recording.** Writing the record is
 *    not what the request came to do; a sign-out that fails because its audit
 *    row could not be written is a worse outcome than a missing row. Failures
 *    are logged and swallowed — see `record`.
 */

export type { AuthEventKind };

/** What the screen shows for one event, already resolved for display. */
export interface AuthEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: AuthEventKind;
  /** The account it was about — a display name where one exists. */
  readonly subject: string;
  /** Who did it, when somebody else did. Null when they acted on themselves. */
  readonly actor: string | null;
  readonly ip: string | null;
}

export interface RecordAuthEventInput {
  readonly kind: AuthEventKind;
  readonly subject: string;
  readonly userId?: string | null;
  readonly actorId?: string | null;
  readonly ip?: string | null;
}

/** Somewhere to report a failure that must not become the request's failure. */
export interface AuthEventLogger {
  warn(details: object, message: string): void;
}

/**
 * Writes one event.
 *
 * **Never rejects.** A credential change that succeeded is not undone by an
 * audit row that could not be written, and a sign-out that reported a 500
 * because of one would leave somebody pressing it again on a session that is
 * already gone. The failure goes to the log at warn, which is the one case where
 * a log line is the right answer: the thing it is reporting is the recorder
 * itself being broken.
 */
export async function recordAuthEvent(
  db: Db,
  input: RecordAuthEventInput,
  logger?: AuthEventLogger,
): Promise<void> {
  try {
    await db.authEvent.create({
      data: {
        kind: input.kind,
        subject: input.subject,
        userId: input.userId ?? null,
        actorId: input.actorId ?? null,
        ip: input.ip ?? null,
      },
    });
  } catch (error) {
    logger?.warn({ kind: input.kind, error: String(error) }, 'could not record an auth event');
  }
}

/**
 * How long events are kept.
 *
 * Ninety days, matching the absolute session lifetime — the two answer the same
 * question from opposite ends, and a record that outlives every session it could
 * describe is not telling anybody anything they can act on.
 *
 * This is the one table in the schema an **unauthenticated** stranger can cause
 * writes to: every refused sign-in is a row. The rate limit caps that at ten per
 * five minutes per address, which is slow enough not to matter and fast enough
 * to be unbounded over a year.
 *
 * "Nothing is ever hard-deleted" is a rule about the household's *data*, where an
 * archived row stays resolvable so an old transaction still renders `Grocery
 * (archived)`. This is an operational log and is not that.
 */
export const AUTH_EVENT_RETENTION_DAYS = 90;

/** Deletes events past the retention window. Called on the sign-in sweep. */
export async function pruneAuthEvents(
  db: Db,
  retentionDays: number = AUTH_EVENT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  const { count } = await db.authEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return count;
}

/**
 * The most recent events, newest first.
 *
 * Capped rather than paginated. This is a screen somebody glances at to answer
 * "has anything strange happened", and the answer is always in the last page —
 * an older question is a `psql` question. A pager here would be a control nobody
 * presses, on a card that exists to be read at a glance.
 */
export const AUTH_EVENT_PAGE_SIZE = 50;

export async function listAuthEvents(
  db: Db,
  limit: number = AUTH_EVENT_PAGE_SIZE,
): Promise<AuthEventView[]> {
  const rows = await db.authEvent.findMany({
    orderBy: { occurredAt: 'desc' },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      kind: true,
      subject: true,
      ip: true,
      user: { select: { displayName: true, username: true } },
      actor: { select: { displayName: true, username: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind,
    // The stored subject is what was true when it happened; a display name set
    // since then is what the household actually calls that person now. Falling
    // back to the stored value is what keeps a digest a digest.
    subject: row.user ? (row.user.displayName ?? row.user.username) : row.subject,
    actor: row.actor ? (row.actor.displayName ?? row.actor.username) : null,
    ip: row.ip,
  }));
}
