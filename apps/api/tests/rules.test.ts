import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import {
  applyRules,
  archiveRule,
  createRule,
  createRuleFromTransaction,
  previewRules,
  reorderRules,
  ruleMatches,
  updateRule,
} from '../src/domain/rules.js';
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

/**
 * Auto-categorization rules.
 *
 * Two properties carry the risk: first-match-wins must be exactly that, and a
 * bulk apply must never overwrite a categorization a person made by hand. Both
 * move real envelope balances across hundreds of rows at once.
 */

beforeEach(async () => {
  await resetDatabase();
});

async function fixtures(): Promise<{
  accountId: string;
  groceryId: string;
  diningId: string;
  actorId: string;
}> {
  const account = await makeAccount({
    name: 'Everyday Checking',
    type: 'asset',
    balanceCents: 500000n,
  });
  const grocery = await makeDelegation({ name: 'Grocery' });
  const dining = await makeDelegation({ name: 'Dining' });
  const actor = await makeUser('owner');
  return { accountId: account.id, groceryId: grocery.id, diningId: dining.id, actorId: actor.id };
}

describe('matching', () => {
  const transaction = {
    description: 'Whole Foods Market',
    descriptionRaw: 'WHOLEFDS MKT #10234',
    amountCents: -4210n,
    accountId: 'account-1',
  };

  it('matches case-insensitively on contains', () => {
    expect(ruleMatches({ matchMode: 'contains', matchValue: 'whole foods' }, transaction)).toBe(
      true,
    );
  });

  it('matches the raw feed text as well as the cleaned description', () => {
    // Feeds reword a description between the pending and posted versions of the
    // same purchase; a rule written against either form must keep firing.
    expect(ruleMatches({ matchMode: 'contains', matchValue: 'WHOLEFDS' }, transaction)).toBe(true);
  });

  it('honours starts_with', () => {
    expect(ruleMatches({ matchMode: 'starts_with', matchValue: 'whole' }, transaction)).toBe(true);
    expect(ruleMatches({ matchMode: 'starts_with', matchValue: 'foods' }, transaction)).toBe(false);
  });

  it('honours a regular expression', () => {
    expect(ruleMatches({ matchMode: 'regex', matchValue: 'wholefds\\s+mkt' }, transaction)).toBe(
      true,
    );
  });

  it('compares amount ranges by magnitude, not sign', () => {
    // The owner thinks "between $20 and $50", while spending is negative.
    expect(
      ruleMatches(
        {
          matchMode: 'contains',
          matchValue: 'whole',
          amountMinCents: 2000n,
          amountMaxCents: 5000n,
        },
        transaction,
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        { matchMode: 'contains', matchValue: 'whole', amountMinCents: 5000n },
        transaction,
      ),
    ).toBe(false);
  });

  it('honours direction', () => {
    expect(
      ruleMatches({ matchMode: 'contains', matchValue: 'whole', direction: 'debit' }, transaction),
    ).toBe(true);
    expect(
      ruleMatches({ matchMode: 'contains', matchValue: 'whole', direction: 'credit' }, transaction),
    ).toBe(false);
  });

  it('honours an account restriction', () => {
    expect(
      ruleMatches(
        { matchMode: 'contains', matchValue: 'whole', accountId: 'account-2' },
        transaction,
      ),
    ).toBe(false);
  });
});

