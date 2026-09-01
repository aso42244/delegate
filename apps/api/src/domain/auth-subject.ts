import { createHmac } from 'node:crypto';

/**
 * How a sign-in attempt is named in the record it leaves behind.
 *
 * The problem this solves is small and real: the login form has two fields, and
 * a password typed into the top one used to be written into the logs verbatim —
 * where it then reached the nightly `pg_dump`, which is the copy most likely to
 * leave the device. "Log the username" and "never log a password" are the same
 * instruction here, and only one of them was being followed.
 *
 * The rule is therefore about the *name*, not the attempt:
 *
 *  * **It matches a real account** — store it. A mistyped password cannot match
 *    an account, so this branch cannot carry one, and `failed sign-in for andy`
 *    is what makes the record worth reading.
 *  * **It matches nothing** — store a short keyed digest instead. Repeated
 *    attempts against the same unknown name still line up as the same name, so
 *    a guessing loop is still visible, without ever storing what was typed.
 *
 * The digest is keyed rather than plain so the record cannot be turned back
 * into a wordlist by anyone holding a dump and a dictionary, and truncated
 * because eight characters is plenty to correlate a few hundred rows.
 */
const DIGEST_LENGTH = 8;

export function describeAttemptedUsername(
  rawUsername: string,
  usernameKnown: boolean,
  secret: string,
): string {
  if (usernameKnown) return rawUsername.trim().toLowerCase();

  const digest = createHmac('sha256', secret)
    // Domain-separated, like every other use of this secret.
    .update(`auth-subject:${rawUsername.trim().toLowerCase()}`)
    .digest('base64url')
    .slice(0, DIGEST_LENGTH);

  // Prefixed so nobody reading a log or a screen mistakes it for a username
  // somebody actually holds.
  return `unknown:${digest}`;
}
