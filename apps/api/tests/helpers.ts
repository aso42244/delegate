import type { AccountType, TransactionKind } from '@prisma/client';
import { prisma } from '../src/db/client.js';

/**
 * Fixture helpers. Deliberately explicit rather than clever: a test that reads
 * "checking with $5,000" is worth more than one that shares a factory nobody can
 * follow when the identity assertion fails.
 *
 * No real balances, account numbers or institution names appear anywhere here.
 */

/** Order matters: children before parents, because these are real foreign keys. */
export async function resetDatabase(): Promise<void> {
  /*
   * Every table, discovered rather than listed.
   *
   * This was a hand-maintained list, and a new table left off it leaked rows
   * from one test into the next — four separate times, each found as a
   * confusing failure somewhere unrelated rather than as a missing name here.
   * Asking the database what tables exist cannot fall behind the schema.
   *
   * The exclusions are Prisma's migration table, which is not test data, and the
   * two pinned singletons — rows the application updates by id and never
   * creates. Truncating those turns every write into "no record was found".
   * They are reset in place below instead.
   */
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'budget_settings', 'bitcoin_node_config')
  `;

  if (tables.length > 0) {
    const quoted = tables.map((table) => `"${table.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }

  await prisma.bitcoinNodeConfig.upsert({
    where: { id: 1 },
    create: { id: 1, mode: 'none' },
    update: {
      mode: 'none',
      baseUrl: null,
      useTor: false,
      lastCheckedAt: null,
      lastHeight: null,
      lastError: null,
      lastRoute: null,
    },
  });

  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, undoWindowHours: 12, identityToleranceCents: 500n },
    // Every column, not only the ones a test happens to read: this row survives
    // the truncate, so anything left out of here leaks into the next run.
    update: {
      undoWindowHours: 12,
      identityToleranceCents: 500n,
      goLiveAt: null,
      // The product default. Left out of this list once already, which leaked a
      // cadence from one test into the next and made the suggestion in the
      // following test wrong for reasons nothing in it explained.
      payCadence: 'biweekly',
      remoteOverTorEnabled: false,
      remoteOverTorEnabledAt: null,
      // Null is the product default: follow SCHEDULE_TIMEZONE. A zone left here
      // from a previous file would move every schedule in the next one.
      scheduleTimezone: null,
      bitcoinInBudgetAckAt: null,
      simplefinAccessUrlEncrypted: null,
      simplefinConnectedAt: null,
    },
  });
}

export async function makeUser(username = 'owner'): Promise<{ id: string }> {
  return prisma.user.create({
    // Not a real hash: nothing in these tests authenticates.
    data: { username, passwordHash: 'test-only-not-a-hash', role: 'super_admin' },
    select: { id: true },
  });
}

export interface MakeAccountOptions {
  readonly name: string;
  readonly type: AccountType;
  readonly balanceCents: bigint;
  readonly inBudget?: boolean;
  readonly inNetWorth?: boolean;
  readonly stalenessIntervalDays?: number | null;
  readonly balanceAsOf?: Date | null;
  /**
   * When the account came into existence. Snapshot rebuilds skip a date before
   * this, because an account that did not exist has no balance to reconstruct.
   */
  readonly createdAt?: Date;
}

