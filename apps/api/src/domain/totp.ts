import { createHmac, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { hashGeneratedSecret, verifyPassword } from './passwords.js';
import { decryptSecret, encryptSecret } from './secrets.js';

/**
 * Time-based one-time passwords, and the recovery codes that go with them.
 *
 * §10 makes TOTP mandatory on every account, and it now is: the requirement
 * defaults on. It stays a setting because an operator may have a reason to turn
 * it off, not because it should start off — and an account that has not enrolled
 * is sent to enrolment rather than locked out (ADR 027).
 *
 * Two storage decisions, both for the same reason — the nightly `pg_dump` is
 * the copy most likely to leave the device:
 *
 * - The shared secret is **encrypted** (AES-256-GCM, key from `SESSION_SECRET`),
 *   like the SimpleFIN credential. A plaintext secret in a stolen dump is a
 *   working second factor for whoever holds it.
 * - Recovery codes are **argon2id hashes**, like passwords. A recovery code
 *   bypasses the second factor entirely, so a readable one is the same problem
 *   as a readable password.
 */

/**
 * Tolerance in seconds, one TOTP period either side of now. An authenticator
 * whose clock is a few seconds out is extremely common; much beyond a single
 * period and the window starts being worth attacking rather than forgiving.
 */
const EPOCH_TOLERANCE_SECONDS = 30;

/**
 * Anything that is not six digits is not a TOTP code and is not offered to the
 * verifier, which throws rather than returning false on a token it cannot parse
 * — and a recovery code reaches here before it is recognised as one.
 */
async function codeMatches(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const result = await verifyOtp({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS });
  return result.valid;
}

export const RECOVERY_CODE_COUNT = 10;

export interface EnrolmentOffer {
  /** Shown as text so it can be typed into an authenticator by hand. */
  readonly secret: string;
  /** The `otpauth://` URI a QR code encodes. */
  readonly uri: string;
}

/**
 * Begins enrolment: generates a secret and stores it **unconfirmed**.
 *
 * Unconfirmed matters. A secret that gated sign-in the moment it was generated
 * would lock out anyone who closed the tab before scanning it — the account
 * would demand a code from an authenticator that never received one.
 */
export async function beginEnrolment(
  db: Db,
  userId: string,
  sessionSecret: string,
  appName: string,
): Promise<EnrolmentOffer> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, totpConfirmedAt: true },
  });
  if (!user) throw new NotFoundError('User', userId);
  if (user.totpConfirmedAt) {
    throw new ConflictError(
      'totp_already_enrolled',
      'Two-factor authentication is already set up for this account.',
    );
  }

  const secret = generateSecret();

  await db.user.update({
    where: { id: userId },
    data: {
      totpSecretEncrypted: encryptSecret(secret, sessionSecret),
      // Explicitly null: restarting enrolment must not inherit a confirmation.
      totpConfirmedAt: null,
    },
  });

  return {
    secret,
    uri: generateURI({ issuer: appName, label: user.username, secret }),
  };
}

/**
 * Completes enrolment once a code from the authenticator verifies, and issues
 * the recovery codes.
 *
 * The codes are returned **once**, in the clear, and never again — only their
 * hashes are kept. Anything else would mean the application could hand back a
 * working second factor to whoever was signed in.
 */
export async function confirmEnrolment(
  db: Db,
  userId: string,
  code: string,
  sessionSecret: string,
): Promise<{ recoveryCodes: string[] }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, totpSecretEncrypted: true, totpConfirmedAt: true },
  });
  if (!user) throw new NotFoundError('User', userId);
  if (user.totpConfirmedAt) {
    throw new ConflictError('totp_already_enrolled', 'Two-factor is already set up.');
  }
  if (!user.totpSecretEncrypted) {
    throw new ConflictError('totp_not_started', 'Start setting up two-factor first.');
  }

  const secret = decryptSecret(user.totpSecretEncrypted, sessionSecret);
  if (!(await codeMatches(secret, normalize(code)))) {
    throw new ValidationError(
      'totp_code_invalid',
      'That code did not match. Check your authenticator and try the current one.',
    );
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

  await db.recoveryCode.deleteMany({ where: { userId } });
  for (const plain of codes) {
    await db.recoveryCode.create({
      // Hashed in its normalised form, so a code typed back without the hyphen
      // — or with the spacing a phone's keyboard adds — still matches.
      data: { userId, codeHash: await hashGeneratedSecret(normalize(plain)) },
    });
  }

  await db.user.update({ where: { id: userId }, data: { totpConfirmedAt: new Date() } });

  return { recoveryCodes: codes };
}

