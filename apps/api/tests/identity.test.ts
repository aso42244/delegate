/**
 * The identity is sacred.
 *
 *   SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)
 *
 * Every mutating operation in the system is exercised here, and after each one
 * two things are asserted: that the identity reads what it should, and that the
 * cached delegation balances still agree with the event ledger.
 *
 * The identity is not invariant, and tests that asserted it never moved would be
 * asserting the wrong thing. It moves in specific, meaningful ways:
 *
 *   * A paycheck lands            → positive. That is the "to delegate" figure.
 *   * Delegate distributes it     → back toward zero.
 *   * A spend imports             → negative by the spend, until categorized.
 *   * Categorizing it             → back to zero.
 *   * An envelope transfer        → unchanged. No real money moved.
 *   * A manual adjustment         → moves by exactly the delta, on purpose.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { applyTransactionToAccountBalance } from '../src/domain/accounts.js';
import { adjustDelegationByDelta, adjustDelegationToTarget } from '../src/domain/adjust.js';
import {
  categorizeTransaction,
  clearAllocations,
  setAllocations,
  splitTransactionEvenly,
} from '../src/domain/allocations.js';
import { archiveDelegation } from '../src/domain/archive.js';
import {
  currentCycleStart,
  previewDelegate,
  previewUndoLatestDelegate,
  runDelegate,
  undoDelegateRun,
} from '../src/domain/delegate.js';
import { ConflictError, ValidationError } from '../src/domain/errors.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { recomputeAllBalances } from '../src/domain/ledger.js';
import {
  carryPendingCategorizationToPosted,
  findPostedMatchesForPending,
  reversePendingTransaction,
} from '../src/domain/pending.js';
import {
  accountBalance,
  delegationBalance,
  ledgerBalances,
  makeAccount,
  makeDelegation,
  makeTransaction,
  makeUser,
  resetDatabase,
} from './helpers.js';

/** Asserts the cache and the ledger agree, without mutating anything. */
async function expectCacheMatchesLedger(): Promise<void> {
  const cached = await prisma.delegation.findMany({
    select: { id: true, name: true, balanceCents: true },
  });
  const ledger = await ledgerBalances();

  for (const delegation of cached) {
    expect(
      ledger.get(delegation.id) ?? 0n,
      `cached balance for "${delegation.name}" disagrees with its event ledger`,
    ).toBe(delegation.balanceCents);
  }
}

async function identityDifference(): Promise<bigint> {
  const result = await computeBudgetIdentity(prisma);
  return result.differenceCents;
}

let actorId: string;

beforeEach(async () => {
  await resetDatabase();
  const user = await makeUser();
  actorId = user.id;
});

describe('the identity at rest', () => {
  it('is zero on an empty budget', async () => {
    const result = await computeBudgetIdentity(prisma);
    expect(result.differenceCents).toBe(0n);
    expect(result.status).toBe('balanced');
  });

  it('ignores off-budget accounts entirely', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 500_000n,
      actorId,
    });
    expect(await identityDifference()).toBe(0n);

    // The house and the mortgage are net-worth-only. Adding a $420,000 asset and
    // a $310,000 debt off-budget must not move the identity by a cent — this is
    // the entire reason in_budget and in_net_worth are separate booleans.
    await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 42_000_000n,
      inBudget: false,
      inNetWorth: true,
    });
    await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 31_000_000n,
      inBudget: false,
      inNetWorth: true,
    });

    expect(await identityDifference()).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('subtracts in-budget debts', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 500_000n });
    await makeAccount({ name: 'Card', type: 'debt', balanceCents: 120_000n });
    // 5000 − 1200 − 0 = 3800 available to delegate.
    expect(await identityDifference()).toBe(380_000n);
  });
});

