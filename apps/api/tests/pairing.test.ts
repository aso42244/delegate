import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { buildSpending } from '../src/domain/insights.js';
import { confirmPair, findPairCandidates, unpair } from '../src/domain/pairing.js';
import {
  delegationBalance,
  makeAccount,
  makeDelegation,
  makeTransaction,
  resetDatabase,
} from './helpers.js';

/**
 * Pairing the two halves of a transfer between owned accounts.
 *
 * A credit card payment is not spending, and left unpaired it inflates every
 * spending figure by the amount moved. But §7 is emphatic that wrong automatic
 * pairing is worse than no pairing, so the tests below care as much about what
 * is *not* suggested as about what is.
 */

const NOW = new Date('2026-08-09T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

async function twoAccounts(): Promise<{ checking: string; card: string }> {
  const checking = await makeAccount({
    name: 'Everyday Checking',
    type: 'asset',
    balanceCents: 500_000n,
  });
  const card = await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });
  return { checking: checking.id, card: card.id };
}

describe('what gets suggested', () => {
  it('matches an equal and opposite pair across two accounts', async () => {
    const { checking, card } = await twoAccounts();
    await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
      description: 'Payment to card',
    });
    await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-03T00:00:00Z'),
      description: 'Payment received',
    });

    const candidates = await findPairCandidates(prisma, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.outflow.accountName).toBe('Everyday Checking');
    expect(candidates[0]?.inflow.accountName).toBe('Card');
    // How close the match is, so the owner can judge it.
    expect(candidates[0]?.daysApart).toBe(2);
  });

  /** §7's window. A payment and a refund a fortnight apart are not a pair. */
  it('does not reach beyond five days', async () => {
    const { checking, card } = await twoAccounts();
    await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-08T00:00:00Z'),
    });

    expect(await findPairCandidates(prisma, NOW)).toEqual([]);
  });

  /**
   * Exact on the magnitude, deliberately. $500.00 against $499.50 is either two
   * unrelated movements or a fee, and both readings need a person.
   */
  it('does not offer a near miss', async () => {
    const { checking, card } = await twoAccounts();
    await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: card,
      amountCents: 49_950n,
      postedAt: new Date('2026-08-02T00:00:00Z'),
    });

    expect(await findPairCandidates(prisma, NOW)).toEqual([]);
  });

  it('does not pair two rows on the same account', async () => {
    const { checking } = await twoAccounts();
    await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: checking,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-02T00:00:00Z'),
    });

    expect(await findPairCandidates(prisma, NOW)).toEqual([]);
  });

  /**
   * A pending row can still vanish or settle at a different amount, and pairing
   * one would have to be undone when it did.
   */
  it('ignores pending transactions', async () => {
    const { checking, card } = await twoAccounts();
    await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
      pending: true,
    });
    await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-02T00:00:00Z'),
    });

    expect(await findPairCandidates(prisma, NOW)).toEqual([]);
  });

  /** Each row is offered once; the list must not create its own ambiguity. */
  it('claims each transaction for one suggestion only', async () => {
    const { checking, card } = await twoAccounts();
    for (const postedAt of ['2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z']) {
      await makeTransaction({
        accountId: checking,
        amountCents: -50_000n,
        postedAt: new Date(postedAt),
      });
    }
    await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-03T00:00:00Z'),
    });

    const candidates = await findPairCandidates(prisma, NOW);
    // Two outflows, one inflow: exactly one pair, not two claiming the same row.
    expect(candidates).toHaveLength(1);
  });
});