export async function makeAccount(options: MakeAccountOptions): Promise<{ id: string }> {
  return prisma.account.create({
    data: {
      name: options.name,
      type: options.type,
      source: 'manual',
      balanceCents: options.balanceCents,
      inBudget: options.inBudget ?? true,
      inNetWorth: options.inNetWorth ?? true,
      stalenessIntervalDays: options.stalenessIntervalDays ?? null,
      balanceAsOf: options.balanceAsOf ?? new Date('2026-08-01T00:00:00Z'),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
    select: { id: true },
  });
}

export interface MakeDelegationOptions {
  readonly name: string;
  readonly amountToDelegateCents?: bigint | null;
  readonly isUtility?: boolean;
  readonly groupingId?: string | null;
  readonly notes?: string | null;
  /** As for an account: a rebuild skips a date before the line existed. */
  readonly createdAt?: Date;
}

/**
 * Creates a delegation with a zero balance. Balances are always established by
 * writing events, never by setting the column — a test that seeds
 * `balanceCents` directly would pass while the ledger disagreed, which is exactly
 * the bug these tests exist to catch.
 */
export async function makeDelegation(options: MakeDelegationOptions): Promise<{ id: string }> {
  return prisma.delegation.create({
    data: {
      name: options.name,
      amountToDelegateCents: options.amountToDelegateCents ?? null,
      isUtility: options.isUtility ?? false,
      groupingId: options.groupingId ?? null,
      notes: options.notes ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
    select: { id: true },
  });
}

export interface MakeTransactionOptions {
  readonly accountId: string;
  readonly amountCents: bigint;
  readonly description?: string;
  readonly postedAt?: Date;
  readonly pending?: boolean;
  readonly kind?: TransactionKind;
}

export async function makeTransaction(options: MakeTransactionOptions): Promise<{ id: string }> {
  const description = options.description ?? 'Test transaction';
  return prisma.transaction.create({
    data: {
      accountId: options.accountId,
      amountCents: options.amountCents,
      description,
      descriptionRaw: description,
      postedAt: options.postedAt ?? new Date('2026-08-05T00:00:00Z'),
      pending: options.pending ?? false,
      kind: options.kind ?? 'normal',
      source: 'manual',
    },
    select: { id: true },
  });
}

export async function delegationBalance(delegationId: string): Promise<bigint> {
  const row = await prisma.delegation.findUniqueOrThrow({
    where: { id: delegationId },
    select: { balanceCents: true },
  });
  return row.balanceCents;
}

export async function accountBalance(accountId: string): Promise<bigint> {
  const row = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { balanceCents: true },
  });
  return row.balanceCents;
}

/**
 * The independent check: every cached balance recomputed straight from the event
 * stream. Assertions compare this to the cached column, so a cache that drifts
 * fails the test rather than hiding behind it.
 */
export async function ledgerBalances(): Promise<Map<string, bigint>> {
  const rows = await prisma.delegationEvent.groupBy({
    by: ['delegationId'],
    where: { reversedAt: null },
    _sum: { deltaCents: true },
  });
  return new Map(rows.map((row) => [row.delegationId, row._sum.deltaCents ?? 0n]));
}

export interface MakeHoldingOptions {
  readonly name: string;
  readonly sats: bigint;
  /** When it started being held. Defaults to well before any test window. */
  readonly heldSince?: Date;
  readonly inBudget?: boolean;
  readonly inNetWorth?: boolean;
  /** What one whole Bitcoin cost, for cost-basis assertions. */
  readonly priceCents?: bigint;
  /** As for an account: a rebuild skips a date before the holding existed. */
  readonly createdAt?: Date;
}

/**
 * A Bitcoin holding with its opening event, which is the only way one exists.
 *
 * Writing `bitcoin_sats` straight onto an account leaves the cache and the
 * ledger disagreeing, and the net worth chart reads the ledger — so a holding
 * made that way is held on no date at all.
 */
export async function makeHolding(options: MakeHoldingOptions): Promise<{ id: string }> {
  const heldSince = options.heldSince ?? new Date('2020-01-01T00:00:00Z');

  const account = await prisma.account.create({
    data: {
      name: options.name,
      type: 'asset',
      source: 'manual',
      managedAs: 'bitcoin',
      bitcoinSats: options.sats,
      balanceCents: 0n,
      inBudget: options.inBudget ?? false,
      inNetWorth: options.inNetWorth ?? true,
      balanceAsOf: heldSince,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
    select: { id: true },
  });

  await prisma.bitcoinHoldingEvent.create({
    data: {
      accountId: account.id,
      occurredAt: new Date(
        Date.UTC(heldSince.getUTCFullYear(), heldSince.getUTCMonth(), heldSince.getUTCDate()),
      ),
      deltaSats: options.sats,
      eventType: options.priceCents === undefined ? 'opening' : 'purchase',
      priceCents: options.priceCents ?? null,
    },
  });

  return account;
}

/**
 * Marks every account as having finished two-factor enrolment.
 *
 * A second factor is required of everyone and there is no setting that changes
 * that, so a test signing in without one is refused from every route under
 * `AUTHENTICATED` — which is nearly all of them. Setting the columns directly
 * rather than walking the enrolment flow keeps that out of tests that are not
 * about it; `totp.test.ts` exercises the real thing.
 *
 * Called after signing in, never before: sign-in demands a code the moment an
 * account has a confirmed factor, so enrolling first would lock the test out of
 * its own session.
 */
export async function markTwoFactorEnrolled(): Promise<void> {
  await prisma.user.updateMany({
    data: {
      // Not a real secret and never verified against — no test in this file's
      // callers presents a code.
      totpSecretEncrypted: 'test-only-not-a-real-secret',
      totpConfirmedAt: new Date(),
    },
  });
}
