import type { Cents } from '@budget/shared';
import { z } from 'zod';

/**
 * Money at the HTTP boundary.
 *
 * Cents are `BigInt` in the database and in every calculation. `JSON.stringify`
 * throws on a bigint, and a JSON number cannot represent large cent values
 * exactly — so cents cross the wire as **decimal strings**, and are parsed back
 * to `BigInt` on the way in. See ADR 002.
 *
 * Formatting for display happens in the UI, at the very edge. Nothing here ever
 * produces a `number` from money.
 */

export function centsOut(value: Cents): string;
export function centsOut(value: Cents | null | undefined): string | null;
export function centsOut(value: Cents | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/** Request-side counterpart: a string of digits becomes a `BigInt`. */
export const centsIn = z
  .string()
  .regex(/^-?\d+$/, 'Must be a whole number of cents, as a string')
  .transform((value) => BigInt(value));

/**
 * Accepts a plain integer too, for hand-written requests and tests.
 *
 * Bounded by `Number.MAX_SAFE_INTEGER` because beyond that a JSON number has
 * already lost precision before it ever reached us — silently accepting it would
 * persist a wrong amount.
 */
export const centsInLoose = z.union([
  centsIn,
  z
    .number()
    .int()
    .refine((value) => Math.abs(value) <= Number.MAX_SAFE_INTEGER, {
      message: 'Amount is too large to be exact as a JSON number; send it as a string',
    })
    .transform((value) => BigInt(value)),
]);

export function dateOut(value: Date): string;
export function dateOut(value: Date | null | undefined): string | null;
export function dateOut(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/**
 * A date key at the boundary: `2026-12-27`, never an instant.
 *
 * A decided day has no zone (ADR 037), and sending one as a full ISO timestamp
 * invites the browser to place it in the reader's — so a target due on the 27th
 * renders as the 26th for anybody west of UTC. Ten characters, and the ambiguity
 * cannot arise.
 */
export function dayOut(value: Date): string;
export function dayOut(value: Date | null | undefined): string | null;
export function dayOut(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString().slice(0, 10);
}

/**
 * The way back in. Midnight UTC, which is how every `DATE` column here is filed.
 *
 * `z.coerce.date()` would accept a timestamp and quietly keep the time on it,
 * and a target dated "2026-12-27T18:00:00-06:00" is a target that compares
 * wrongly against a day.
 */
export const dayIn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar day, as YYYY-MM-DD')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((value) => !Number.isNaN(value.getTime()), { message: 'Not a real calendar day' });

/**
 * A boolean in a query string.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and a query string carries text —
 * so `Boolean("false")` is `true`, and asking for the opposite of a filter
 * silently returns the filter. This is the same fault that made
 * `GET /api/rules/preview?includeCategorized=false` answer with the count for
 * the mode that overwrites categorizations made by hand.
 *
 * Only the two literals are accepted. Anything else is a 400 rather than a
 * guess, because every wrong guess here is a wrong answer that looks right.
 */
export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