describe('confirming a pair', () => {
  it('marks both as transfers pointing at each other', async () => {
    const { checking, card } = await twoAccounts();
    const out = await makeTransaction({ accountId: checking, amountCents: -50_000n });
    const back = await makeTransaction({ accountId: card, amountCents: 50_000n });

    await confirmPair(prisma, out.id, back.id);

    const rows = await prisma.transaction.findMany({
      where: { id: { in: [out.id, back.id] } },
      select: { id: true, kind: true, pairedTransactionId: true },
    });
    expect(rows.every((row) => row.kind === 'transfer')).toBe(true);
    expect(rows.find((row) => row.id === out.id)?.pairedTransactionId).toBe(back.id);
  });

  /**
   * The one that would corrupt a balance: a transfer allocates to nothing, so a
   * categorization has to be reversed, not left behind.
   */
  it('clears a categorization and returns the delegation', async () => {
    const { checking, card } = await twoAccounts();
    const grocery = await makeDelegation({ name: 'Grocery' });

    const out = await makeTransaction({ accountId: checking, amountCents: -50_000n });
    const back = await makeTransaction({ accountId: card, amountCents: 50_000n });
    await categorizeTransaction(prisma, out.id, grocery.id);
    expect(await delegationBalance(grocery.id)).toBe(-50_000n);

    await confirmPair(prisma, out.id, back.id);

    // The envelope is back where it started: no money left the household.
    expect(await delegationBalance(grocery.id)).toBe(0n);
  });

  it('excludes the pair from spending figures', async () => {
    const { checking, card } = await twoAccounts();
    const grocery = await makeDelegation({ name: 'Grocery' });

    const spend = await makeTransaction({
      accountId: checking,
      amountCents: -3_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });
    await categorizeTransaction(prisma, spend.id, grocery.id);

    const out = await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });
    const back = await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-06T00:00:00Z'),
    });
    await confirmPair(prisma, out.id, back.id);

    const { entries } = await buildSpending(prisma, { by: 'delegation', window: '30d' }, NOW);
    // $30 of groceries, not $530.
    expect(entries[0]?.spendCents).toBe(3_000n);
  });

  it('refuses amounts that do not offset', async () => {
    const { checking, card } = await twoAccounts();
    const out = await makeTransaction({ accountId: checking, amountCents: -50_000n });
    const back = await makeTransaction({ accountId: card, amountCents: 49_950n });

    await expect(confirmPair(prisma, out.id, back.id)).rejects.toThrow(/equal and opposite/);
  });

  it('refuses a row that is already paired', async () => {
    const { checking, card } = await twoAccounts();
    const out = await makeTransaction({ accountId: checking, amountCents: -50_000n });
    const back = await makeTransaction({ accountId: card, amountCents: 50_000n });
    const other = await makeTransaction({ accountId: card, amountCents: 50_000n });

    await confirmPair(prisma, out.id, back.id);
    await expect(confirmPair(prisma, out.id, other.id)).rejects.toThrow(/already paired/);
  });
});

describe('unpairing', () => {
  it('returns both to ordinary uncategorized transactions', async () => {
    const { checking, card } = await twoAccounts();
    const out = await makeTransaction({ accountId: checking, amountCents: -50_000n });
    const back = await makeTransaction({ accountId: card, amountCents: 50_000n });

    await confirmPair(prisma, out.id, back.id);
    await unpair(prisma, out.id);

    const rows = await prisma.transaction.findMany({
      where: { id: { in: [out.id, back.id] } },
      select: { kind: true, pairedTransactionId: true },
    });
    expect(rows.every((row) => row.kind === 'normal')).toBe(true);
    expect(rows.every((row) => row.pairedTransactionId === null)).toBe(true);
  });

  it('refuses when nothing is paired', async () => {
    const { checking } = await twoAccounts();
    const lone = await makeTransaction({ accountId: checking, amountCents: -50_000n });

    await expect(unpair(prisma, lone.id)).rejects.toThrow(/not paired/);
  });

  /** Both halves become suggestible again, so a mistake is fully reversible. */
  it('lets the pair be suggested again afterwards', async () => {
    const { checking, card } = await twoAccounts();
    const out = await makeTransaction({
      accountId: checking,
      amountCents: -50_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    const back = await makeTransaction({
      accountId: card,
      amountCents: 50_000n,
      postedAt: new Date('2026-08-02T00:00:00Z'),
    });

    await confirmPair(prisma, out.id, back.id);
    expect(await findPairCandidates(prisma, NOW)).toEqual([]);

    await unpair(prisma, out.id);
    expect(await findPairCandidates(prisma, NOW)).toHaveLength(1);
  });
});
