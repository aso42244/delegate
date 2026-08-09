import { describe, expect, it, beforeEach } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import { buildUtilitySummaries } from '../src/domain/utilities.js';
import { makeAccount, makeDelegation, makeTransaction, resetDatabase } from './helpers.js';

/**
 * The Utilities page.
 *
 * Two properties decide whether the suggestion is worth anything. Adjustments
 * must not reach the average — an adjustment is a correction to a balance, not
 * money spent on water. And the month in progress must not drag it down, or the
 * number collapses on the second of every month and recovers by the thirtieth.
 */

const NOW = new Date('2026-08-09T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

async function utilityWithSpend(
  spendByMonth: readonly { month: string; cents: bigint }[],
): Promise<string> {
  const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
  const water = await makeDelegation({ name: 'Water', isUtility: true });

  for (const entry of spendByMonth) {
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -entry.cents,
      postedAt: new Date(entry.month),
      description: 'Water bill',
    });
    await categorizeTransaction(prisma, transaction.id, water.id);
  }
  return water.id;
}

describe('the monthly window', () => {
  it('is twelve buckets ending with the month we are in', async () => {
    await utilityWithSpend([]);

    const [water] = await buildUtilitySummaries(prisma, NOW);
    expect(water?.months).toHaveLength(12);
    expect(water?.months[11]?.month.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(water?.months[0]?.month.toISOString()).toBe('2025-09-01T00:00:00.000Z');
  });

  it('marks the month in progress as incomplete', async () => {
    await utilityWithSpend([]);

    const [water] = await buildUtilitySummaries(prisma, NOW);
    expect(water?.months[11]?.complete).toBe(false);
    expect(water?.months[10]?.complete).toBe(true);
  });
});

describe('the average', () => {
  /**
   * The reason this test exists: a partial month would drag the average down for
   * most of every month, and the number is meant to be compared against a
   * standing amount.
   */
  it('ignores the month still in progress', async () => {
    await utilityWithSpend([
      { month: '2026-06-15T00:00:00Z', cents: 12_000n },
      { month: '2026-07-15T00:00:00Z', cents: 12_000n },
      // Only a few days into August, so far below a month's worth.
      { month: '2026-08-02T00:00:00Z', cents: 1_000n },
    ]);

    const [water] = await buildUtilitySummaries(prisma, NOW);
    // $240 across the eleven complete months, not $250 across twelve.
    expect(water?.averageCents).toBe(24_000n / 11n);
  });

  /** An adjustment corrects a balance; it is not money spent on water. */
  it('excludes adjustments entirely', async () => {
    const waterId = await utilityWithSpend([{ month: '2026-07-15T00:00:00Z', cents: 11_000n }]);
    await adjustDelegationByDelta(prisma, { delegationId: waterId, deltaCents: -500_000n });

    const [water] = await buildUtilitySummaries(prisma, NOW);
    // The adjustment is enormous; the average is unmoved by it.
    expect(water?.averageCents).toBe(11_000n / 11n);
  });

  it('lets a refund inside a month reduce that month', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500_000n });
    const water = await makeDelegation({ name: 'Water', isUtility: true });

    const bill = await makeTransaction({
      accountId: account.id,
      amountCents: -12_000n,
      postedAt: new Date('2026-07-05T00:00:00Z'),
    });
    await categorizeTransaction(prisma, bill.id, water.id);

    const refund = await makeTransaction({
      accountId: account.id,
      amountCents: 2_000n,
      postedAt: new Date('2026-07-20T00:00:00Z'),
    });
    await categorizeTransaction(prisma, refund.id, water.id);

    const [summary] = await buildUtilitySummaries(prisma, NOW);
    const july = summary?.months.find(
      (month) => month.month.toISOString() === '2026-07-01T00:00:00.000Z',
    );
    expect(july?.spendCents).toBe(10_000n);
  });

  it('is zero, not an error, with no history at all', async () => {
    await utilityWithSpend([]);

    const [water] = await buildUtilitySummaries(prisma, NOW);
    expect(water?.averageCents).toBe(0n);
    expect(water?.suggestedPerCycleCents).toBe(0n);
  });
});

describe('the suggestion', () => {
  it('is the monthly average spread over 26 cycles a year', async () => {
    // $130/month across eleven complete months.
    await utilityWithSpend(
      Array.from({ length: 11 }, (_, index) => ({
        month: new Date(Date.UTC(2025, 8 + index, 15)).toISOString(),
        cents: 13_000n,
      })),
    );

    const [water] = await buildUtilitySummaries(prisma, NOW);
    expect(water?.averageCents).toBe(13_000n);
    // 13000 × 12 ÷ 26 = 6000.
    expect(water?.suggestedPerCycleCents).toBe(6_000n);
  });

  it('never writes the amount to delegate', async () => {
    const waterId = await utilityWithSpend([{ month: '2026-07-15T00:00:00Z', cents: 13_000n }]);

    await buildUtilitySummaries(prisma, NOW);

    const delegation = await prisma.delegation.findUniqueOrThrow({ where: { id: waterId } });
    // Suggest only — §9.3 is explicit.
    expect(delegation.amountToDelegateCents).toBeNull();
  });
});

describe('which delegations appear', () => {
  it('is only the ones marked as a utility', async () => {
    await makeDelegation({ name: 'Water', isUtility: true });
    await makeDelegation({ name: 'Grocery', isUtility: false });

    const summaries = await buildUtilitySummaries(prisma, NOW);
    expect(summaries.map((summary) => summary.name)).toEqual(['Water']);
  });

  /** Archived utilities still appear in historical views — §6.9. */
  it('includes archived ones, marked as such', async () => {
    const water = await makeDelegation({ name: 'Water', isUtility: true });
    await prisma.delegation.update({
      where: { id: water.id },
      data: { archivedAt: new Date('2026-07-01T00:00:00Z') },
    });

    const summaries = await buildUtilitySummaries(prisma, NOW);
    expect(summaries[0]?.name).toBe('Water (archived)');
  });
});
