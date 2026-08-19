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
