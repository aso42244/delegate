import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiTokenScope, Prisma } from '@prisma/client';
import type { UserRole } from '@budget/shared';
import type { Db } from '../db/client.js';
import { NotFoundError, ValidationError } from './errors.js';

/**
 * Credentials for programs.
 *
 * Everything else that authenticates here is a person with a browser: a session
 * cookie, a password, a code from an authenticator. The Model Context Protocol
 * server is none of those. It holds one string, sends it on every request, and
 * cannot be prompted for anything.
 *
 * A token is two halves joined by an underscore:
 *
 *   dlg_<16 hex selector>_<43 char base64url secret>
 *
 * The selector is stored in the clear and carries a unique index; the secret is
 * stored only as a SHA-256 digest. Splitting them is what keeps verification a
 * single indexed lookup — a salted hash cannot be looked up, so the alternative
 * is hashing the presented secret against every stored row, which gets slower
 * with each token issued.
 *
 * SHA-256 rather than argon2id is deliberate and is the subject of ADR 030. The
 * short version: argon2's memory hardness exists to make *guessing* expensive,
 * and there is nothing to guess. The secret is 256 bits from the system random
 * source, not a passphrase somebody chose.
 */

/** Marks the string as ours in a log, a `.env` file, or a leak scanner. */
const TOKEN_PREFIX = 'dlg';

const SELECTOR_BYTES = 8;
const SECRET_BYTES = 32;

/** Names are shown in a revocation list, so they have to mean something. */
export const MAX_TOKEN_NAME_LENGTH = 60;

/**
 * How stale `lastUsedAt` is allowed to get.
 *
 * Writing it on every request turns a read into a transaction, and the column
 * exists to answer "is this token still in use?" — a question five minutes of
 * imprecision does not affect.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface IssuedToken {
  /** The only time the full token exists. Never stored, never recoverable. */
  readonly token: string;
  readonly selector: string;
  readonly secretHash: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Mints a token without touching the database, so it can be tested alone. */