describe('creating rules', () => {
  it('rejects a pattern that can hang while matching', async () => {
    const { groceryId } = await fixtures();

    // A user-supplied regex runs against the whole backlog. `(a+)+$` backtracks
    // forever and there is no way to interrupt it in a single-process server.
    await expect(
      createRule(prisma, { matchMode: 'regex', matchValue: '(a+)+$', delegationId: groceryId }),
    ).rejects.toThrow(/nests repeats/);
  });

  it('rejects an invalid regular expression at save time, not mid-run', async () => {
    const { groceryId } = await fixtures();

    await expect(
      createRule(prisma, { matchMode: 'regex', matchValue: '([unclosed', delegationId: groceryId }),
    ).rejects.toThrow(/not a valid regular expression/);
  });

  it('rejects an impossible amount range', async () => {
    const { groceryId } = await fixtures();

    await expect(
      createRule(prisma, {
        matchMode: 'contains',
        matchValue: 'x',
        delegationId: groceryId,
        amountMinCents: 5000n,
        amountMaxCents: 1000n,
      }),
    ).rejects.toThrow(/could never match/);
  });

  it('refuses to point a rule at an archived delegation', async () => {
    const { groceryId } = await fixtures();
    await prisma.delegation.update({ where: { id: groceryId }, data: { archivedAt: new Date() } });

    await expect(
      createRule(prisma, { matchMode: 'contains', matchValue: 'x', delegationId: groceryId }),
    ).rejects.toThrow(/archived/);
  });

  it('appends new rules after existing ones', async () => {
    const { groceryId, diningId } = await fixtures();

    const first = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'a',
      delegationId: groceryId,
    });
    const second = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'b',
      delegationId: diningId,
    });

    // Adding a rule must not change what an existing rule already does.
    const rows = await prisma.categorizationRule.findMany({ orderBy: { priority: 'asc' } });
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });
});

describe('applying rules', () => {
  it('assigns the whole transaction and moves the delegation', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole foods',
      delegationId: groceryId,
    });

    const result = await applyRules(prisma, { actorId });

    expect(result.categorized).toBe(1);
    expect(await delegationBalance(groceryId)).toBe(-4210n);
  });

  it('stops at the first matching rule', async () => {
    const { accountId, groceryId, diningId, actorId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });

    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
      priority: 10,
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'foods',
      delegationId: diningId,
      priority: 20,
    });

    await applyRules(prisma, { actorId });

    // First match wins outright: no scoring, no combining, nothing to reason about.
    expect(await delegationBalance(groceryId)).toBe(-4210n);
    expect(await delegationBalance(diningId)).toBe(0n);
  });

  it('respects a reordering', async () => {
    const { accountId, groceryId, diningId, actorId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });

    const first = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });
    const second = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'foods',
      delegationId: diningId,
    });

    await reorderRules(prisma, [second.id, first.id]);
    await applyRules(prisma, { actorId });

    expect(await delegationBalance(diningId)).toBe(-4210n);
    expect(await delegationBalance(groceryId)).toBe(0n);
  });

  it('never overwrites a categorization made by hand', async () => {
    const { accountId, groceryId, diningId, actorId } = await fixtures();
    const transaction = await makeTransaction({
      accountId,
      amountCents: -4210n,
      description: 'Whole Foods Market',
    });

    // The owner deliberately filed this under Dining.
    await categorizeTransaction(prisma, transaction.id, diningId, { actorId });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    const result = await applyRules(prisma, { actorId });

    // A bulk action has no business silently reversing a human decision.
    expect(result.categorized).toBe(0);
    expect(await delegationBalance(diningId)).toBe(-4210n);
    expect(await delegationBalance(groceryId)).toBe(0n);
  });

  it('re-categorizes an existing decision only when explicitly asked', async () => {
    const { accountId, groceryId, diningId, actorId } = await fixtures();
    const transaction = await makeTransaction({
      accountId,
      amountCents: -4210n,
      description: 'Whole Foods Market',
    });

    await categorizeTransaction(prisma, transaction.id, diningId, { actorId });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    await applyRules(prisma, { actorId, includeCategorized: true });

    // The old allocation is reversed, not stacked on top of the new one.
    expect(await delegationBalance(diningId)).toBe(0n);
    expect(await delegationBalance(groceryId)).toBe(-4210n);
  });

  it('leaves income and confirmed transfers alone', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    await makeTransaction({
      accountId,
      amountCents: 489000n,
      description: 'Whole Foods payroll',
      kind: 'income',
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    const result = await applyRules(prisma, { actorId });

    // Income allocates to nothing by definition; the identity's positive reading
    // is what makes it "to delegate".
    expect(result.categorized).toBe(0);
    expect(await delegationBalance(groceryId)).toBe(0n);
  });

  it('skips an archived transaction', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    const transaction = await makeTransaction({
      accountId,
      amountCents: -4210n,
      description: 'Whole Foods Market',
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { archivedAt: new Date() },
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    expect((await applyRules(prisma, { actorId })).categorized).toBe(0);
  });

  it('ignores a disabled or archived rule', async () => {
    const { accountId, groceryId, diningId, actorId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });

    const disabled = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });
    await updateRule(prisma, disabled.id, { enabled: false });

    const archived = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'market',
      delegationId: diningId,
    });
    await archiveRule(prisma, archived.id);

    expect((await applyRules(prisma, { actorId })).categorized).toBe(0);
  });

  it('applies across a whole backlog in one pass', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    for (let i = 0; i < 25; i += 1) {
      await makeTransaction({
        accountId,
        amountCents: -1000n,
        description: `Whole Foods Market ${i}`,
      });
    }
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole foods',
      delegationId: groceryId,
    });

    // This is what makes categorizing months of history before go-live possible
    // at all — the alternative is 400 clicks.
    const result = await applyRules(prisma, { actorId });

    expect(result.categorized).toBe(25);
    expect(await delegationBalance(groceryId)).toBe(-25000n);
  });

  it('keeps cached balances in step with the ledger after a bulk apply', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    for (let i = 0; i < 10; i += 1) {
      await makeTransaction({ accountId, amountCents: -1000n, description: `Whole Foods ${i}` });
    }
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    await applyRules(prisma, { actorId });

    const fromEvents = await ledgerBalances();
    expect(await delegationBalance(groceryId)).toBe(fromEvents.get(groceryId) ?? 0n);
  });

  it('does not touch account balances', async () => {
    const { accountId, groceryId, actorId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    await applyRules(prisma, { actorId });

    // Categorization moves envelopes, never the real-world account balance.
    expect(await accountBalance(accountId)).toBe(500000n);
  });
});