describe('delegate', () => {
  it('drives a landed paycheck back to balanced, then undo restores it', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 489_000n });
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 300_000n });
    await makeDelegation({ name: 'Utilities', amountToDelegateCents: 189_000n });
    // Null is not zero: an ad hoc line receives nothing.
    const adHoc = await makeDelegation({ name: 'Ad Hoc', amountToDelegateCents: null });

    const before = await computeBudgetIdentity(prisma);
    expect(before.differenceCents).toBe(489_000n);
    expect(before.status).toBe('to_delegate');

    const preview = await previewDelegate(prisma);
    expect(preview.lineCount).toBe(2);
    expect(preview.totalCents).toBe(489_000n);

    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));
    expect(run.lineCount).toBe(2);

    const after = await computeBudgetIdentity(prisma);
    expect(after.differenceCents).toBe(0n);
    expect(after.status).toBe('balanced');
    expect(await delegationBalance(adHoc.id)).toBe(0n);
    await expectCacheMatchesLedger();

    // Undo puts the money back on the bottom row, exactly.
    await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));
    expect(await identityDifference()).toBe(489_000n);
    expect(await delegationBalance(adHoc.id)).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('leaves interim work untouched when undone', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 200_000n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 100_000n });
    const gas = await makeDelegation({ name: 'Gas', amountToDelegateCents: 100_000n });

    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));

    // Between the Delegate press and the undo, real work happens: a spend is
    // categorized and an envelope is topped up by hand. Undo must reverse the
    // Delegate batch and nothing else.
    const spend = await makeTransaction({
      accountId: await firstAccountId(),
      amountCents: -25_000n,
    });
    await prisma.$transaction(async (tx) => {
      await applyTransactionToAccountBalance(tx, await firstAccountId(), -25_000n, new Date());
      await categorizeTransaction(tx, spend.id, grocery.id, { actorId });
    });
    await adjustDelegationByDelta(prisma, { delegationId: gas.id, deltaCents: 5_000n, actorId });

    expect(await delegationBalance(grocery.id)).toBe(75_000n);
    expect(await delegationBalance(gas.id)).toBe(105_000n);

    await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));

    // The $1,000 delegated to each line is gone; the −$250 categorization and the
    // +$50 adjustment survive.
    expect(await delegationBalance(grocery.id)).toBe(-25_000n);
    expect(await delegationBalance(gas.id)).toBe(5_000n);
    await expectCacheMatchesLedger();
  });

  it('rolls the cycle boundary back to the previous run', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 400_000n });
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 100_000n });

    const first = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));
    const firstRun = await prisma.delegateRun.findUniqueOrThrow({ where: { id: first.runId } });

    const second = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));
    const secondRun = await prisma.delegateRun.findUniqueOrThrow({ where: { id: second.runId } });

    expect(await currentCycleStart(prisma)).toEqual(secondRun.createdAt);

    const preview = await previewUndoLatestDelegate(prisma);
    expect(preview?.runId).toBe(second.runId);
    expect(preview?.cycleStartAfterUndo).toEqual(firstRun.createdAt);

    await prisma.$transaction((tx) => undoDelegateRun(tx, second.runId));
    expect(await currentCycleStart(prisma)).toEqual(firstRun.createdAt);
  });

  it('refuses to undo twice, or after the window closes', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 100_000n });
    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));

    await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));
    await expect(prisma.$transaction((tx) => undoDelegateRun(tx, run.runId))).rejects.toThrow(
      ConflictError,
    );

    const later = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));
    const thirteenHoursLater = new Date(Date.now() + 13 * 60 * 60 * 1000);
    await expect(
      prisma.$transaction((tx) => undoDelegateRun(tx, later.runId, { now: thirteenHoursLater })),
    ).rejects.toThrow(/undo window/i);

    // A rejected undo must leave the balance exactly as it was.
    expect(await identityDifference()).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('reverses a delegate batch idempotently', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 100_000n });
    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));

    const first = await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));
    expect(first.reversedCount).toBe(1);
    expect(await delegationBalance(grocery.id)).toBe(0n);
    await expectCacheMatchesLedger();
  });
});

