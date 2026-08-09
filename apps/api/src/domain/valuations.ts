import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Property values, and their history.
 *
 * Manual entry only. Zillow's public API was deprecated in 2021, its replacement
 * needs partner approval unavailable to an individual, and scraping the Zestimate
 * violates their terms — unacceptable in a repository that may go public (§8).
 * The `ValuationProvider` shape below is where an API source would slot in
 * without restructuring anything around it.
 *
 * A value is recorded with an `as_of` date and kept, rather than overwritten.
 * The current balance is the latest of them, and the history is what lets the net
 * worth chart show what the house was worth in March rather than what it is worth
 * today — the same reasoning as the Bitcoin daily close.
 */

export interface ValuationProvider {
  readonly name: string;
  /** Null when this provider cannot value that account, rather than guessing. */
  valueFor(accountId: string): Promise<Cents | null>;
}

/** The only implementation there is, and deliberately so. */
export class ManualValuationProvider implements ValuationProvider {
  readonly name = 'manual';

  valueFor(): Promise<Cents | null> {
    // A manual valuation is whatever was last entered; there is nothing to fetch.
    return Promise.resolve(null);
  }
}

/** Midnight UTC for a date — what an `as_of` is filed under. */
function asOfDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface RecordValuationInput {
  readonly accountId: string;
  readonly valueCents: Cents;
  readonly asOf: Date;
  readonly note?: string | null;
  readonly actorId?: string | null;
}

/**
 * Records what something was worth on a date.
 *
 * Two writes, deliberately. The valuation row is history and is never
 * overwritten; the account balance is the *current* figure and only moves when
 * this valuation is the most recent one. Entering a forgotten figure from March
 * must not change what the house is worth today.
 */
export async function recordValuation(
  db: Db,
  input: RecordValuationInput,
): Promise<{ id: string; isCurrent: boolean }> {
  if (input.valueCents < 0n) {
    throw new ValidationError('valuation_negative', 'A value cannot be negative.');
  }

  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, source: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);
  if (account.archivedAt) {
    throw new ConflictError('account_archived', 'That account is archived. Restore it first.');
  }
  if (account.source !== 'manual') {
    // A fed account's balance is the institution's to state, and the next sync
    // would overwrite anything recorded here within the hour.
    throw new ConflictError(
      'valuation_not_manual',
      'Only an account you keep by hand can be valued this way.',
    );
  }

  const asOf = asOfDate(input.asOf);

  const valuation = await db.accountValuation.upsert({
    where: { accountId_asOf: { accountId: input.accountId, asOf } },
    create: {
      accountId: input.accountId,
      valueCents: input.valueCents,
      asOf,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
    },
    update: {
      valueCents: input.valueCents,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
    },
    select: { id: true },
  });

  // Only the most recent valuation defines the current balance.
  const newest = await db.accountValuation.findFirst({
    where: { accountId: input.accountId },
    orderBy: { asOf: 'desc' },
    select: { asOf: true, valueCents: true },
  });

  const isCurrent = newest?.asOf.getTime() === asOf.getTime();
  if (isCurrent) {
    await db.account.update({
      where: { id: input.accountId },
      data: {
        balanceCents: input.valueCents,
        // Recording a value is confirming it, which is what staleness counts from.
        balanceAsOf: new Date(),
      },
    });
  }

  return { id: valuation.id, isCurrent };
}

export interface ValuationRow {
  readonly id: string;
  readonly valueCents: Cents;
  readonly asOf: Date;
  readonly note: string | null;
}

export async function listValuations(db: Db, accountId: string): Promise<ValuationRow[]> {
  return db.accountValuation.findMany({
    where: { accountId },
    orderBy: { asOf: 'desc' },
    select: { id: true, valueCents: true, asOf: true, note: true },
  });
}

/**
 * What something was worth on a date, for the net worth chart.
 *
 * The most recent valuation *at or before* that date — never a later one. A
 * house is worth what it was last valued at until it is valued again, and
 * applying a June figure to a March point on the chart would be the same error
 * as applying today's Bitcoin price backwards.
 */
export async function valueOnDate(db: Db, accountId: string, date: Date): Promise<Cents | null> {
  const row = await db.accountValuation.findFirst({
    where: { accountId, asOf: { lte: asOfDate(date) } },
    orderBy: { asOf: 'desc' },
    select: { valueCents: true },
  });
  return row?.valueCents ?? null;
}

export interface EquityReading {
  readonly propertyValueCents: Cents;
  readonly mortgageBalanceCents: Cents;
  readonly equityCents: Cents;
}

/**
 * Equity on a property that references a mortgage, computed on read.
 *
 * Never stored: a stored copy would drift from the mortgage balance on every
 * payment, and would be wrong in the direction that flatters.
 */
export async function equityFor(db: Db, propertyAccountId: string): Promise<EquityReading | null> {
  const property = await db.account.findUnique({
    where: { id: propertyAccountId },
    select: { balanceCents: true, mortgageAccount: { select: { balanceCents: true } } },
  });
  if (!property) throw new NotFoundError('Account', propertyAccountId);
  if (!property.mortgageAccount) return null;

  return {
    propertyValueCents: property.balanceCents,
    mortgageBalanceCents: property.mortgageAccount.balanceCents,
    equityCents: property.balanceCents - property.mortgageAccount.balanceCents,
  };
}
