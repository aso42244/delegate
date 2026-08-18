import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { recordSpotPrice } from '../src/domain/bitcoin.js';
import { equitySeries, netWorthSeries, singleAccountSeries } from '../src/domain/history.js';
import { recordValuation } from '../src/domain/valuations.js';
import { makeAccount, makeHolding, makeTransaction, resetDatabase } from './helpers.js';

/**
 * Balances reconstructed from the ledger — ADR 013.
 *
 * The place this goes wrong is the sign on a debt. A card balance is stored as a
 * positive magnitude while a charge is a negative amount, so rolling a charge
 * backwards has to *lower* the historical balance rather than raise it. Getting
 * that backwards would draw a card trend that moves the wrong way while today's
 * figure stayed correct — which is exactly the kind of wrong nobody notices.
 */

const NOW = new Date('2026-08-09T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

describe('an asset', () => {
  it('rolls spending backwards to a higher earlier balance', async () => {
    const account = await makeAccount({
      name: 'Everyday',
      type: 'asset',
      balanceCents: 90_000n,
    });
    // An older transaction so the series has somewhere to start; a series only
    // reaches back as far as the earliest one it holds.
    await makeTransaction({
      accountId: account.id,
      amountCents: -1_000n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    // $100 spent since the 4th; before it the balance was $1,000.
    await makeTransaction({
      accountId: account.id,
      amountCents: -10_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });

    const series = await singleAccountSeries(prisma, account.id, 10, NOW);
    const onTheFourth = series.points.find(
      (point) => point.date.toISOString() === '2026-08-04T00:00:00.000Z',
    );
    const last = series.points[series.points.length - 1];

    expect(onTheFourth?.valueCents).toBe(100_000n);
    expect(last?.valueCents).toBe(90_000n);
  });
});

describe('a debt', () => {
  /** The sign convention that would be easy to invert and hard to spot. */
  it('rolls a charge backwards to a lower earlier balance', async () => {
    const card = await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });
    await makeTransaction({
      accountId: card.id,
      amountCents: -500n,
      postedAt: new Date('2026-08-01T00:00:00Z'),
    });
    // A $100 charge on the 5th. Before it, $400 was owed — not $600.
    await makeTransaction({
      accountId: card.id,
      amountCents: -10_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });

    const series = await singleAccountSeries(prisma, card.id, 10, NOW);
    const onTheFourth = series.points.find(
      (point) => point.date.toISOString() === '2026-08-04T00:00:00.000Z',
    );

    expect(onTheFourth?.valueCents).toBe(40_000n);
    expect(series.points[series.points.length - 1]?.valueCents).toBe(50_000n);
  });
});

describe('how far back a series goes', () => {
  /**
   * Reaching past the earliest transaction would draw a flat line at the oldest
   * reconstructable balance, which reads as data and is not.
   */
  it('starts at the earliest transaction and says it was cut short', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 50_000n });
    await makeTransaction({
      accountId: account.id,
      amountCents: -1_000n,
      postedAt: new Date('2026-08-06T00:00:00Z'),
    });

    const series = await singleAccountSeries(prisma, account.id, 30, NOW);

    expect(series.truncated).toBe(true);
    expect(series.earliestKnown?.toISOString()).toBe('2026-08-06T00:00:00.000Z');
    // Four days: the 6th through the 9th.
    expect(series.points).toHaveLength(4);
  });

  it('is empty rather than flat when there is no history at all', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 50_000n });

    const series = await netWorthSeries(prisma, 30, NOW);
    expect(series.points).toEqual([]);
    expect(series.earliestKnown).toBeNull();
  });
});

describe('net worth', () => {
  it('subtracts debts and counts off-budget accounts', async () => {
    const house = await makeAccount({
      name: 'The house',
      type: 'asset',
      balanceCents: 0n,
      inBudget: false,
      inNetWorth: true,
    });
    await recordValuation(prisma, {
      accountId: house.id,
      valueCents: 45_000_000n,
      asOf: new Date('2026-08-01T00:00:00Z'),
    });

    const mortgage = await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
      inNetWorth: true,
    });
    await makeTransaction({
      accountId: mortgage.id,
      amountCents: -100_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });

    const series = await netWorthSeries(prisma, 10, NOW);
    const last = series.points[series.points.length - 1];

    // $450,000 held less $250,000 owed.
    expect(last?.valueCents).toBe(20_000_000n);
  });

  it('excludes an account that is not in net worth', async () => {
    const account = await makeAccount({
      name: 'Excluded',
      type: 'asset',
      balanceCents: 90_000n,
      inNetWorth: false,
    });
    await makeTransaction({
      accountId: account.id,
      amountCents: -10_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });

    const series = await netWorthSeries(prisma, 10, NOW);
    expect(series.points).toEqual([]);
  });
});

describe('a Bitcoin holding', () => {
  it('is valued at the price on each date, not at today"s price', async () => {
    // 0.5 BTC, held since long before this window — so the question under test
    // is the price on each date rather than the quantity on each date.
    await makeHolding({ name: 'Hardware wallet', sats: 50_000_000n, inNetWorth: true });

    await recordSpotPrice(
      prisma,
      { priceCents: 10_000_000n, source: 'coingecko' },
      new Date('2026-08-07T12:00:00Z'),
    );
    await recordSpotPrice(
      prisma,
      { priceCents: 20_000_000n, source: 'coingecko' },
      new Date('2026-08-09T12:00:00Z'),
    );

    const series = await netWorthSeries(prisma, 5, NOW);
    const onSeventh = series.points.find(
      (point) => point.date.toISOString() === '2026-08-07T00:00:00.000Z',
    );
    const today = series.points[series.points.length - 1];

    // Half of $100,000 then, half of $200,000 now — today's price is not applied
    // backwards, which is the whole reason the close is cached.
    expect(onSeventh?.valueCents).toBe(5_000_000n);
    expect(today?.valueCents).toBe(10_000_000n);
  });
});

describe('equity over time', () => {
  it('is the property less the mortgage on each date', async () => {
    const house = await makeAccount({
      name: 'The house',
      type: 'asset',
      balanceCents: 0n,
      inBudget: false,
    });
    const mortgage = await makeAccount({
      name: 'Mortgage',
      type: 'debt',
      balanceCents: 25_000_000n,
      inBudget: false,
    });
    await prisma.account.update({
      where: { id: house.id },
      data: { mortgageAccountId: mortgage.id },
    });

    await recordValuation(prisma, {
      accountId: house.id,
      valueCents: 45_000_000n,
      asOf: new Date('2026-08-01T00:00:00Z'),
    });
    await makeTransaction({
      accountId: mortgage.id,
      amountCents: -100_000n,
      postedAt: new Date('2026-08-05T00:00:00Z'),
    });

    const series = await equitySeries(prisma, house.id, 10, NOW);
    const last = series.points[series.points.length - 1];

    expect(last?.valueCents).toBe(20_000_000n);
  });

  it('is empty when no mortgage is linked', async () => {
    const house = await makeAccount({ name: 'The house', type: 'asset', balanceCents: 100n });

    const series = await equitySeries(prisma, house.id, 10, NOW);
    expect(series.points).toEqual([]);
  });
});