describe('transfer between envelopes', () => {
  it('does not move the identity, because no real money moved', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 200_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const gas = await makeDelegation({ name: 'Gas' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 200_000n,
      actorId,
    });
    expect(await identityDifference()).toBe(0n);

    const { transferBetweenDelegations } = await import('../src/domain/transfer.js');
    await prisma.$transaction((tx) =>
      transferBetweenDelegations(tx, {
        fromDelegationId: grocery.id,
        toDelegationId: gas.id,
        amountCents: 50_000n,
        actorId,
      }),
    );

    expect(await delegationBalance(grocery.id)).toBe(150_000n);
    expect(await delegationBalance(gas.id)).toBe(50_000n);
    expect(await identityDifference()).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('may take the source negative, which is allowed and intentional', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const gas = await makeDelegation({ name: 'Gas' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 100_000n,
      actorId,
    });

    const { transferBetweenDelegations } = await import('../src/domain/transfer.js');
    await prisma.$transaction((tx) =>
      transferBetweenDelegations(tx, {
        fromDelegationId: gas.id,
        toDelegationId: grocery.id,
        amountCents: 30_000n,
        actorId,
      }),
    );

    expect(await delegationBalance(gas.id)).toBe(-30_000n);
    expect(await delegationBalance(grocery.id)).toBe(130_000n);
    expect(await identityDifference()).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('writes no transaction row — an envelope transfer is not a journal entry', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const gas = await makeDelegation({ name: 'Gas' });

    const { transferBetweenDelegations } = await import('../src/domain/transfer.js');
    await prisma.$transaction((tx) =>
      transferBetweenDelegations(tx, {
        fromDelegationId: grocery.id,
        toDelegationId: gas.id,
        amountCents: 1_000n,
        actorId,
      }),
    );

    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.delegationTransfer.count()).toBe(1);
    // Both legs share a batch so the pair is recoverable as one action.
    const events = await prisma.delegationEvent.findMany({ where: { eventType: 'transfer' } });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.batchId)).size).toBe(1);
  });
});

describe('manual adjustment', () => {
  it('records a delta, not an absolute', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 65_000n,
      actorId,
    });

    // Editing $650 → $675 must write +$25, not a $675 absolute.
    const result = await adjustDelegationToTarget(prisma, {
      delegationId: grocery.id,
      targetBalanceCents: 67_500n,
      actorId,
    });
    expect(result?.deltaCents).toBe(2_500n);
    expect(await delegationBalance(grocery.id)).toBe(67_500n);

    const deltas = await prisma.delegationEvent.findMany({
      where: { delegationId: grocery.id, eventType: 'adjust' },
      orderBy: { createdAt: 'asc' },
      select: { deltaCents: true },
    });
    expect(deltas.map((event) => event.deltaCents)).toEqual([65_000n, 2_500n]);
    await expectCacheMatchesLedger();
  });

  it('writes nothing when the line already reads the target', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const result = await adjustDelegationToTarget(prisma, {
      delegationId: grocery.id,
      targetBalanceCents: 0n,
      actorId,
    });
    expect(result).toBeNull();
    expect(await prisma.delegationEvent.count()).toBe(0);
  });

  it('moves the identity by exactly the delta', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    expect(await identityDifference()).toBe(100_000n);

    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 40_000n,
      actorId,
    });
    expect(await identityDifference()).toBe(60_000n);
    await expectCacheMatchesLedger();
  });

  it('never appears on the Transactions page', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, { delegationId: grocery.id, deltaCents: 1n, actorId });
    expect(await prisma.transaction.count()).toBe(0);
  });
});