/**
 * Verifies a code at sign-in. Accepts either an authenticator code or an
 * unused recovery code, and spends the recovery code if that is what it was.
 */
export async function verifySecondFactor(
  db: Db,
  userId: string,
  code: string,
  sessionSecret: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, totpSecretEncrypted: true, totpConfirmedAt: true },
  });
  if (!user?.totpConfirmedAt || !user.totpSecretEncrypted) return false;

  const candidate = normalize(code);

  const secret = decryptSecret(user.totpSecretEncrypted, sessionSecret);
  if (await codeMatches(secret, candidate)) {
    // Correct, but not necessarily unused. See `claimCode`.
    return claimCode(db, userId, candidate, sessionSecret);
  }

  // Not a TOTP code. It may be a recovery code, which is checked against every
  // unused one — there is no identifier on a recovery code to look it up by.
  const unused = await db.recoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });

  for (const stored of unused) {
    if (await verifyPassword(stored.codeHash, candidate)) {
      // Spent, not deleted: a used code stays visible as used, and cannot be
      // replayed.
      await db.recoveryCode.update({ where: { id: stored.id }, data: { usedAt: new Date() } });
      return true;
    }
  }

  return false;
}

/**
 * How long a used code has to be remembered.
 *
 * One period either side of now is ninety seconds of validity; a little over
 * twice that is comfortably past the point where the code could be accepted
 * again, and keeps the table from having to be precise about clock skew.
 */
const REPLAY_WINDOW_MS = 4 * 60 * 1000;

/**
 * Spends a code, or refuses it because it has already been spent.
 *
 * A correct TOTP code is valid for about ninety seconds, and until now nothing
 * recorded that one had been used. Anybody who saw a code inside that window
 * could use it a second time — and with TLS terminated by a tunnel provider,
 * "saw a code" is not a hypothetical. Recovery codes were already single-use;
 * this gives TOTP the same property.
 *
 * The unique index does the work rather than a read-then-write. Two requests
 * arriving with the same code at the same moment would both pass a check-then-
 * insert; only one of them can win an insert.
 */
async function claimCode(
  db: Db,
  userId: string,
  code: string,
  sessionSecret: string,
  now: Date = new Date(),
): Promise<boolean> {
  // Domain-separated, like every other use of this secret.
  const codeHash = createHmac('sha256', sessionSecret)
    .update(`totp-used:${userId}:${code}`)
    .digest('base64url');

  try {
    await db.totpUsedCode.create({
      data: { userId, codeHash, expiresAt: new Date(now.getTime() + REPLAY_WINDOW_MS) },
    });
  } catch {
    // The only way the insert fails is the unique index, which means this exact
    // code has already been accepted for this account.
    return false;
  }

  // Swept here rather than on a schedule: the rows are only interesting for four
  // minutes, and a sign-in is exactly when there is one worth removing.
  await db.totpUsedCode.deleteMany({ where: { userId, expiresAt: { lt: now } } });

  return true;
}

export interface TotpStatus {
  readonly enrolled: boolean;
  readonly recoveryCodesRemaining: number;
}

export async function totpStatus(db: Db, userId: string): Promise<TotpStatus> {
  const [user, remaining] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { totpConfirmedAt: true } }),
    db.recoveryCode.count({ where: { userId, usedAt: null } }),
  ]);

  return {
    enrolled: Boolean(user?.totpConfirmedAt),
    recoveryCodesRemaining: remaining,
  };
}

/**
 * Turns two-factor off for an account, and destroys its recovery codes.
 *
 * Requires the current password. Without that, anyone who found a signed-in
 * session could quietly remove the second factor and leave the account
 * protected by exactly what they already had.
 */
export async function disableTotp(db: Db, userId: string, currentPassword: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, totpConfirmedAt: true },
  });
  if (!user) throw new NotFoundError('User', userId);
  if (!user.totpConfirmedAt) {
    throw new ConflictError('totp_not_enrolled', 'Two-factor is not set up for this account.');
  }
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new ValidationError('password_incorrect', 'That password is not correct.');
  }

  await db.recoveryCode.deleteMany({ where: { userId } });
  await db.user.update({
    where: { id: userId },
    data: { totpSecretEncrypted: null, totpConfirmedAt: null },
  });
}

/**
 * Ten groups of four from an unambiguous alphabet — no O/0, no I/1/l. These get
 * written on paper and read back months later under mild stress.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  const letters = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `${letters.slice(0, 5)}-${letters.slice(5, 10)}`;
}

/** Authenticators show `123 456`; people paste it with the space. */
function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
