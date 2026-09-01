import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction, splitTransactionEvenly } from '../src/domain/allocations.js';
import { suggestDelegations } from '../src/domain/suggestions.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';

/**
 * Where this merchant went the last few times.
 *
 * The risk in a suggestion is not that it is missing — a queue with no advice on
 * it is the queue as it has always been. It is that a wrong one is one press
 * from moving an envelope balance, so the tests here are mostly about the cases
 * where there is no honest answer and none must be offered.
 */

beforeEach(async () => {
  await resetDatabase();
});

async function fixtures(): Promise<{
  accountId: string;
  groceryId: string;
  diningId: string;
}> {
  const account = await makeAccount({
    name: 'Everyday Checking',
    type: 'asset',
    balanceCents: 500000n,
  });
  const grocery = await makeDelegation({ name: 'Grocery' });
  const dining = await makeDelegation({ name: 'Dining' });
  return { accountId: account.id, groceryId: grocery.id, diningId: dining.id };
}

/** A charge already filed, which is what the suggestion reads back. */
async function filed(
  accountId: string,
  delegationId: string,
  descriptionRaw: string,
): Promise<void> {
  const transaction = await makeTransaction({
    accountId,
    amountCents: -4210n,
    description: 'Kroger',
    descriptionRaw,
  });
  await categorizeTransaction(prisma, transaction.id, delegationId);
}

describe('suggesting a delegation', () => {
  it('answers with the delegation the merchant has gone to, and the count behind it', async () => {
    const { accountId, groceryId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #4471 CINCINNATI');

    // The store number differs on every visit, so grouping on the whole
    // description would find no history at all.
    const waiting = await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    const suggestions = await suggestDelegations(prisma);

    expect(suggestions).toEqual([
      {
        transactionId: waiting.id,
        delegationId: groceryId,
        delegationName: 'Grocery',
        matchCount: 2,
        totalCount: 2,
      },
    ]);
  });

  it('says nothing on one prior decision', async () => {
    const { accountId, groceryId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    // One is as often a coincidence as a pattern, and a suggestion carries the
    // weight of a recommendation whatever count is printed beside it.
    expect(await suggestDelegations(prisma)).toEqual([]);
  });

  it('says nothing where a merchant is split evenly between two envelopes', async () => {
    const { accountId, groceryId, diningId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, diningId, 'KROGER #4471 CINCINNATI');
    await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    // A majority, not a plurality: a merchant that goes two ways has no answer,
    // and offering either half of a tie invents one.
    expect(await suggestDelegations(prisma)).toEqual([]);
  });

  it('follows the majority where there is one', async () => {
    const { accountId, groceryId, diningId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #4471 CINCINNATI');
    await filed(accountId, diningId, 'KROGER #5512 CINCINNATI');
    await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    expect(await suggestDelegations(prisma)).toEqual([
      expect.objectContaining({ delegationId: groceryId, matchCount: 2, totalCount: 3 }),
    ]);
  });

  it('does not read a split as evidence about the merchant', async () => {
    const { accountId, groceryId, diningId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');

    const shared = await makeTransaction({
      accountId,
      amountCents: -6000n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #4471 CINCINNATI',
    });
    await splitTransactionEvenly(prisma, shared.id, [groceryId, diningId]);

    await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    /*
     * A split says this charge was two things — a fact about the charge, which
     * the next charge from the same shop does not inherit. Counting it would
     * also let one transaction vote twice.
     */
    expect(await suggestDelegations(prisma)).toEqual([]);
  });

  it('never suggests an archived delegation', async () => {
    const { accountId, groceryId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #4471 CINCINNATI');
    await prisma.delegation.update({
      where: { id: groceryId },
      data: { archivedAt: new Date('2026-08-20T00:00:00Z') },
    });

    await makeTransaction({
      accountId,
      amountCents: -3300n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
    });

    // It still resolves for history — `Grocery (archived)` — but offering it as
    // a destination would offer a category that no longer exists.
    expect(await suggestDelegations(prisma)).toEqual([]);
  });

  it('leaves a row alone once it has been categorized', async () => {
    const { accountId, groceryId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #4471 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #9982 CINCINNATI');

    // Nothing is waiting, so there is nothing to advise about.
    expect(await suggestDelegations(prisma)).toEqual([]);
  });

  it('ignores income, which allocates to nothing by definition', async () => {
    const { accountId, groceryId } = await fixtures();
    await filed(accountId, groceryId, 'KROGER #123 CINCINNATI');
    await filed(accountId, groceryId, 'KROGER #4471 CINCINNATI');
    await makeTransaction({
      accountId,
      amountCents: 300000n,
      description: 'Kroger',
      descriptionRaw: 'KROGER #9982 CINCINNATI',
      kind: 'income',
    });

    expect(await suggestDelegations(prisma)).toEqual([]);
  });
});
