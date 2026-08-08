import argon2 from 'argon2';
import { ValidationError } from './errors.js';

/**
 * Password hashing and policy.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's argon2id baseline:
 * 19 MiB of memory, two passes, one lane. Memory cost is what makes GPU cracking
 * expensive, and 19 MiB per verification is comfortable on a 6 GB NAS that only
 * ever authenticates two people.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Length is the only rule.
 *
 * Composition rules (an uppercase, a digit, a symbol) push people towards
 * predictable substitutions and are explicitly discouraged by NIST SP 800-63B.
 * A long passphrase beats `P@ssw0rd!` and this household uses a password manager.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * argon2 hashes the whole input, so an unbounded password is an unbounded amount
 * of hashing work — a denial-of-service vector on an unauthenticated endpoint.
 */
export const MAX_PASSWORD_LENGTH = 128;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      'password_too_short',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      { minLength: MIN_PASSWORD_LENGTH },
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      'password_too_long',
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
      { maxLength: MAX_PASSWORD_LENGTH },
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Returns false rather than throwing on a malformed stored hash: a corrupted row
 * should deny access, not return a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a value nobody knows, verified against when the
 * username does not exist.
 *
 * Without it, a missing user returns in microseconds while a real one takes the
 * ~50ms argon2 deliberately costs, and that difference alone enumerates every
 * valid username. Computed once at module load.
 */
const DUMMY_HASH_PROMISE = argon2.hash(
  `absent-user-${Date.now()}-${Math.random()}`,
  ARGON2_OPTIONS,
);

/** Burn the same time a real verification would, then fail. */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  await verifyPassword(await DUMMY_HASH_PROMISE, password);
  return false;
}
