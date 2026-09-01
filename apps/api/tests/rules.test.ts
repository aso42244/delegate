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

    expect(preview).toEqual({ examined: 2, categorized: 1, labelled: 0 });
    // "1 of 423" is a very different decision from "397 of 423", so nothing may
    // move until the owner has seen the number.
    expect(await delegationBalance(groceryId)).toBe(0n);
  });
});

describe('building a rule from a transaction', () => {
  async function wholeFoods(accountId: string): Promise<{ id: string }> {
    return prisma.transaction.create({
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
  }

  it('matches the merchant in the raw feed text, not the store number with it', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await wholeFoods(accountId);

    const rule = await createRuleFromTransaction(prisma, transaction.id, groceryId);

    /*
     * The raw text survives a feed's own rewording; the cleaned description does
     * not. But the *whole* raw text carries `#10234`, which is this shop and
     * this shop only — a rule matching all of it would match the one transaction
     * it was built from and nothing else, for ever, without ever saying so.
     */
    const row = await prisma.categorizationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.matchValue).toBe('WHOLEFDS MKT');
    expect(row.matchMode).toBe('contains');
  });

  it('fires on the next charge from the same merchant', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await wholeFoods(accountId);
    await createRuleFromTransaction(prisma, transaction.id, groceryId);

    // A different store, so a different number: the case the whole-text version
    // silently failed at.
    const next = await prisma.transaction.create({
      data: {
        accountId,
        amountCents: -2200n,
        description: 'Whole Foods Market',
        descriptionRaw: 'WHOLEFDS MKT #88112',
        postedAt: new Date('2026-08-19T00:00:00Z'),
        source: 'manual',
      },
      select: { id: true },
    });

    await applyRules(prisma, { transactionIds: [next.id] });

    const allocations = await prisma.transactionAllocation.findMany({
      where: { transactionId: next.id },
    });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.delegationId).toBe(groceryId);
  });

  it('takes what the reader typed over its own guess', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await wholeFoods(accountId);

    const rule = await createRuleFromTransaction(prisma, transaction.id, groceryId, {
      matchValue: 'wholefds',
    });

    const row = await prisma.categorizationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.matchValue).toBe('wholefds');
  });
});

describe('a rule that labels rather than categorizes', () => {
  it('marks a matching row as income and allocates nothing', async () => {
    const { accountId } = await fixtures();
    const paycheck = await makeTransaction({
      accountId,
      amountCents: 320000n,
      description: 'ACME PAYROLL DIRECT DEP',
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      setKind: 'income',
    });

    const result = await applyRules(prisma);

    expect(result).toEqual({ examined: 1, categorized: 0, labelled: 1 });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: paycheck.id } });
    expect(row.kind).toBe('income');
    // Income arrives and is distributed by Delegate; it belongs to no envelope
    // on its own, so a labelling rule must move nothing.
    expect(await prisma.transactionAllocation.count()).toBe(0);
  });

  it('takes the paycheck out of the uncategorized queue for good', async () => {
    const { accountId } = await fixtures();
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      setKind: 'income',
    });

    // The shape a sync produces: rows land, then the rules run over exactly
    // those ids.
    const imported = await makeTransaction({
      accountId,
      amountCents: 320000n,
      description: 'ACME PAYROLL DIRECT DEP',
    });
    await applyRules(prisma, { transactionIds: [imported.id] });

    const waiting = await prisma.transaction.count({
      where: { archivedAt: null, kind: 'normal', allocations: { none: {} } },
    });
    expect(waiting).toBe(0);
  });

  it('never re-labels a row somebody categorized, even when told to overwrite', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await makeTransaction({
      accountId,
      amountCents: -4210n,
      description: 'ACME PAYROLL REFUND',
    });
    await categorizeTransaction(prisma, transaction.id, groceryId);
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      setKind: 'income',
    });

    const result = await applyRules(prisma, { includeCategorized: true });

    /*
     * Re-labelling would mean destroying the allocations underneath it, which
     * `updateTransaction` refuses one row at a time — and a bulk action must not
     * do what the same action refuses when it is asked for directly.
     */
    expect(result.labelled).toBe(0);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(row.kind).toBe('normal');
    expect(await delegationBalance(groceryId)).toBe(-4210n);
  });

  it('is counted apart from categorization in a preview', async () => {
    const { accountId, groceryId } = await fixtures();
    await makeTransaction({ accountId, amountCents: -4210n, description: 'Whole Foods Market' });
    await makeTransaction({ accountId, amountCents: 320000n, description: 'ACME PAYROLL' });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole',
      delegationId: groceryId,
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      setKind: 'income',
    });

    expect(await previewRules(prisma)).toEqual({ examined: 2, categorized: 1, labelled: 1 });
    // A preview moves nothing, whichever of the two a rule would have done.
    expect(await delegationBalance(groceryId)).toBe(0n);
    expect(await prisma.transaction.count({ where: { kind: 'income' } })).toBe(0);
  });

  it('still stops at the first match, whichever kind of rule that is', async () => {
    const { accountId, groceryId } = await fixtures();
    const transaction = await makeTransaction({
      accountId,
      amountCents: 320000n,
      description: 'ACME PAYROLL DIRECT DEP',
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme',
      setKind: 'income',
      priority: 10,
    });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'payroll',
      delegationId: groceryId,
      priority: 20,
    });

    await applyRules(prisma);

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(row.kind).toBe('income');
    expect(await delegationBalance(groceryId)).toBe(0n);
  });
});

describe('a rule does exactly one thing', () => {
  it('refuses one that both categorizes and labels', async () => {
    const { groceryId } = await fixtures();

    await expect(
      createRule(prisma, {
        matchMode: 'contains',
        matchValue: 'acme',
        delegationId: groceryId,
        setKind: 'income',
      }),
    ).rejects.toThrow(/not both/i);
  });

  it('refuses one that does neither', async () => {
    await fixtures();

    // The worst of the three shapes: it matches, and then changes nothing, which
    // looks exactly like a rule that works.
    await expect(createRule(prisma, { matchMode: 'contains', matchValue: 'acme' })).rejects.toThrow(
      /needs a delegation/i,
    );
  });

  it('refuses a label of "ordinary spending", which could never do anything', async () => {
    await fixtures();

    await expect(
      createRule(prisma, { matchMode: 'contains', matchValue: 'acme', setKind: 'normal' }),
    ).rejects.toThrow(/would do nothing/i);
  });

  it('swaps one action for the other in a single update', async () => {
    const { groceryId } = await fixtures();
    const rule = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      delegationId: groceryId,
    });

    // Both keys, because the action is a pair: sending one alone would leave a
    // rule that does two things, or none.
    await updateRule(prisma, rule.id, { delegationId: null, setKind: 'income' });

    const row = await prisma.categorizationRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row.delegationId).toBeNull();
    expect(row.setKind).toBe('income');
  });

  it('is held by the database, not only by the domain', async () => {
    const { groceryId } = await fixtures();
    const rule = await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'acme payroll',
      delegationId: groceryId,
    });

    // Straight past the domain, the way a future caller or a hand-written
    // statement would go.
    await expect(
      prisma.categorizationRule.update({
        where: { id: rule.id },
        data: { setKind: 'income' },
      }),
    ).rejects.toThrow();
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
