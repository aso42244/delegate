import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { dismissDuplicate, findDuplicates } from '../src/domain/duplicates.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';

/**
 * The same charge, in the register twice.
 *
 * The risk here is not a duplicate that goes unnoticed — that is the state this
 * replaces. It is a pair of genuinely separate charges offered as one, because
 * the button beside the offer archives a row and reverses whatever it moved. So
 * most of these are about the pairs that must *not* be proposed.
 */

beforeEach(async () => {
  await resetDatabase();
});

/** A row as a sync would write it, with the feed's own id. */
async function synced(
  accountId: string,
  day: string,
  cents: bigint,
  description: string,
  externalId: string,
  /*
   * When the row was written, which is what tells an original from a copy when
   * both carry the same posting date. A re-import is months apart; the default
   * here keeps them minutes apart in the order they are written, so a test does
   * not depend on two `create` calls landing in different milliseconds.
   */
  importedAt = new Date(`${day}T15:00:00Z`),
): Promise<{ id: string }> {
  return prisma.transaction.create({
    data: {
      accountId,
      amountCents: cents,
      description,
      descriptionRaw: description,
      postedAt: new Date(`${day}T15:00:00Z`),
      source: 'simplefin',
      externalId,
      createdAt: importedAt,
    },
    select: { id: true },
  });
}

async function checking(name = 'Everyday Checking'): Promise<string> {
  const account = await makeAccount({ name, type: 'asset', balanceCents: 500000n });
  return account.id;
}

describe('finding one', () => {
  it('reads out a charge that came back with a new id', async () => {
    const accountId = await checking();
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT #10234', 'old-id');
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT #10234', 'new-id');

    const [candidate, ...rest] = await findDuplicates(prisma);

    expect(rest).toEqual([]);
    expect(candidate?.daysApart).toBe(0);
    // The re-import signature: one charge, two feed rows, two ids.
    expect(candidate?.differentExternalIds).toBe(true);
  });

  it('names the earlier row as the original', async () => {
    const accountId = await checking();
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'old-id');
    const second = await synced(accountId, '2026-08-05', -4210n, 'WHOLEFDS MKT', 'new-id');

    const [candidate] = await findDuplicates(prisma);

    expect(candidate?.original.id).toBe(first.id);
    expect(candidate?.copy.id).toBe(second.id);
  });

  it('matches across a store number, because that is the same merchant', async () => {
    const accountId = await checking();
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT #10234', 'old-id');
    // The merchant key drops the reference fragment, so one shop does not become
    // two merchants because the feed appended a different store number.
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT #99', 'new-id');

    expect(await findDuplicates(prisma)).toHaveLength(1);
  });

  /**
   * The false positive from the first real run, and the reason this test file
   * exists in the shape it does.
   *
   * Two bills, both $60.00, two days apart, on one account. The detector paired
   * them because it compared account and amount and ignored the description
   * entirely — and the pair had nothing about it that would ever change, so it
   * came back on every page load.
   */
  it('does not pair two different payees that cost the same', async () => {
    const accountId = await checking();
    await synced(accountId, '2026-06-30', -6000n, 'ACH Payment Strike (Zap Solu 06/29', 'a');
    await synced(accountId, '2026-07-02', -6000n, 'ACH Payment City of Sioux Fa 6053678860', 'b');

    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('says which of the two carries a categorization', async () => {
    const accountId = await checking();
    const grocery = await makeDelegation({ name: 'Grocery' });
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'old-id');
    // The re-import: same posting date, written back months later.
    await synced(
      accountId,
      '2026-08-04',
      -4210n,
      'WHOLEFDS MKT',
      'new-id',
      new Date('2026-09-01T09:00:00Z'),
    );
    await categorizeTransaction(prisma, first.id, grocery.id);

    const [candidate] = await findDuplicates(prisma);

    // Archiving the categorized one puts money back in an envelope; archiving
    // the other does not. The reader is told which is which before pressing.
    expect(candidate?.original.categorized).toBe(true);
    expect(candidate?.copy.categorized).toBe(false);
  });

  it('offers three copies as two pairs, not three', async () => {
    const accountId = await checking();
    for (const id of ['a', 'b', 'c']) {
      await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', id);
    }

    // Confirming one changes what the others mean, so each row is named once.
    expect(await findDuplicates(prisma)).toHaveLength(1);
  });
});