describe('categorization', () => {
  it('drives the identity back to zero after a spend imports', async () => {
    const checking = await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 500_000n,
    });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 500_000n,
      actorId,
    });
    expect(await identityDifference()).toBe(0n);

    // The spend imports: the account is debited but nothing is categorized yet,
    // so the budget reads over-delegated by exactly the spend.
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -8_742n });
    await applyTransactionToAccountBalance(prisma, checking.id, -8_742n, new Date());
    expect(await identityDifference()).toBe(-8_742n);
    expect(await delegationBalance(grocery.id)).toBe(500_000n);

    await prisma.$transaction((tx) => categorizeTransaction(tx, spend.id, grocery.id, { actorId }));
    expect(await delegationBalance(grocery.id)).toBe(491_258n);
    expect(await identityDifference()).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('leaves an uncategorized transaction completely inert', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    await makeTransaction({ accountId: checking.id, amountCents: -5_000n });
    // No allocations, so no delegation moved. This is what makes importing a
    // 12-month backlog before building any rules safe.
    expect(await delegationBalance(grocery.id)).toBe(0n);
    expect(await prisma.delegationEvent.count()).toBe(0);
  });

  it('re-categorizing reverses the old effect rather than stacking on it', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const dining = await makeDelegation({ name: 'Dining' });

    const spend = await makeTransaction({ accountId: checking.id, amountCents: -4_000n });
    await prisma.$transaction((tx) => categorizeTransaction(tx, spend.id, grocery.id, { actorId }));
    expect(await delegationBalance(grocery.id)).toBe(-4_000n);

    await prisma.$transaction((tx) => categorizeTransaction(tx, spend.id, dining.id, { actorId }));
    expect(await delegationBalance(grocery.id)).toBe(0n);
    expect(await delegationBalance(dining.id)).toBe(-4_000n);

    // The original event survives, reversed — history is preserved, not erased.
    const events = await prisma.delegationEvent.findMany({
      where: { transactionId: spend.id },
      select: { delegationId: true, deltaCents: true, reversedAt: true },
    });
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.reversedAt !== null)).toHaveLength(1);
    await expectCacheMatchesLedger();
  });

  it('clearing allocations makes a transaction inert again', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -4_000n });

    await prisma.$transaction((tx) => categorizeTransaction(tx, spend.id, grocery.id, { actorId }));
    await prisma.$transaction((tx) => clearAllocations(tx, spend.id));

    expect(await delegationBalance(grocery.id)).toBe(0n);
    expect(await prisma.transactionAllocation.count()).toBe(0);
    await expectCacheMatchesLedger();
  });

  it('treats a refund as the mirror of a spend', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    const refund = await makeTransaction({ accountId: checking.id, amountCents: 3_500n });
    await applyTransactionToAccountBalance(prisma, checking.id, 3_500n, new Date());
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, refund.id, grocery.id, { actorId }),
    );

    expect(await accountBalance(checking.id)).toBe(103_500n);
    expect(await delegationBalance(grocery.id)).toBe(3_500n);
    expect(await identityDifference()).toBe(100_000n);
    await expectCacheMatchesLedger();
  });

  it('keeps the identity balanced for a card charge, where the debt rises', async () => {
    const card = await makeAccount({ name: 'Card', type: 'debt', balanceCents: 0n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 50_000n,
      actorId,
    });
    // Assets 0 − debts 0 − delegations 500 = −500 to start.
    expect(await identityDifference()).toBe(-50_000n);

    // A $75 charge raises what is owed and lowers the envelope. The two cancel,
    // so the identity is unchanged — this is the sign convention working.
    const charge = await makeTransaction({ accountId: card.id, amountCents: -7_500n });
    await applyTransactionToAccountBalance(prisma, card.id, -7_500n, new Date());
    expect(await accountBalance(card.id)).toBe(7_500n);

    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, charge.id, grocery.id, { actorId }),
    );
    expect(await delegationBalance(grocery.id)).toBe(42_500n);
    expect(await identityDifference()).toBe(-50_000n);
    await expectCacheMatchesLedger();
  });

  it('refuses allocations on income and on a confirmed pair', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    const paycheck = await makeTransaction({
      accountId: checking.id,
      amountCents: 489_000n,
      kind: 'income',
    });
    await expect(
      setAllocations(prisma, paycheck.id, [{ delegationId: grocery.id, amountCents: 489_000n }]),
    ).rejects.toThrow(ValidationError);

    const cardPayment = await makeTransaction({
      accountId: checking.id,
      amountCents: -20_000n,
      kind: 'transfer',
    });
    await expect(
      setAllocations(prisma, cardPayment.id, [{ delegationId: grocery.id, amountCents: -20_000n }]),
    ).rejects.toThrow(ValidationError);
  });

  it('reads a paycheck as money available to delegate, with no income machinery', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 0n });
    const paycheck = await makeTransaction({
      accountId: checking.id,
      amountCents: 489_000n,
      kind: 'income',
    });
    await applyTransactionToAccountBalance(prisma, checking.id, 489_000n, new Date());

    const result = await computeBudgetIdentity(prisma);
    expect(result.differenceCents).toBe(489_000n);
    expect(result.status).toBe('to_delegate');
    // Income allocates to nothing at all.
    expect(
      await prisma.transactionAllocation.count({ where: { transactionId: paycheck.id } }),
    ).toBe(0);
  });
});