export function generateApiToken(): IssuedToken {
  const selector = randomBytes(SELECTOR_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  return {
    token: `${TOKEN_PREFIX}_${selector}_${secret}`,
    selector,
    secretHash: sha256Hex(secret),
  };
}

/**
 * Splits a presented token, or returns null if it is not one of ours.
 *
 * Shape is checked before the database is asked anything: a malformed string is
 * not worth a query, and refusing it here means the lookup path only ever sees
 * a well-formed selector.
 *
 * Anchored on the *first two* underscores rather than split on all of them.
 * base64url's alphabet contains `_`, so roughly half of all secrets carry one
 * and a plain `split('_')` rejected them — which looked exactly like a flaky
 * server rather than like a parser bug.
 */
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{16})_([A-Za-z0-9_-]+)$`);

export function parseApiToken(presented: string): { selector: string; secret: string } | null {
  const match = TOKEN_PATTERN.exec(presented);
  if (!match) return null;

  return { selector: match[1]!, secret: match[2]! };
}

/** Compares digests without leaking where they first differ. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // signal. Both sides are fixed-width hex here, so this only fires on a
  // corrupted row — deny rather than throw.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly scope: ApiTokenScope;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly username: string;
}

const SUMMARY_SELECT = {
  id: true,
  name: true,
  scope: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  user: { select: { username: true } },
} satisfies Prisma.ApiTokenSelect;

function toSummary(row: {
  id: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  user: { username: string };
}): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    username: row.user.username,
  };
}

export interface CreateApiTokenInput {
  readonly userId: string;
  readonly name: string;
  readonly scope: ApiTokenScope;
  /** Null means it never expires — an explicit choice, not the default. */
  readonly expiresInDays: number | null;
}

export interface CreateApiTokenResult {
  readonly token: ApiTokenSummary;
  /** Returned exactly once, on the response to the request that created it. */
  readonly secret: string;
}

export async function createApiToken(
  db: Db,
  input: CreateApiTokenInput,
  now: Date = new Date(),
): Promise<CreateApiTokenResult> {
  const name = input.name.trim();
  if (!name) {
    throw new ValidationError('token_name_required', 'Give the token a name.');
  }
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    throw new ValidationError(
      'token_name_too_long',
      `A token name must be at most ${MAX_TOKEN_NAME_LENGTH} characters.`,
      { maxLength: MAX_TOKEN_NAME_LENGTH },
    );
  }

  const issued = generateApiToken();
  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const row = await db.apiToken.create({
    data: {
      name,
      selector: issued.selector,
      secretHash: issued.secretHash,
      scope: input.scope,
      userId: input.userId,
      expiresAt,
    },
    select: SUMMARY_SELECT,
  });

  return { token: toSummary(row), secret: issued.token };
}

/** Newest first, revoked ones included — the record is the point. */
export async function listApiTokens(db: Db): Promise<ApiTokenSummary[]> {
  const rows = await db.apiToken.findMany({
    orderBy: { createdAt: 'desc' },
    select: SUMMARY_SELECT,
  });
  return rows.map(toSummary);
}

/**
 * Revocation is one-way.
 *
 * Everything else in this schema is archived rather than deleted so it can come
 * back. A credential is the exception: the only thing "un-revoke" could ever
 * do is undo a decision that was made because something had leaked.
 */
export async function revokeApiToken(db: Db, id: string, now: Date = new Date()): Promise<void> {
  const existing = await db.apiToken.findUnique({ where: { id }, select: { revokedAt: true } });
  if (!existing) throw new NotFoundError('API token', id);
  if (existing.revokedAt) return;

  await db.apiToken.update({ where: { id }, data: { revokedAt: now } });
}

export interface AuthenticatedToken {
  readonly tokenId: string;
  readonly scope: ApiTokenScope;
  readonly lastUsedAt: Date | null;
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: UserRole;
    readonly mustChangePassword: boolean;
    readonly hasTotp: boolean;
  };
}

/**
 * Resolves a presented token to the user it acts as, or null.
 *
 * Null for every failure — malformed, unknown, revoked, expired, or belonging
 * to an archived account. The caller answers all of them with the same 401:
 * telling a caller *which* of those it was tells an attacker whether a selector
 * they guessed exists.
 */
export async function authenticateApiToken(
  db: Db,
  presented: string,
  now: Date = new Date(),
): Promise<AuthenticatedToken | null> {
  const parsed = parseApiToken(presented);
  if (!parsed) return null;

  const row = await db.apiToken.findUnique({
    where: { selector: parsed.selector },
    select: {
      id: true,
      secretHash: true,
      scope: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          username: true,
          role: true,
          mustChangePassword: true,
          archivedAt: true,
          totpConfirmedAt: true,
        },
      },
    },
  });

  if (!row) return null;
  if (!digestsMatch(row.secretHash, sha256Hex(parsed.secret))) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  // Read live rather than trusted from issue time, exactly as `requireSession`
  // does: archiving an account must take a token out with it immediately.
  if (row.user.archivedAt) return null;

  return {
    tokenId: row.id,
    scope: row.scope,
    lastUsedAt: row.lastUsedAt,
    user: {
      id: row.user.id,
      username: row.user.username,
      role: row.user.role,
      mustChangePassword: row.user.mustChangePassword,
      hasTotp: row.user.totpConfirmedAt !== null,
    },
  };
}

/**
 * Records that a token was used, at most once per `TOUCH_INTERVAL_MS`.
 *
 * Failures are swallowed by the caller: a request that was properly
 * authenticated must not fail because a bookkeeping write did.
 */
export async function touchApiToken(
  db: Db,
  token: AuthenticatedToken,
  now: Date = new Date(),
): Promise<void> {
  if (token.lastUsedAt && now.getTime() - token.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  await db.apiToken.update({ where: { id: token.tokenId }, data: { lastUsedAt: now } });
}
