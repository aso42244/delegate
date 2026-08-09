import { createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * The short-lived token that carries a half-finished sign-in.
 *
 * A password has been accepted but the second factor has not, so the request
 * cannot hold a session yet — a session is the thing being earned. The state
 * has to live somewhere in between, and it is deliberately **not** the session
 * store: that table requires a `user_id` by design, precisely so a row cannot
 * exist for someone who is not signed in, and weakening it to carry a pending
 * sign-in would undo the reason it is shaped that way.
 *
 * So the state travels with the client, signed. It proves only one thing — that
 * this server accepted a password for this account, very recently — and it is
 * accepted by exactly one route.
 */

const TTL_SECONDS = 5 * 60;

interface ChallengePayload {
  readonly userId: string;
  /** Seconds since the epoch. */
  readonly exp: number;
}

function sign(body: string, secret: string): string {
  // Domain-separated from every other use of SESSION_SECRET, so a token from
  // here can never be mistaken for one produced somewhere else.
  return createHmac('sha256', secret).update(`second-factor:${body}`).digest('base64url');
}

export function issueChallenge(userId: string, secret: string, now: Date = new Date()): string {
  const payload: ChallengePayload = {
    userId,
    exp: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Returns the account the challenge was issued for, or throws.
 *
 * Every failure — bad shape, bad signature, expired — raises the same error.
 * A token that reported *why* it was rejected would tell an attacker which part
 * of a forgery attempt to keep.
 */
export function readChallenge(token: string, secret: string, now: Date = new Date()): string {
  const reject = (): never => {
    throw new ValidationError(
      'challenge_invalid',
      'That sign-in attempt has expired. Enter your password again.',
    );
  };

  const [body, signature] = token.split('.');
  if (!body || !signature) reject();

  const expected = sign(body!, secret);
  const given = Buffer.from(signature!);
  const wanted = Buffer.from(expected);
  // Length-checked first: timingSafeEqual throws on a length mismatch, and the
  // throw would itself be a timing signal.
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) reject();

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(body!, 'base64url').toString()) as ChallengePayload;
  } catch {
    return reject();
  }

  if (typeof payload.userId !== 'string' || typeof payload.exp !== 'number') reject();
  if (payload.exp * 1000 <= now.getTime()) reject();

  return payload.userId;
}
