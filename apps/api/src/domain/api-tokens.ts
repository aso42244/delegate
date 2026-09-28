import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@budget/shared';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';

/**
 * A credential for a program, which reads the budget as the person who made it.
 *
 * Delegate has session cookies with a mandatory second factor and, until now,
 * nothing else. Eventide reads this budget through a narrow, read-only door
 * (ADR 070), and a program has no cookie jar, cannot answer a TOTP prompt and
 * has no screen to be shown a sign-in page on — so it carries one of these.
 *
 * The shape is the one Eventide settled twice over (its ADRs 029 and 285):
 * hashed at rest, **revocable on its own** without signing anybody out,
 * **visible** — when it was last used and from where — and **narrow**, reaching
 * the read door and nothing else. With the one difference that ADR 069 names:
 *
 * **A token authenticates as a person.** Whatever it reads, it reads with that
 * account's whole access, which in this household is the whole budget. Three
 * things follow, each held in the shape of the code rather than in a check
 * somebody has to remember:
 *
 * 1. **`userId` is `NOT NULL`.** A nullable owner would make every lookup return
 *    a row that may or may not carry a person, and that null check would be the
 *    only thing between a stranger and the budget.
 * 2. **You may only make one for yourself.** `issueApiToken` takes one person
 *    and there is no field on the route that could name another.
 * 3. **It is listed and revoked by its owner, scoped in the query.** An id is
 *    guessable in a way a digest is not, and revoking somebody else's machine
 *    is a denial of service on a household member. Not yours answers the same
 *    as does not exist.
 *
 * **The arithmetic is deliberately dull.** Generating a secret with enough
 * entropy that guessing is not a strategy, storing a digest rather than the
 * secret, and comparing two digests in constant time are not judgment calls —
 * they are the three things a second copy always gets wrong, so they sit at the
 * top of this file where they can be read in a minute.
 *
 * A high-entropy random secret wants a **fast digest, not a password hash**.
 * argon2id exists to make a *guessable* secret expensive to guess; 256 bits of
 * randomness cannot be guessed, and this is checked on every request.
 */

/** `dlg` for Delegate. A leaked string then says what it is, so it can be revoked. */
export const API_TOKEN_PREFIX = 'dlg_';

/** Long enough that guessing is not a strategy; short enough to paste. */
const SECRET_BYTES = 32;

export const MAX_API_TOKEN_NAME_LENGTH = 60;

/** A new secret, prefixed. The prefix is not security; it is a label. */
export function newSecret(): string {
  return API_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
}

/** What is stored. Never the secret itself. */
export function digestOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Whether two digests are the same, in constant time.
 *
 * The row is looked up *by* digest, so this only guards against a future change
 * that finds a row some other way. Cheap, and the cost of getting it wrong is a
 * timing oracle on a credential.
 */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The secret out of an `Authorization` header, or undefined.
 *
 * Bearer, because that is what every client sends. Undefined for no header, a
 * different scheme, or a malformed value — the caller treats all three alike.
 */
export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** What the Settings card shows. Never the hash, and never the secret. */
export interface ApiTokenView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly lastUsedFrom: string | null;
  readonly revokedAt: Date | null;
}

const VIEW_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  lastUsedAt: true,
  lastUsedFrom: true,
  revokedAt: true,
} as const;

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new ValidationError('invalid_name', 'Give the token a name.');
  if (trimmed.length > MAX_API_TOKEN_NAME_LENGTH) {
    throw new ValidationError(
      'invalid_name',
      `A token's name is at most ${MAX_API_TOKEN_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Makes one, and returns the only copy of the secret there will ever be.
 *
 * **One person, used for both the owner and the maker.** There is no
 * `createdBy` separate from `userId` and there deliberately never will be: a
 * credential that speaks as somebody else is that person's budget handed over
 * in a text box.
 */
export async function issueApiToken(
  db: Db,
  userId: string,
  name: string,
): Promise<{ token: ApiTokenView; secret: string }> {
  const secret = newSecret();
  const token = await db.apiToken.create({
    data: { name: cleanName(name), userId, tokenHash: digestOf(secret) },
    select: VIEW_SELECT,
  });
  return { token, secret };
}

/**
 * This person's own tokens: live ones first, newest first, then the revoked.
 *
 * Their own and not the household's. A token speaks as one person, so the list
 * of them is that person's business in the way their sessions are — and a
 * screen that showed everybody's would be a screen that invited revoking one.
 * Revoked rows stay: "which machine had this, and when did it last read the
 * budget" is exactly the question a revoked row answers.
 */
export async function listApiTokens(db: Db, userId: string): Promise<ApiTokenView[]> {
  const rows = await db.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: VIEW_SELECT,
  });
  return [...rows.filter((row) => row.revokedAt === null), ...rows.filter((row) => row.revokedAt)];
}

/**
 * Revoking is a timestamp, never a delete.
 *
 * **Scoped to the owner in the query itself**, not checked by the caller. A
 * token that is not yours answers 404, which is what a token that does not
 * exist answers — the two must not be distinguishable. Revoking one that is
 * already revoked is not an error: the state asked for is the state it is in.
 */
export async function revokeApiToken(
  db: Db,
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<ApiTokenView> {
  const existing = await db.apiToken.findFirst({ where: { id, userId }, select: VIEW_SELECT });
  if (!existing) throw new NotFoundError('Token', id);
  if (existing.revokedAt !== null) return existing;

  return db.apiToken.update({
    where: { id: existing.id },
    data: { revokedAt: now },
    select: VIEW_SELECT,
  });
}

/** A program that read the budget, and the person it reads as. */
export interface Reader {
  readonly token: ApiTokenView;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string | null;
    readonly role: UserRole;
  };
}

/**
 * Who is reading, or null.
 *
 * Null is the answer for no secret, one with the wrong prefix, one nobody
 * issued, a revoked one and an archived account. Every one of those means the
 * same thing to the caller, and a door that distinguished them would be telling
 * whoever found it which of their guesses was warm.
 *
 * Looked up by digest so the query is one indexed seek, and the comparison that
 * follows is constant-time. An accepted read stamps when and from where, which
 * is the half of this credential's shape that makes it safe to hold at all.
 *
 * **An archived account's token stops working at once**, for the same reason
 * its sessions do: one rule about what a live account is, not two.
 */
export async function readerFor(
  db: Db,
  presented: string | undefined,
  from: string | null,
  now: Date = new Date(),
): Promise<Reader | null> {
  if (presented === undefined || !presented.startsWith(API_TOKEN_PREFIX)) return null;

  const hash = digestOf(presented);
  const row = await db.apiToken.findUnique({
    where: { tokenHash: hash },
    select: {
      ...VIEW_SELECT,
      tokenHash: true,
      user: {
        select: { id: true, username: true, displayName: true, role: true, archivedAt: true },
      },
    },
  });

  if (row === null || row.revokedAt !== null) return null;
  if (!digestsMatch(hash, row.tokenHash)) return null;
  if (row.user.archivedAt !== null) return null;

  await db.apiToken.update({
    where: { id: row.id },
    data: { lastUsedAt: now, lastUsedFrom: from },
  });

  const { tokenHash: _hash, user, ...token } = row;
  const { archivedAt: _archived, ...reader } = user;
  return { token: { ...token, lastUsedAt: now, lastUsedFrom: from }, user: reader };
}