describe('splits', () => {
  it('splits that do not divide evenly still sum to the transaction exactly', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const a = await makeDelegation({ name: 'Aaa' });
    const b = await makeDelegation({ name: 'Bbb' });
    const c = await makeDelegation({ name: 'Ccc' });

    // $100.00 across three lines: 33.34 / 33.33 / 33.33.
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -10_000n });
    await applyTransactionToAccountBalance(prisma, checking.id, -10_000n, new Date());
    await prisma.$transaction((tx) =>
      splitTransactionEvenly(tx, spend.id, [a.id, b.id, c.id], { actorId }),
    );

    expect(await delegationBalance(a.id)).toBe(-3_334n);
    expect(await delegationBalance(b.id)).toBe(-3_333n);
    expect(await delegationBalance(c.id)).toBe(-3_333n);

    const allocations = await prisma.transactionAllocation.findMany({
      where: { transactionId: spend.id },
      select: { amountCents: true },
    });
    const total = allocations.reduce((sum, row) => sum + row.amountCents, 0n);
    expect(total).toBe(-10_000n);

    // The three lines were never funded, so they now sum to −$100.00. Assets are
    // $900.00 and subtracting a negative delegation total adds it back:
    // 90000 − 0 − (−10000) = 100000. The budget is over-delegated by $1,000 —
    // correct, because $1,000 of envelope balances is owed against $900 of cash.
    expect(await identityDifference()).toBe(100_000n);
    await expectCacheMatchesLedger();
  });

  it('rejects a manual split that does not sum to the transaction', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const a = await makeDelegation({ name: 'Aaa' });
    const b = await makeDelegation({ name: 'Bbb' });
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -10_000n });

    await expect(
      setAllocations(prisma, spend.id, [
        { delegationId: a.id, amountCents: -5_000n },
        { delegationId: b.id, amountCents: -4_999n },
      ]),
    ).rejects.toThrow(/sum to exactly/);

    // A rejected split must leave nothing behind.
    expect(await prisma.transactionAllocation.count()).toBe(0);
    expect(await delegationBalance(a.id)).toBe(0n);
  });

  it('rejects the same delegation twice in one split', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const a = await makeDelegation({ name: 'Aaa' });
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -10_000n });

    await expect(
      setAllocations(prisma, spend.id, [
        { delegationId: a.id, amountCents: -5_000n },
        { delegationId: a.id, amountCents: -5_000n },
      ]),
    ).rejects.toThrow(/same delegation twice/);
  });
});

