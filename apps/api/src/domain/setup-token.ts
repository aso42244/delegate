import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one-time token that claims the first account.
 *
 * Creating the first account has to be unauthenticated — there is nobody to
 * authenticate as yet. On a trusted LAN that is fine, and it is what Delegate
 * assumed for its whole life: whoever reaches the address is the household.
 *
 * A one-line deploy anywhere ends that assumption. The same image on a public
 * address is a budget that belongs to whoever finds it between `docker compose
 * up` and the owner opening the page, and `GET /api/auth/setup-state` tells any
 * passer-by whether that window is still open. Network position was doing the
 * work, and network position is exactly what a deploy-anywhere image gives up.
 *
 * So claiming the first account requires a token that is only readable from the
 * machine running Delegate: written into the secrets volume by the same one-shot
 * service that generates every other secret, and printed to the logs on a boot
 * where setup is still pending. `docker compose logs app` is the whole recovery
 * path, and needing that is needing access to the host.
 *
 * **Only enforced while a token exists.** A deployment that predates this file
 * has no token in its volume and has already been set up — nothing to protect,
 * and nothing to lock anybody out of.
 */

const DEFAULT_DIR = '/secrets';

export const SETUP_TOKEN_FILE = 'setup-token';

/** The token this deployment expects, or null where there is none. */
export function readSetupToken(
  dir: string = process.env['SECRETS_DIR'] ?? DEFAULT_DIR,
): string | null {
  try {
    const value = readFileSync(join(dir, SETUP_TOKEN_FILE), 'utf8').trim();
    return value === '' ? null : value;
  } catch {
    // No secrets volume at all is the ordinary case for a local development run
    // and for any deployment older than this file.
    return null;
  }
}

/**
 * Whether a presented token matches, compared in constant time.
 *
 * Returns true when there is no token to match, which is the deliberate
 * behaviour for a deployment that predates this: it has already been set up, so
 * there is nothing here to guard.
 */
export function setupTokenAccepted(presented: string, expected: string | null): boolean {
  if (expected === null) return true;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length is not a secret and timingSafeEqual throws on a mismatch, so it is
  // checked first rather than padded around.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