describe('declining to offer one', () => {
  it('says nothing about a near amount', async () => {
    const accountId = await checking();
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'a');
    await synced(accountId, '2026-08-04', -4209n, 'WHOLEFDS MKT', 'b');

    // A cent apart is a fee or two different purchases, and both need a person.
    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('says nothing about the same amount in two accounts', async () => {
    const one = await checking('Everyday Checking');
    const two = await checking('Savings');
    await synced(one, '2026-08-04', -50000n, 'TRANSFER', 'a');
    await synced(two, '2026-08-04', -50000n, 'TRANSFER', 'b');

    /*
     * That is what a transfer looks like, and there is already a proposal for
     * it. Offering to archive half of one would be wrong in a way that is
     * expensive to undo.
     */
    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('says nothing about two charges a week apart', async () => {
    const accountId = await checking();
    await synced(accountId, '2026-08-04', -1200n, 'COFFEE', 'a');
    await synced(accountId, '2026-08-11', -1200n, 'COFFEE', 'b');

    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('leaves an archived row out of it', async () => {
    const accountId = await checking();
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'a');
    await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'b');
    await prisma.transaction.update({
      where: { id: first.id },
      data: { archivedAt: new Date() },
    });

    // Dealing with a duplicate must make the offer stop, not repeat.
    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('still offers two hand-entered rows, without the re-import mark', async () => {
    const accountId = await checking();
    await makeTransaction({
      accountId,
      amountCents: -2500n,
      description: 'Farmers market',
      postedAt: new Date('2026-08-04T15:00:00Z'),
    });
    await makeTransaction({
      accountId,
      amountCents: -2500n,
      description: 'Farmers market',
      postedAt: new Date('2026-08-04T15:00:00Z'),
    });

    // Typing one in twice is the other way this happens, and it is worth
    // reading out — but it carries no feed ids, so it is not marked as one.
    const [candidate] = await findDuplicates(prisma);
    expect(candidate?.daysApart).toBe(0);
    expect(candidate?.differentExternalIds).toBe(false);
  });
});

/**
 * Refusing a proposal, for good.
 *
 * The reason this is stored at all: two settled transactions never change, so a
 * proposal about them is permanent and a dismissal that lasted a session meant
 * the same wrong pair returned on every page load.
 */
describe('saying two rows are not the same charge', () => {
  it('stops that pair being proposed again', async () => {
    const accountId = await checking();
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'old-id');
    const second = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'new-id');

    expect(await findDuplicates(prisma)).toHaveLength(1);

    await dismissDuplicate(prisma, { firstId: first.id, secondId: second.id, userId: null });

    expect(await findDuplicates(prisma)).toEqual([]);
  });

  it('is the same dismissal whichever way round the pair is given', async () => {
    const accountId = await checking();
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'old-id');
    const second = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'new-id');

    // Written the other way round on purpose: the pair is ordered by id before
    // it is stored, so this is the same row rather than a second one.
    await dismissDuplicate(prisma, { firstId: second.id, secondId: first.id, userId: null });
    await dismissDuplicate(prisma, { firstId: first.id, secondId: second.id, userId: null });

    expect(await prisma.duplicateDismissal.count()).toBe(1);
    expect(await findDuplicates(prisma)).toEqual([]);
  });

  /**
   * A refusal is about the pair, not about either row.
   *
   * Three copies of one charge produce two proposals. Refusing the first must
   * leave the rows in the second one free to be offered — otherwise saying "not
   * these two" quietly hides a duplicate that is real.
   */
  it('leaves both rows eligible to be proposed against anything else', async () => {
    const accountId = await checking();
    const first = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'a');
    const second = await synced(
      accountId,
      '2026-08-04',
      -4210n,
      'WHOLEFDS MKT',
      'b',
      new Date('2026-08-04T16:00:00Z'),
    );
    const third = await synced(
      accountId,
      '2026-08-04',
      -4210n,
      'WHOLEFDS MKT',
      'c',
      new Date('2026-08-04T17:00:00Z'),
    );

    await dismissDuplicate(prisma, { firstId: first.id, secondId: second.id, userId: null });

    /*
     * The refused pair is gone and a proposal is still made. It is the first
     * against the *third*, not the second against the third: the loop moves past
     * a refused pair to the next unspent row rather than giving up on the row it
     * started from. Refusing "these two" must never hide a duplicate that is
     * real, and the first row is still one of three identical charges.
     */
    const remaining = await findDuplicates(prisma);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.original.id).toBe(first.id);
    expect(remaining[0]?.copy.id).toBe(third.id);
  });

  it('refuses to dismiss a transaction against itself', async () => {
    const accountId = await checking();
    const only = await synced(accountId, '2026-08-04', -4210n, 'WHOLEFDS MKT', 'a');

    await expect(
      dismissDuplicate(prisma, { firstId: only.id, secondId: only.id, userId: null }),
    ).rejects.toThrow(/itself/);
  });
});