describe('pending transactions', () => {
  it('affect envelopes immediately once categorized', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });

    const pending = await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      pending: true,
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, pending.id, grocery.id, { actorId }),
    );

    expect(await delegationBalance(grocery.id)).toBe(-6_000n);
    await expectCacheMatchesLedger();
  });

  it('charge the envelope exactly once when the pending row posts', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 100_000n,
      actorId,
    });

    const pending = await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      pending: true,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, pending.id, grocery.id, { actorId }),
    );

    // The envelope is down; the account is not, because the institution reports
    // its settled balance and this charge has not settled. The identity holds
    // anyway, which is what the pending term is for.
    expect(await delegationBalance(grocery.id)).toBe(94_000n);
    expect(await accountBalance(checking.id)).toBe(100_000n);
    expect(await identityDifference()).toBe(0n);

    // The settled row arrives on the next sync as its own record, and the
    // institution's balance moves with it.
    const posted = await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      pending: false,
      postedAt: new Date('2026-08-03T00:00:00Z'),
    });
    await applyTransactionToAccountBalance(prisma, checking.id, -6_000n, new Date());

    const matches = await findPostedMatchesForPending(prisma);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.pendingTransactionId).toBe(pending.id);
    expect(matches[0]?.postedTransactionId).toBe(posted.id);

    await prisma.$transaction((tx) =>
      carryPendingCategorizationToPosted(tx, pending.id, posted.id, { actorId }),
    );

    // Charged once, not twice. The categorization moved, the balance did not.
    expect(await delegationBalance(grocery.id)).toBe(94_000n);
    expect(await identityDifference()).toBe(0n);

    const retired = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(retired.archivedAt).not.toBeNull();
    expect(retired.pending).toBe(false);

    const liveAllocations = await prisma.transactionAllocation.findMany({
      select: { transactionId: true },
    });
    expect(liveAllocations).toEqual([{ transactionId: posted.id }]);
    await expectCacheMatchesLedger();
  });

  it('do not offer money that a pending charge has already spent', async () => {
    // Reported from real data: exactly balanced, then a card charge went
    // pending. Categorizing it emptied the envelope by $361.47 while the card's
    // reported balance stayed where it was, and the page offered that $361.47 to
    // delegate a second time.
    await makeAccount({ name: 'Frontier Checking', type: 'asset', balanceCents: 15_298_29n });
    const card = await makeAccount({
      name: 'Costco Citi VISA',
      type: 'debt',
      balanceCents: 5_015_37n,
    });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 10_282_92n,
      actorId,
    });
    expect(await identityDifference()).toBe(0n);

    const pending = await makeTransaction({
      accountId: card.id,
      amountCents: -361_47n,
      pending: true,
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, pending.id, grocery.id, { actorId }),
    );

    // Still balanced. Neither the checking balance nor the card balance moved.
    expect(await identityDifference()).toBe(0n);
    expect(await accountBalance(card.id)).toBe(5_015_37n);
    await expectCacheMatchesLedger();
  });

  it('are counted only once categorized, and only on in-budget accounts', async () => {
    const card = await makeAccount({ name: 'Card', type: 'debt', balanceCents: 0n });
    const offBudget = await makeAccount({
      name: 'Brokerage',
      type: 'asset',
      balanceCents: 0n,
      inBudget: false,
      inNetWorth: true,
    });
    const grocery = await makeDelegation({ name: 'Grocery' });

    // Uncategorized: neither side has moved, so there is nothing to correct.
    // Adjusting for it would turn a reconciliation into a forecast.
    await makeTransaction({ accountId: card.id, amountCents: -5_000n, pending: true });
    expect((await computeBudgetIdentity(prisma)).pendingCents).toBe(0n);
    expect(await identityDifference()).toBe(0n);

    // Off-budget: the first two terms never counted this account, so the third
    // must not either.
    const outside = await makeTransaction({
      accountId: offBudget.id,
      amountCents: -7_000n,
      pending: true,
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, outside.id, grocery.id, { actorId }),
    );
    expect((await computeBudgetIdentity(prisma)).pendingCents).toBe(0n);
  });

  it('back out completely when a pending row vanishes without posting', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 100_000n,
      actorId,
    });
    const balanceBefore = await delegationBalance(grocery.id);
    const identityBefore = await identityDifference();

    const pending = await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      pending: true,
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, pending.id, grocery.id, { actorId }),
    );
    expect(await delegationBalance(grocery.id)).toBe(94_000n);

    // The hold dropped off. The money never left, so the envelope must read
    // exactly what it read before the transaction ever appeared.
    await prisma.$transaction((tx) => reversePendingTransaction(tx, pending.id));

    expect(await delegationBalance(grocery.id)).toBe(balanceBefore);
    expect(await identityDifference()).toBe(identityBefore);

    const archived = await prisma.transaction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(archived.archivedAt).not.toBeNull();
    await expectCacheMatchesLedger();
  });

  it('reversal is idempotent, so a retried sync cannot double-credit', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const pending = await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      pending: true,
    });
    await prisma.$transaction((tx) =>
      categorizeTransaction(tx, pending.id, grocery.id, { actorId }),
    );

    await prisma.$transaction((tx) => reversePendingTransaction(tx, pending.id));
    const afterFirst = await delegationBalance(grocery.id);
    await prisma.$transaction((tx) => reversePendingTransaction(tx, pending.id));

    expect(await delegationBalance(grocery.id)).toBe(afterFirst);
    expect(afterFirst).toBe(0n);
    await expectCacheMatchesLedger();
  });

  it('does not pair a settlement whose amount changed', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await makeTransaction({
      accountId: checking.id,
      amountCents: -5_000n,
      pending: true,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    // A tip added at settlement: same merchant, different amount. Pairing these
    // would corrupt an envelope, so they stay separate and surface for review.
    await makeTransaction({
      accountId: checking.id,
      amountCents: -6_000n,
      postedAt: new Date('2026-08-02T00:00:00Z'),
    });

    expect(await findPostedMatchesForPending(prisma)).toEqual([]);
  });

  it('does not pair outside the date window', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    await makeTransaction({
      accountId: checking.id,
      amountCents: -5_000n,
      pending: true,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: checking.id,
      amountCents: -5_000n,
      postedAt: new Date('2026-08-20T00:00:00Z'),
    });

    expect(await findPostedMatchesForPending(prisma)).toEqual([]);
  });
});

