import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { computeBudgetIdentity } from '../src/domain/identity.js';
import { buildBudgetView } from '../src/domain/budget.js';
import { standbyAdjustments } from '../src/domain/standby.js';
import { archiveTransaction, createManualTransaction } from '../src/domain/transactions.js';
import { runSync } from '../src/domain/sync.js';
import { accountBalance, makeDelegation, makeUser, resetDatabase } from './helpers.js';
import { accountSet, EPOCH_2026_08_01, ScriptedSimpleFinClient } from './simplefin-fixtures.js';

/**
 * Standby rows — what somebody types in while a feed is behind.
 *
 * The bug these exist for: entering a charge by hand on a synced account moved
 * `balance_cents`, and the next sync stamped the institution's figure straight
 * back over it. The entry appeared to work and then silently did not, an hour
 * later, with nothing on screen to say so. Found by the owner during a live
 * outage on two institutions.
 */

const NOW = new Date('2026-08-08T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

/** The bank says $12,733.23 settled, which is where the real case started. */
async function syncedChecking(): Promise<{ id: string; client: ScriptedSimpleFinClient }> {
  const payload = accountSet([
    { id: 'acct-1', name: 'Checking', balance: '12733.23', balanceDate: EPOCH_2026_08_01 },
  ]);
  const client = new ScriptedSimpleFinClient([payload, payload]);
  await runSync(prisma, { client, now: NOW });
  const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-1' } });
  return { id: account.id, client };
}

async function manualCash(): Promise<string> {
  const account = await prisma.account.create({
    data: {
      name: 'Physical Cash',
      type: 'asset',
      source: 'manual',
      balanceCents: 101200n,
      balanceAsOf: NOW,
    },
    select: { id: true },
  });
  return account.id;
}

describe('a hand-entered row on a synced account', () => {
  it('leaves the institution’s figure alone', async () => {
    const { id } = await syncedChecking();

    await createManualTransaction(prisma, {
      accountId: id,
      amountCents: -583n,
      description: 'MANUAL - Pirate Ship',
      postedAt: NOW,
    });

    // The stored column is still exactly what the bank said.
    expect(await accountBalance(id)).toBe(1273323n);
    expect((await standbyAdjustments(prisma)).get(id)).toBe(-583n);
  });

  /**
   * The original failure, end to end. Before this change the balance read
   * $14,195.32 for up to an hour and then reverted to $12,733.23 — which is
   * precisely what the owner saw on the Budget page.
   */
  it('survives the next sync, because the sync never touches it', async () => {
    const { id, client } = await syncedChecking();

    for (const [amount, description] of [
      [-583n, 'MANUAL - Pirate Ship'],
      [-814n, 'MANUAL - Pirate Ship'],
      [147606n, 'MANUAL - Income'],
    ] as const) {
      await createManualTransaction(prisma, {
        accountId: id,
        amountCents: amount,
        description,
        postedAt: NOW,
      });
    }

    const shown = async (): Promise<bigint> => {
      const view = await buildBudgetView(prisma, { timeZone: 'UTC', now: NOW });
      const row = view.assets.ungrouped.find((candidate) => candidate.id === id);
      return row!.balanceCents;
    };

    expect(await shown()).toBe(1419532n);

    await runSync(prisma, { client, now: new Date(NOW.getTime() + 60 * 60 * 1000) });

    expect(await shown()).toBe(1419532n);
    // …and the bank's own figure is still underneath it, untouched.
    expect(await accountBalance(id)).toBe(1273323n);
  });

  it('says on the row that the figure is part bank and part household', async () => {
    const { id } = await syncedChecking();
    await createManualTransaction(prisma, {
      accountId: id,
      amountCents: -583n,
      description: 'MANUAL - Pirate Ship',
      postedAt: NOW,
    });

    const view = await buildBudgetView(prisma, { timeZone: 'UTC', now: NOW });
    const row = view.assets.ungrouped.find((candidate) => candidate.id === id);
    expect(row!.standbyCents).toBe(-583n);
  });

  it('stops adjusting once the row is archived', async () => {
    const { id } = await syncedChecking();
    const created = await createManualTransaction(prisma, {
      accountId: id,
      amountCents: -583n,
      description: 'MANUAL - Pirate Ship',
      postedAt: NOW,
    });

    await archiveTransaction(prisma, created.id, NOW);

    expect((await standbyAdjustments(prisma)).get(id)).toBeUndefined();
    // Archiving must not back a figure out of a column it never wrote into.
    expect(await accountBalance(id)).toBe(1273323n);
  });

  it('raises a debt rather than lowering it', async () => {
    const payload = accountSet([
      { id: 'card-1', name: 'Credit Card', balance: '-500.00', balanceDate: EPOCH_2026_08_01 },
    ]);
    await runSync(prisma, { client: new ScriptedSimpleFinClient([payload]), now: NOW });
    const card = await prisma.account.findFirstOrThrow({ where: { externalId: 'card-1' } });
    expect(card.type).toBe('debt');

    await createManualTransaction(prisma, {
      accountId: card.id,
      amountCents: -4000n,
      description: 'MANUAL - Groceries',
      postedAt: NOW,
    });

    const view = await buildBudgetView(prisma, { timeZone: 'UTC', now: NOW });
    const row = view.debts.ungrouped.find((candidate) => candidate.id === card.id);
    // Debts are stored as positive magnitudes, so a $40 charge owes $40 more.
    expect(row!.balanceCents).toBe(54000n);
  });
});

describe('a hand-entered row on a manual account', () => {
  it('still moves the balance, because that is the only balance there is', async () => {
    const cash = await manualCash();

    const created = await createManualTransaction(prisma, {
      accountId: cash,
      amountCents: -2000n,
      description: 'Farmers market',
      postedAt: NOW,
    });

    expect(await accountBalance(cash)).toBe(99200n);
    // And it is not standby: nothing is going to report this account to us.
    expect((await standbyAdjustments(prisma)).get(cash)).toBeUndefined();

    await archiveTransaction(prisma, created.id, NOW);
    expect(await accountBalance(cash)).toBe(101200n);
  });
});

describe('the identity while rows are in standby', () => {
  /**
   * The reading at the top of the Budget page has to agree with the balances
   * underneath it. If it were computed from the stored columns while the rows
   * showed the adjusted figures, the equation on the chip would reconcile
   * against numbers nobody can see.
   */
  it('balances when the standby row has been categorized', async () => {
    const { id } = await syncedChecking();
    const grocery = await makeDelegation({ name: 'Grocery' });
    const actor = await makeUser('owner');

    // Start square: one delegation holding exactly the account's balance.
    await prisma.delegation.update({
      where: { id: grocery.id },
      data: { balanceCents: 1273323n },
    });
    expect((await computeBudgetIdentity(prisma)).differenceCents).toBe(0n);

    const created = await createManualTransaction(prisma, {
      accountId: id,
      amountCents: -4000n,
      description: 'MANUAL - Groceries',
      postedAt: NOW,
    });
    await categorizeTransaction(prisma, created.id, grocery.id, { actorId: actor.id });

    // Both sides moved by $40, so the reading is unchanged.
    expect((await computeBudgetIdentity(prisma)).differenceCents).toBe(0n);
  });

  it('reads as over-delegated while the standby row is uncategorized', async () => {
    const { id } = await syncedChecking();
    const grocery = await makeDelegation({ name: 'Grocery' });
    await prisma.delegation.update({
      where: { id: grocery.id },
      data: { balanceCents: 1273323n },
    });

    await createManualTransaction(prisma, {
      accountId: id,
      amountCents: -4000n,
      description: 'MANUAL - Groceries',
      postedAt: NOW,
    });

    // Money has left the account and no envelope has accounted for it — the
    // same thing any uncategorized spending reads as until it is filed.
    expect((await computeBudgetIdentity(prisma)).differenceCents).toBe(-4000n);
  });
});
