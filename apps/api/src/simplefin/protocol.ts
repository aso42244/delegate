import { parseMoney, type Cents } from '@budget/shared';
import { z } from 'zod';

/**
 * The SimpleFIN wire format.
 *
 * Two protocol versions are in circulation and the server picks a default when
 * the request does not pin one:
 *
 *   v1  `errors: string[]`, institution details inline on each account as `org`
 *   v2  `errlist: object[]`, `connections: []`, accounts carry `conn_id`
 *
 * We deliberately do not pin a version. Pinning one we cannot test against risks
 * being refused by a bridge that only speaks the other, whereas accepting both
 * shapes costs a few optional fields. Everything version-specific is optional
 * here and normalised into one internal shape below.
 *
 * Unknown fields are ignored rather than rejected: a feed adding a field must
 * never break a household's sync.
 */

/** Amounts arrive as decimal strings, never numbers — see ADR 002. */
const feedAmountSchema = z.string().min(1);

/**
 * Epoch seconds. `posted` is documented as `0` for a pending transaction, so
 * zero is valid input rather than a bug, and is resolved to a real date later.
 */
const epochSecondsSchema = z.number().int().nonnegative();

const transactionSchema = z
  .object({
    id: z.string().min(1),
    posted: epochSecondsSchema,
    amount: feedAmountSchema,
    description: z.string(),
    transacted_at: epochSecondsSchema.optional(),
    pending: z.boolean().optional(),
  })
  .passthrough();

const accountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    currency: z.string().optional(),
    balance: feedAmountSchema,
    'balance-date': epochSecondsSchema.optional(),
    'available-balance': feedAmountSchema.optional(),
    transactions: z.array(transactionSchema).default([]),
    // v2
    conn_id: z.string().optional(),
    // v1
    org: z
      .object({ name: z.string().optional(), domain: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const connectionSchema = z
  .object({
    conn_id: z.string(),
    name: z.string().optional(),
    org_url: z.string().optional(),
  })
  .passthrough();

export const accountSetSchema = z
  .object({
    accounts: z.array(accountSchema).default([]),
    connections: z.array(connectionSchema).default([]),
    // v2 errors are objects; v1 errors are plain strings. Accept either and
    // stringify at the edge, because these are surfaced to the owner verbatim.
    errlist: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
    errors: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  })
  .passthrough();

export type RawAccountSet = z.infer<typeof accountSetSchema>;

/** The normalised shape the sync works against, with both versions flattened. */
export interface FeedTransaction {
  readonly externalId: string;
  readonly amountCents: Cents;
  readonly description: string;
  readonly pending: boolean;
  /** Resolved from `posted`, or `transacted_at` when the feed reports `posted: 0`. */
  readonly occurredAt: Date;
}

export interface FeedAccount {
  readonly externalId: string;
  readonly name: string;
  readonly institution: string | undefined;
  readonly currency: string | undefined;
  readonly balanceCents: Cents;
  readonly balanceAsOf: Date | undefined;
  readonly transactions: readonly FeedTransaction[];
}

export interface FeedResult {
  readonly accounts: readonly FeedAccount[];
  /** Non-fatal problems the bridge reported, surfaced to the owner as-is. */
  readonly errors: readonly string[];
}

/**
 * SimpleFIN sends amounts as decimal strings. Some institutions pad to more than
 * two decimal places (`"-33.450"`), which `parseMoney` rejects as sub-cent
 * precision. Trailing zeros carry no value, so they are trimmed first — but
 * genuine sub-cent precision (`"33.456"`) still raises, because silently
 * rounding money is worse than a failed sync the owner can see.
 */
export function parseFeedAmount(raw: string): Cents {
  const trimmed = raw.trim();
  const withoutPaddedZeros = trimmed.includes('.')
    ? trimmed.replace(/(\.\d{2}\d*?)0+$/, '$1').replace(/\.$/, '')
    : trimmed;
  return parseMoney(withoutPaddedZeros);
}

function errorToString(error: string | Record<string, unknown>): string {
  if (typeof error === 'string') return error;
  const message = error['message'] ?? error['description'] ?? error['error'];
  return typeof message === 'string' ? message : JSON.stringify(error);
}

/**
 * Flattens either protocol version into `FeedResult`.
 *
 * `now` is injected rather than read from the clock so a pending transaction
 * with no usable date is deterministic in tests.
 */
export function normalizeAccountSet(raw: RawAccountSet, now: Date): FeedResult {
  const institutionByConnection = new Map(
    raw.connections.map((connection) => [
      connection.conn_id,
      connection.name ?? connection.org_url,
    ]),
  );

  const accounts = raw.accounts.map((account): FeedAccount => {
    const institution =
      (account.conn_id ? institutionByConnection.get(account.conn_id) : undefined) ??
      account.org?.name ??
      account.org?.domain;

    return {
      externalId: account.id,
      name: account.name,
      institution,
      currency: account.currency,
      balanceCents: parseFeedAmount(account.balance),
      balanceAsOf: account['balance-date'] ? new Date(account['balance-date'] * 1000) : undefined,
      transactions: account.transactions.map((transaction): FeedTransaction => {
        const pending = transaction.pending ?? false;
        // `posted` is 0 while a transaction is pending, so fall back to when it
        // was transacted, and finally to now — a pending row still needs a date
        // to sort and display by.
        const epochSeconds = transaction.posted || transaction.transacted_at;
        return {
          externalId: transaction.id,
          amountCents: parseFeedAmount(transaction.amount),
          description: transaction.description,
          pending,
          occurredAt: epochSeconds ? new Date(epochSeconds * 1000) : now,
        };
      }),
    };
  });

  return {
    accounts,
    errors: [...raw.errlist, ...raw.errors].map(errorToString),
  };
}