describe('previewing', () => {
  it('reports what would happen without doing it', async () => {
    const { accountId, groceryId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });
    await makeTransaction({ accountId, amountCents: -900n, description: 'Unmatched thing' });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });

    const preview = await previewRules(prisma);

    expect(preview).toEqual({ examined: 2, categorized: 1 });
    // "1 of 423" is a very different decision from "397 of 423", so nothing may
    // move until the owner has seen the number.
    expect(await delegationBalance(groceryId)).toBe(0n);
  });
});

describe('building a rule from a transaction', () => {
  it('matches on the raw feed text', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await prisma.transaction.create({
      data: {
        accountId,
        amountCents: -4210n,
        description: 'Whole Foods Market',
        descriptionRaw: 'WHOLEFDS MKT #10234',
        postedAt: new Date('2026-08-05T00:00:00Z'),
        source: 'manual',
      },
      select: { id: true },
    });

    const rule = await createRuleFromTransaction(prisma, transaction.id, groceryId);

    // The raw text survives a feed's own rewording; the cleaned description does not.
    const row = await prisma.categorizationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.matchValue).toBe('WHOLEFDS MKT #10234');
    expect(row.matchMode).toBe('contains');
  });
});

describe('reordering', () => {
  it('refuses a partial order', async () => {
    const { groceryId, diningId } = await fixtures();
    const first = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'a',
      delegationId: groceryId,
    });
    await createRule(prisma, { matchMode: 'contains', matchValue: 'b', delegationId: diningId });

    // Silently leaving rules where they were reads as the reorder being ignored.
    await expect(reorderRules(prisma, [first.id])).rejects.toThrow(/every active rule/);
  });
});