describe('archiving', () => {
  it('is blocked unless the balance is exactly zero', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, { delegationId: grocery.id, deltaCents: 1n, actorId });

    // One cent is enough to block it: archiving with money in the line would
    // break the identity by exactly that amount.
    await expect(archiveDelegation(prisma, grocery.id)).rejects.toThrow(ConflictError);
    await expect(archiveDelegation(prisma, grocery.id)).rejects.toThrow(/\$0\.01/);

    await adjustDelegationToTarget(prisma, {
      delegationId: grocery.id,
      targetBalanceCents: 0n,
      actorId,
    });
    await archiveDelegation(prisma, grocery.id);

    const archived = await prisma.delegation.findUniqueOrThrow({ where: { id: grocery.id } });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('does not move the identity, and leaves history resolvable', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100_000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const spend = await makeTransaction({ accountId: checking.id, amountCents: -4_000n });
    await prisma.$transaction((tx) => categorizeTransaction(tx, spend.id, grocery.id, { actorId }));

    // Zero the line the way the owner would, then archive it.
    await adjustDelegationToTarget(prisma, {
      delegationId: grocery.id,
      targetBalanceCents: 0n,
      actorId,
    });
    const before = await identityDifference();
    await archiveDelegation(prisma, grocery.id);
    expect(await identityDifference()).toBe(before);

    // The eight-month-old transaction still resolves its delegation by name.
    const allocation = await prisma.transactionAllocation.findFirstOrThrow({
      where: { transactionId: spend.id },
      select: { delegation: { select: { name: true, archivedAt: true } } },
    });
    expect(allocation.delegation.name).toBe('Grocery');
    expect(allocation.delegation.archivedAt).not.toBeNull();
    await expectCacheMatchesLedger();
  });

  it('refuses new events against an archived line', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await archiveDelegation(prisma, grocery.id);

    await expect(
      adjustDelegationByDelta(prisma, { delegationId: grocery.id, deltaCents: 100n, actorId }),
    ).rejects.toThrow(/archived/);
  });
});

describe('cache and ledger', () => {
  it('agree after a long mixed sequence of operations', async () => {
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 800_000n });
    const card = await makeAccount({ name: 'Card', type: 'debt', balanceCents: 0n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 40_000n });
    const gas = await makeDelegation({ name: 'Gas', amountToDelegateCents: 20_000n });
    const utilities = await makeDelegation({ name: 'Utilities', amountToDelegateCents: 12_000n });
    const adHoc = await makeDelegation({ name: 'Ad Hoc', amountToDelegateCents: null });

    const { transferBetweenDelegations } = await import('../src/domain/transfer.js');

    const run = await prisma.$transaction((tx) => runDelegate(tx, { actorId }));

    const spendA = await makeTransaction({ accountId: checking.id, amountCents: -8_733n });
    const spendB = await makeTransaction({ accountId: card.id, amountCents: -4_101n });
    const refund = await makeTransaction({ accountId: checking.id, amountCents: 1_299n });
    const pending = await makeTransaction({
      accountId: checking.id,
      amountCents: -2_500n,
      pending: true,
    });

    await prisma.$transaction(async (tx) => {
      await applyTransactionToAccountBalance(tx, checking.id, -8_733n, new Date());
      await applyTransactionToAccountBalance(tx, card.id, -4_101n, new Date());
      await applyTransactionToAccountBalance(tx, checking.id, 1_299n, new Date());
      await applyTransactionToAccountBalance(tx, checking.id, -2_500n, new Date());

      await splitTransactionEvenly(tx, spendA.id, [grocery.id, gas.id, utilities.id], { actorId });
      await categorizeTransaction(tx, spendB.id, grocery.id, { actorId });
      await categorizeTransaction(tx, refund.id, grocery.id, { actorId });
      await categorizeTransaction(tx, pending.id, adHoc.id, { actorId });
    });

    await prisma.$transaction((tx) =>
      transferBetweenDelegations(tx, {
        fromDelegationId: grocery.id,
        toDelegationId: gas.id,
        amountCents: 7_777n,
        actorId,
      }),
    );
    await adjustDelegationByDelta(prisma, {
      delegationId: utilities.id,
      deltaCents: -3_333n,
      actorId,
    });
    await prisma.$transaction((tx) => reversePendingTransaction(tx, pending.id));
    await prisma.$transaction((tx) => categorizeTransaction(tx, spendB.id, gas.id, { actorId }));
    await prisma.$transaction((tx) => undoDelegateRun(tx, run.runId));

    await expectCacheMatchesLedger();

    // recompute must find nothing to correct — the cache was maintained
    // transactionally the whole way through.
    const result = await prisma.$transaction((tx) => recomputeAllBalances(tx));
    expect(result.corrections).toEqual([]);
    expect(result.corrected).toBe(0);
    expect(result.checked).toBe(4);
  });

  it('recompute repairs a cache that has been corrupted out of band', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await adjustDelegationByDelta(prisma, {
      delegationId: grocery.id,
      deltaCents: 72_500n,
      actorId,
    });

    // Simulate the damage a bad manual UPDATE would do.
    await prisma.delegation.update({
      where: { id: grocery.id },
      data: { balanceCents: 999_999n },
    });

    const result = await prisma.$transaction((tx) => recomputeAllBalances(tx));
    expect(result.corrected).toBe(1);
    expect(result.corrections[0]).toMatchObject({
      name: 'Grocery',
      cachedCents: 999_999n,
      actualCents: 72_500n,
    });
    expect(await delegationBalance(grocery.id)).toBe(72_500n);
    await expectCacheMatchesLedger();
  });
});

