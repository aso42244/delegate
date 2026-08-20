import { describe, expect, it, beforeEach } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import type { PayCadence } from '@budget/shared';
import { buildUtilities, buildUtilitySummaries } from '../src/domain/utilities.js';

/**
 * The cadence these tests assume unless they are about cadence.
 *
 * Passed explicitly rather than defaulted, so a test that cares says so and one
 * that does not is still honest about what its expected figures were computed
 * from.
 */
const BIWEEKLY = 26;
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

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    expect(water?.months).toHaveLength(12);
    expect(water?.months[11]?.month.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(water?.months[0]?.month.toISOString()).toBe('2025-09-01T00:00:00.000Z');
  });

  it('marks the month in progress as incomplete', async () => {
    await utilityWithSpend([]);

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
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

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    // $240 across the eleven complete months, not $250 across twelve.
    expect(water?.averageCents).toBe(24_000n / 11n);
  });

  /** An adjustment corrects a balance; it is not money spent on water. */
  it('excludes adjustments entirely', async () => {
    const waterId = await utilityWithSpend([{ month: '2026-07-15T00:00:00Z', cents: 11_000n }]);
    await adjustDelegationByDelta(prisma, { delegationId: waterId, deltaCents: -500_000n });

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
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

    const [summary] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    const july = summary?.months.find(
      (month) => month.month.toISOString() === '2026-07-01T00:00:00.000Z',
    );
    expect(july?.spendCents).toBe(10_000n);
  });

  it('is zero, not an error, with no history at all', async () => {
    await utilityWithSpend([]);

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
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

    const [water] = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    expect(water?.averageCents).toBe(13_000n);
    // 13000 × 12 ÷ 26 = 6000.
    expect(water?.suggestedPerCycleCents).toBe(6_000n);
  });

  it('never writes the amount to delegate', async () => {
    const waterId = await utilityWithSpend([{ month: '2026-07-15T00:00:00Z', cents: 13_000n }]);

    await buildUtilitySummaries(prisma, BIWEEKLY, NOW);

    const delegation = await prisma.delegation.findUniqueOrThrow({ where: { id: waterId } });
    // Suggest only — §9.3 is explicit.
    expect(delegation.amountToDelegateCents).toBeNull();
  });
});

describe('which delegations appear', () => {
  it('is only the ones marked as a utility', async () => {
    await makeDelegation({ name: 'Water', isUtility: true });
    await makeDelegation({ name: 'Grocery', isUtility: false });

    const summaries = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    expect(summaries.map((summary) => summary.name)).toEqual(['Water']);
  });

  /** Archived utilities still appear in historical views — §6.9. */
  it('includes archived ones, marked as such', async () => {
    const water = await makeDelegation({ name: 'Water', isUtility: true });
    await prisma.delegation.update({
      where: { id: water.id },
      data: { archivedAt: new Date('2026-07-01T00:00:00Z') },
    });

    const summaries = await buildUtilitySummaries(prisma, BIWEEKLY, NOW);
    expect(summaries[0]?.name).toBe('Water (archived)');
  });
});

/**
 * The pay cadence, end to end.
 *
 * The arithmetic itself is proved by hand in the shared package's unit tests.
 * What these check is the wiring: that the setting is read, that it reaches the
 * divisor, and — the one that matters on upgrade — that a budget which has
 * never touched the setting still gets exactly the number it got before the
 * setting existed.
 */
describe('pay cadence', () => {
  /** $130 a month, which is $1,560 a year — divisible by all four cadences. */
  async function elevenMonthsAt130(): Promise<void> {
    await utilityWithSpend(
      Array.from({ length: 11 }, (_, index) => ({
        month: new Date(Date.UTC(2025, 8 + index, 15)).toISOString(),
        cents: 13_000n,
      })),
    );
  }

  async function setCadence(payCadence: PayCadence): Promise<void> {
    await prisma.budgetSettings.update({ where: { id: 1 }, data: { payCadence } });
  }

  it('defaults to biweekly, so an untouched budget reads exactly as before', async () => {
    await elevenMonthsAt130();

    const settings = await prisma.budgetSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(settings.payCadence).toBe('biweekly');

    const view = await buildUtilities(prisma, NOW);
    expect(view.cyclesPerYear).toBe(26);
    // The figure this page has always shown: 13000 × 12 ÷ 26.
    expect(view.summaries[0]?.suggestedPerCycleCents).toBe(6_000n);
  });

  it.each([
    ['weekly', 52, 3_000n],
    ['biweekly', 26, 6_000n],
    ['semimonthly', 24, 6_500n],
    ['monthly', 12, 13_000n],
  ])('spreads $130 a month over %s', async (cadence, cyclesPerYear, expected) => {
    await elevenMonthsAt130();
    await setCadence(cadence as PayCadence);

    const view = await buildUtilities(prisma, NOW);
    expect(view.cyclesPerYear).toBe(cyclesPerYear);
    expect(view.summaries[0]?.suggestedPerCycleCents).toBe(expected);
  });

  /**
   * The monthly average is a property of the bills, not of when anyone is paid.
   * If changing cadence moved it, the two figures on the card would stop being
   * comparable and the page would be lying about what it divided.
   */
  it('changes the suggestion and nothing else', async () => {
    await elevenMonthsAt130();

    const before = await buildUtilities(prisma, NOW);
    await setCadence('monthly');
    const after = await buildUtilities(prisma, NOW);

    expect(after.summaries[0]?.averageCents).toBe(before.summaries[0]?.averageCents);
    expect(after.summaries[0]?.months).toEqual(before.summaries[0]?.months);
    expect(after.summaries[0]?.amountToDelegateCents).toBe(
      before.summaries[0]?.amountToDelegateCents,
    );
    expect(after.summaries[0]?.suggestedPerCycleCents).not.toBe(
      before.summaries[0]?.suggestedPerCycleCents,
    );
  });

  /**
   * The amount to delegate is per Delegate press, and this deliberately does
   * not rescale it — the owner's decision, stated in the interface rather than
   * acted on.
   */
  it('leaves every amount to delegate exactly where it was', async () => {
    await elevenMonthsAt130();
    const before = await prisma.delegation.findMany({
      select: { id: true, amountToDelegateCents: true },
      orderBy: { id: 'asc' },
    });

    await setCadence('weekly');
    await buildUtilities(prisma, NOW);

    const after = await prisma.delegation.findMany({
      select: { id: true, amountToDelegateCents: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
  });
});
