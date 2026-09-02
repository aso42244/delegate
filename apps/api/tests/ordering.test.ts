import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { placeAccount } from '../src/domain/accounts.js';
import { buildBudgetView } from '../src/domain/budget.js';
import { reorderGroupings } from '../src/domain/delegations.js';
import type { BudgetView } from '../src/domain/budget.js';
import { makeAccount, makeDelegation, resetDatabase } from './helpers.js';

/**
 * Assets, Debts and the groupings above them can be put in an order.
 *
 * Delegations have had a position since v0.24 — the owner's groupings are named
 * "3 - Food" and "5 - Home" because ordering was the thing missing, and
 * numbering them was the workaround. The same argument applies one level up and
 * one level across.
 *
 * The property worth guarding is the quiet one: **an untouched budget still
 * reads alphabetically.** Every row starts at position zero, and a tie falls
 * through to the name, so nothing moves until somebody moves it.
 */

const ZONE = 'America/Chicago';

beforeEach(async () => {
  await resetDatabase();
});

async function view(): Promise<BudgetView> {
  return buildBudgetView(prisma, { timeZone: ZONE });
}

describe('an untouched budget', () => {
  it('still reads alphabetically', async () => {
    await makeAccount({ name: 'Savings', type: 'asset', balanceCents: 100n });
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });
    await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 100n });

    const names = (await view()).assets.ungrouped.map((row) => row.name);
    expect(names).toEqual(['Cash', 'Checking', 'Savings']);
  });
});

describe('placing an account', () => {
  it('puts it where it was dropped, and leaves the rest in order', async () => {
    const cash = await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 100n });
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });
    const savings = await makeAccount({ name: 'Savings', type: 'asset', balanceCents: 100n });

    // Checking to the front: the order the household reads its accounts in is a
    // fact about the household, and alphabetical is nobody's reading.
    await placeAccount(prisma, {
      accountId: checking.id,
      groupingId: null,
      orderedIds: [checking.id, cash.id, savings.id],
    });

    const names = (await view()).assets.ungrouped.map((row) => row.name);
    expect(names).toEqual(['Checking', 'Cash', 'Savings']);
  });

  it('files it under a grouping and orders it there in one request', async () => {
    const grouping = await prisma.grouping.create({
      data: { name: 'Everyday', section: 'assets' },
      select: { id: true },
    });
    const cash = await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 100n });
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });
    await prisma.account.update({ where: { id: cash.id }, data: { groupingId: grouping.id } });

    await placeAccount(prisma, {
      accountId: checking.id,
      groupingId: grouping.id,
      orderedIds: [checking.id, cash.id],
    });

    // Dragging a row onto another row does both things, so the request does too.
    const built = (await view()).assets.groupings[0];
    expect(built?.rows.map((row) => row.name)).toEqual(['Checking', 'Cash']);
  });

  it('refuses to file an asset under a debt heading', async () => {
    const grouping = await prisma.grouping.create({
      data: { name: 'Cards', section: 'debts' },
      select: { id: true },
    });
    const cash = await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 100n });

    /*
     * The section a row sits in *is* its type on that page — Settings → Accounts
     * deleted the Type column on exactly that ground — so the two must not be
     * allowed to disagree.
     */
    await expect(
      placeAccount(prisma, {
        accountId: cash.id,
        groupingId: grouping.id,
        orderedIds: [cash.id],
      }),
    ).rejects.toThrow(/An asset can only be filed under a grouping in the assets section/i);
  });

  it('refuses an order that leaves out the account being moved', async () => {
    const cash = await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 100n });
    const checking = await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 100n });

    await expect(
      placeAccount(prisma, {
        accountId: cash.id,
        groupingId: null,
        orderedIds: [checking.id],
      }),
    ).rejects.toThrow(/must include the account being moved/i);
  });
});

describe('ordering groupings', () => {
  async function threeGroupings(): Promise<string[]> {
    const names = ['Everyday', 'Long term', 'Cash'];
    const ids: string[] = [];
    for (const name of names) {
      const grouping = await prisma.grouping.create({
        data: { name, section: 'assets' },
        select: { id: true },
      });
      // A grouping with nothing in it is filtered off the page, so each gets a row.
      const account = await makeAccount({
        name: `${name} account`,
        type: 'asset',
        balanceCents: 1n,
      });
      await prisma.account.update({
        where: { id: account.id },
        data: { groupingId: grouping.id },
      });
      ids.push(grouping.id);
    }
    return ids;
  }

  it('puts them where they were dropped', async () => {
    const [everyday, longTerm, cash] = await threeGroupings();

    await reorderGroupings(prisma, 'assets', [cash!, everyday!, longTerm!]);

    const names = (await view()).assets.groupings.map((grouping) => grouping.name);
    expect(names).toEqual(['Cash', 'Everyday', 'Long term']);
  });

  it('refuses a partial order', async () => {
    const [everyday] = await threeGroupings();

    // A partial order would leave groupings where they were, which reads as the
    // reorder having been ignored.
    await expect(reorderGroupings(prisma, 'assets', [everyday!])).rejects.toThrow(
      /every grouping in the section exactly once/i,
    );
  });

  it('does not renumber another section underneath somebody', async () => {
    const [everyday, longTerm, cash] = await threeGroupings();
    const delegations = await prisma.grouping.create({
      data: { name: 'Food', section: 'delegations' },
      select: { id: true, position: true },
    });
    await makeDelegation({ name: 'Grocery' });

    await reorderGroupings(prisma, 'assets', [cash!, everyday!, longTerm!]);

    // The three sections are independent lists that happen to share a table.
    const after = await prisma.grouping.findUniqueOrThrow({ where: { id: delegations.id } });
    expect(after.position).toBe(delegations.position);
  });

  it('leaves the application own groupings out of the order it asks for', async () => {
    const [everyday, longTerm, cash] = await threeGroupings();
    await prisma.grouping.create({
      data: { name: 'Outstanding checks', section: 'assets', systemKey: 'checks' },
    });

    /*
     * Outstanding checks sort last by rule rather than by where anybody put
     * them, so a reorder neither names them nor is refused for leaving them out.
     */
    await expect(
      reorderGroupings(prisma, 'assets', [cash!, everyday!, longTerm!]),
    ).resolves.toBeUndefined();
  });
});