describe('go-live reconciliation', () => {
  it('corrects sixty lines in one commit', async () => {
    const checking = await makeAccount({
      name: 'Checking',
      type: 'asset',
      balanceCents: 4_350_000n,
    });

    // Twelve months of categorized backfill has driven every line negative.
    const lines: Array<{ id: string; actual: bigint }> = [];
    for (let index = 0; index < 60; index += 1) {
      const delegation = await makeDelegation({ name: `Line ${String(index).padStart(2, '0')}` });
      await adjustDelegationByDelta(prisma, {
        delegationId: delegation.id,
        deltaCents: -900_000n - BigInt(index),
        actorId,
      });
      lines.push({ id: delegation.id, actual: 72_500n + BigInt(index) });
    }

    const { reconcileToActual } = await import('../src/domain/adjust.js');
    const goLiveAt = new Date('2026-08-08T00:00:00Z');
    const result = await prisma.$transaction((tx) =>
      reconcileToActual(
        tx,
        lines.map((line) => ({ delegationId: line.id, actualBalanceCents: line.actual })),
        { actorId, goLiveAt },
      ),
    );

    expect(result.adjustedCount).toBe(60);
    expect(result.unchangedCount).toBe(0);

    // One batch for the whole reconciliation, so it is one identifiable action.
    const batches = await prisma.delegationEvent.findMany({
      where: { batchId: result.batchId },
      select: { id: true },
    });
    expect(batches).toHaveLength(60);

    for (const line of lines) {
      expect(await delegationBalance(line.id)).toBe(line.actual);
    }

    const settings = await prisma.budgetSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(settings.goLiveAt).toEqual(goLiveAt);

    // 43,500.00 assets − 0 debts − sum(actuals) is the residual drift the owner
    // sees on the bottom row after reconciling. It must be exact, not approximate.
    const expectedDelegations = lines.reduce((sum, line) => sum + line.actual, 0n);
    expect(await identityDifference()).toBe(4_350_000n - expectedDelegations);
    expect(await accountBalance(checking.id)).toBe(4_350_000n);
    await expectCacheMatchesLedger();
  });

  it('skips lines that already read their actual', async () => {
    const a = await makeDelegation({ name: 'Aaa' });
    const b = await makeDelegation({ name: 'Bbb' });
    await adjustDelegationByDelta(prisma, { delegationId: a.id, deltaCents: 5_000n, actorId });

    const { reconcileToActual } = await import('../src/domain/adjust.js');
    const result = await prisma.$transaction((tx) =>
      reconcileToActual(tx, [
        { delegationId: a.id, actualBalanceCents: 5_000n },
        { delegationId: b.id, actualBalanceCents: 1_000n },
      ]),
    );

    expect(result.adjustedCount).toBe(1);
    expect(result.unchangedCount).toBe(1);
  });
});

/** The single seeded account, for tests that only ever create one. */
async function firstAccountId(): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
  return account.id;
}
