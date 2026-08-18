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
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      delegation_events,
      transaction_allocations,
      delegation_transfers,
      delegate_runs,
      transactions,
      categorization_rules,
      account_valuations,
      accounts,
      delegations,
      groupings,
      sessions,
      users,
      sync_runs,
      bitcoin_prices
    RESTART IDENTITY CASCADE
  `);
  // budget_settings is a pinned singleton, so it is reset in place rather than
  // truncated — a missing row would make every settings read fall back to
  // defaults and quietly change what the tests are asserting.
  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, undoWindowHours: 12, identityToleranceCents: 500n },
    // Every column, not only the ones a test happens to read: this row survives
    // the truncate, so anything left out of here leaks into the next run.
    update: {
      undoWindowHours: 12,
      identityToleranceCents: 500n,
      goLiveAt: null,
      // Off here even though the product default is on: almost every test signs
      // in without a second factor, and the requirement would 403 them out of
      // the subject under test. The tests that are *about* the requirement turn
      // it on themselves.
      requireTotp: false,
      remoteOverTorEnabled: false,
      remoteOverTorEnabledAt: null,
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
