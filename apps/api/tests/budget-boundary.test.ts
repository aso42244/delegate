import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { buildNotifications } from '../src/domain/notifications.js';
import { confirmPair, findPairCandidates } from '../src/domain/pairing.js';
import { listTransactions } from '../src/domain/transactions.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  makeUser,
  resetDatabase,
} from './helpers.js';

/**
 * The budget boundary.
 *
 * `in_budget` decides which accounts the identity sums. Everything here follows
 * from that one fact: a row on an account the identity does not sum cannot move
 * a delegation without putting the reading out by the full amount.
 *
 * Found when a Roth IRA's contribution and the four ETF purchases it paid for
 * arrived in the register — five rows in the queue that could never be closed,
 * and a transfer suggestion that would have undone a correct categorization.
 */

const NOW = new Date('2026-08-27T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

async function budgetAndIra(): Promise<{ checking: string; ira: string }> {
  const checking = await makeAccount({
    name: 'Plains Commerce Checking',
    type: 'asset',
    balanceCents: 100000n,
    inBudget: true,
  });
  const ira = await makeAccount({
    name: 'Fidelity Investments ROTH IRA',
    type: 'asset',
    balanceCents: 500000n,
    inBudget: false,
    inNetWorth: true,
  });
  return { checking: checking.id, ira: ira.id };
}

describe('categorizing across the boundary', () => {
  it('is refused, because it would move the reading by the whole amount', async () => {
    const { ira } = await budgetAndIra();
    const line = await makeDelegation({ name: 'Andy Roth' });
    const actor = await makeUser('owner');
    const buy = await makeTransaction({
      accountId: ira,
      amountCents: 20000n,
      description: 'PURCHASE INTO CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET',
      postedAt: NOW,
    });

    const before = await computeBudgetIdentity(prisma);
    await expect(
      categorizeTransaction(prisma, buy.id, line.id, { actorId: actor.id }),
    ).rejects.toThrow(/not in the budget/);

    // Refused, and nothing moved.
    expect((await computeBudgetIdentity(prisma)).differenceCents).toBe(before.differenceCents);
  });

  it('still allows an in-budget row on the other side of the same movement', async () => {
    const { checking } = await budgetAndIra();
    const line = await makeDelegation({ name: 'Andy Roth' });
    const actor = await makeUser('owner');
    await prisma.delegation.update({ where: { id: line.id }, data: { balanceCents: 20000n } });

    const out = await makeTransaction({
      accountId: checking,
      amountCents: -20000n,
      description: 'ACH Payment FID BKG SVC LLC MONEYLINE',
      postedAt: NOW,
    });

    await categorizeTransaction(prisma, out.id, line.id, { actorId: actor.id });

    // The envelope empties and the balance has already gone: the two cancel,
    // which is what makes this the correct place to record the contribution.
    const line2 = await prisma.delegation.findUniqueOrThrow({ where: { id: line.id } });
    expect(line2.balanceCents).toBe(0n);
  });
});

describe('pairing across the boundary', () => {
  it('is not suggested', async () => {
    const { checking, ira } = await budgetAndIra();
    await makeTransaction({
      accountId: checking,
      amountCents: -20000n,
      description: 'ACH Payment FID BKG SVC LLC MONEYLINE',
      postedAt: NOW,
    });
    await makeTransaction({
      accountId: ira,
      amountCents: 20000n,
      description: 'PURCHASE INTO CORE ACCOUNT',
      postedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    });

    expect(await findPairCandidates(prisma, NOW)).toHaveLength(0);
  });

  it('is refused by the route as well, so a stale page cannot do it', async () => {
    const { checking, ira } = await budgetAndIra();
    const out = await makeTransaction({
      accountId: checking,
      amountCents: -20000n,
      description: 'ACH Payment FID BKG SVC LLC MONEYLINE',
      postedAt: NOW,
    });
    const into = await makeTransaction({
      accountId: ira,
      amountCents: 20000n,
      description: 'PURCHASE INTO CORE ACCOUNT',
      postedAt: NOW,
    });

    await expect(confirmPair(prisma, out.id, into.id)).rejects.toThrow(/not in the budget/);
  });

  /**
   * The specific harm. `confirmPair` clears both sides' allocations, so
   * confirming would take the money back out of the envelope it was spent from
   * while the balance stays gone.
   */
  it('would have undone a correct categorization', async () => {
    const { checking } = await budgetAndIra();
    const line = await makeDelegation({ name: 'Andy Roth' });
    const actor = await makeUser('owner');
    await prisma.delegation.update({ where: { id: line.id }, data: { balanceCents: 20000n } });
    const out = await makeTransaction({
      accountId: checking,
      amountCents: -20000n,
      description: 'ACH Payment FID BKG SVC LLC MONEYLINE',
      postedAt: NOW,
    });
    await categorizeTransaction(prisma, out.id, line.id, { actorId: actor.id });

    // Refused now — and this is the assertion that says why it matters.
    const settled = await computeBudgetIdentity(prisma);
    expect(settled.differenceCents).toBe(100000n - 0n);
    expect(
      (await prisma.delegation.findUniqueOrThrow({ where: { id: line.id } })).balanceCents,
    ).toBe(0n);
  });

  it('still pairs two accounts on the same side of it', async () => {
    const brokerage = await makeAccount({
      name: 'Fidelity Brokerage',
      type: 'asset',
      balanceCents: 100000n,
      inBudget: false,
      inNetWorth: true,
    });
    const ira = await makeAccount({
      name: 'Fidelity ROTH IRA',
      type: 'asset',
      balanceCents: 100000n,
      inBudget: false,
      inNetWorth: true,
    });
    await makeTransaction({
      accountId: brokerage.id,
      amountCents: -50000n,
      description: 'TRANSFER OUT',
      postedAt: NOW,
    });
    await makeTransaction({
      accountId: ira.id,
      amountCents: 50000n,
      description: 'TRANSFER IN',
      postedAt: NOW,
    });

    // Neither is in the identity, nothing that mattered is cleared, and a
    // transfer between two brokerage accounts is as much "not spending" as one
    // between two current accounts.
    expect(await findPairCandidates(prisma, NOW)).toHaveLength(1);
  });
});

describe('the uncategorized queue', () => {
  it('leaves out rows that could never be categorized', async () => {
    const { checking, ira } = await budgetAndIra();
    await makeTransaction({
      accountId: ira,
      amountCents: 1213n,
      description: 'YOU BOUGHT ISHARES BITCOIN TRUST ETF (IBIT)',
      postedAt: NOW,
    });
    await makeTransaction({
      accountId: ira,
      amountCents: 8787n,
      description: 'YOU BOUGHT BITWISE BITCOIN ETF TR SHS BEN INT (BITB)',
      postedAt: NOW,
    });
    await makeTransaction({
      accountId: checking,
      amountCents: -8481n,
      description: 'EXXON JHFS #152',
      postedAt: NOW,
    });

    const queue = await listTransactions(prisma, { uncategorized: true });
    expect(queue.total).toBe(1);
    expect(queue.transactions[0]!.description).toContain('EXXON');
  });

  it('is the same number the pill reports', async () => {
    const { checking, ira } = await budgetAndIra();
    for (const [accountId, amount] of [
      [ira, 1213n],
      [ira, 8787n],
      [checking, -8481n],
    ] as const) {
      await makeTransaction({
        accountId,
        amountCents: amount,
        description: 'Something',
        postedAt: NOW,
      });
    }

    const pill = (await buildNotifications(prisma, 'UTC', NOW)).find(
      (entry) => entry.kind === 'uncategorized_backlog',
    );
    // A pill that sends somebody to a list disagreeing with its own count is a
    // pill nobody can clear.
    expect(pill?.pill).toBe('1 new transaction');
  });

  it('still shows the rows in the register itself', async () => {
    const { ira } = await budgetAndIra();
    await makeTransaction({
      accountId: ira,
      amountCents: 1213n,
      description: 'YOU BOUGHT ISHARES BITCOIN TRUST ETF (IBIT)',
      postedAt: NOW,
    });

    // They leave the queue, not the journal: the register is where somebody
    // goes to see what an account actually did.
    expect((await listTransactions(prisma, {})).total).toBe(1);
  });
});
