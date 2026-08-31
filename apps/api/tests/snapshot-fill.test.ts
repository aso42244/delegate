import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { appendEvent } from '../src/domain/ledger.js';
import { fillGaps, missingDates, rebuildDay } from '../src/domain/snapshot-fill.js';
import { captureSnapshot } from '../src/domain/snapshots.js';
import { makeAccount, makeDelegation, makeHolding, resetDatabase } from './helpers.js';

/**
 * Repairing days nobody was running for. See ADR 035.
 *
 * Each strategy has one property worth protecting, and most of them are about
 * *not* quietly producing a number that looks like a fact. The liability case
 * has its own block because getting the sign backwards would move every card
 * balance the wrong way while leaving the identity looking perfectly healthy.
 */

/**
 * The household's zone. Snapshot dates are local days, so which instant falls in
 * which day — and therefore which side of a boundary a transaction lands on —
 * is decided by this. See ADR 037.
 */
const ZONE = 'America/Chicago';

/** A snapshot date — a decided calendar day, filed at midnight UTC. */
const day = (n: number): Date => new Date(Date.UTC(2026, 7, n));

/**
 * An *instant* in the middle of that day, here.
 *
 * The distinction the fixtures have to keep straight, and the reason two of them
 * were wrong: `day(21)` is midnight UTC, which is seven in the evening on the
 * **20th** in Chicago. A ledger event written at `day(21)` therefore happened on
 * the 20th, and a test that meant "on the 21st" has to say so with an instant
 * that is unambiguously inside it. See ADR 037.
 */
const noon = (n: number): Date => new Date(Date.UTC(2026, 7, n, 17));

beforeEach(async () => {
  await resetDatabase();
});

/** A SimpleFIN account, which is the only kind reconstruction walks back. */
async function makeFedAccount(
  name: string,
  type: 'asset' | 'debt',
  balanceCents: bigint,
): Promise<{ id: string }> {
  return prisma.account.create({
    data: {
      name,
      type,
      source: 'simplefin',
      externalId: `ext-${name}`,
      balanceCents,
      inBudget: true,
      inNetWorth: true,
      createdAt: noon(1),
    },
    select: { id: true },
  });
}

async function post(
  accountId: string,
  amountCents: bigint,
  on: Date,
  options: { pending?: boolean; archived?: boolean } = {},
): Promise<void> {
  await prisma.transaction.create({
    data: {
      accountId,
      postedAt: new Date(on.getTime() + 12 * 60 * 60 * 1000),
      amountCents,
      descriptionRaw: 'TEST',
      description: 'Test',
      source: 'simplefin',
      pending: options.pending ?? false,
      archivedAt: options.archived ? new Date() : null,
    },
  });
}

// ---------------------------------------------------------------------------

describe('finding the gap', () => {
  /**
   * The no-backfill rule, and the one place it could be quietly undone. With no
   * snapshot stored there is no gap — only history nobody chose to record.
   */
  it('finds nothing to fill when nothing has ever been recorded', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: noon(1) });

    expect((await missingDates(prisma, day(27))).dates).toEqual([]);
    expect((await fillGaps(prisma, day(27), ZONE)).filled).toBe(0);
    expect(await prisma.aggregateSnapshot.count()).toBe(0);
  });

  it('lists the days between the newest snapshot and the date asked for', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: noon(1) });
    await captureSnapshot(prisma, day(20));

    const gap = await missingDates(prisma, day(24));
    expect(gap.dates.map((date) => date.toISOString().slice(0, 10))).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
    ]);
  });

  it('finds nothing when the newest snapshot is already current', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: noon(1) });
    await captureSnapshot(prisma, day(24));
    expect((await missingDates(prisma, day(24))).dates).toEqual([]);
  });
});

describe('delegations', () => {
  /**
   * **Exact, always.** The ledger is the truth and all of it is still there, so
   * gap length is irrelevant.
   */
  it('replays the ledger to the end of the missing day', async () => {
    const grocery = await makeDelegation({ name: 'Grocery', createdAt: noon(1) });
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: noon(1) });

    // $100 on the 21st, another $50 on the 23rd.
    await appendEvent(prisma, {
      delegationId: grocery.id,
      deltaCents: 10_000n,
      eventType: 'adjust',
      occurredAt: noon(21),
    });
    await appendEvent(prisma, {
      delegationId: grocery.id,
      deltaCents: 5_000n,
      eventType: 'adjust',
      occurredAt: noon(23),
    });

    const rebuilt = await rebuildDay(prisma, day(22), ZONE);
    const row = rebuilt.delegations.find((entry) => entry.delegationId === grocery.id);

    // The 22nd sees the first movement and not the second.
    expect(row?.balanceCents).toBe(10_000n);
    expect(row?.provenance).toBe('reconstructed');
  });

  /**
   * Where the day ends, exactly.
   *
   * A snapshot date is a local day and `occurred_at` is an instant, so the cut
   * has to be local midnight. An event at ten in the evening belongs to the day
   * it happened on; cut in UTC it would land in the next one, and the chart
   * would show the money moving a day late.
   */
  it('cuts the day at local midnight, not at midnight UTC', async () => {
    const grocery = await makeDelegation({ name: 'Grocery', createdAt: noon(1) });
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 1n, createdAt: noon(1) });

    await appendEvent(prisma, {
      delegationId: grocery.id,
      deltaCents: 10_000n,
      eventType: 'adjust',
      // 22:00 on the 22nd, CDT — already the 23rd in UTC.
      occurredAt: new Date(Date.UTC(2026, 7, 23, 3)),
    });

    const onTheDay = await rebuildDay(prisma, day(22), ZONE);
    expect(onTheDay.delegations[0]?.balanceCents).toBe(10_000n);

    // And the day before still has nothing, so the boundary moved rather than
    // the whole window sliding.
    const before = await rebuildDay(prisma, day(21), ZONE);
    expect(before.delegations[0]?.balanceCents).toBe(0n);
  });

  /**
   * A reconstruction has to agree with the number the application would compute
   * directly, or the chart and the budget tell different stories.
   */
  it('matches the balance computed straight from the events', async () => {
    const grocery = await makeDelegation({ name: 'Grocery', createdAt: noon(1) });
    for (const [n, amount] of [
      [21, 30_000n],
      [22, -4_500n],
      [23, 12_000n],
    ] as const) {
      await appendEvent(prisma, {
        delegationId: grocery.id,
        deltaCents: amount,
        eventType: 'adjust',
        occurredAt: noon(n),
      });
    }

    const rebuilt = await rebuildDay(prisma, day(25), ZONE);
    const direct = await prisma.delegation.findUniqueOrThrow({
      where: { id: grocery.id },
      select: { balanceCents: true },
    });

    expect(rebuilt.delegations[0]?.balanceCents).toBe(direct.balanceCents);
  });

  it('leaves out a delegation that did not exist yet', async () => {
    await prisma.delegation.create({ data: { name: 'New', createdAt: noon(25) } });
    const rebuilt = await rebuildDay(prisma, day(22), ZONE);
    expect(rebuilt.delegations).toHaveLength(0);
  });
});

describe('a SimpleFIN account', () => {
  /**
   * Walk the next known balance backwards through everything posted since.
   */
  it('lands on the right number across a multi-day gap', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(22));
    await post(checking.id, -25_000n, day(24));

    // $5,000 now. The 23rd is before the $250 charge and after the $100 one.
    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    const row = rebuilt.accounts.find((entry) => entry.accountId === checking.id);

    expect(row?.balanceCents).toBe(525_000n);
    expect(row?.provenance).toBe('reconstructed');
  });

  /**
   * The same boundary, on the other side of the walk.
   *
   * The reconstruction rolls back everything posted *after* the day being
   * rebuilt. A charge at ten in the evening is inside that day and must not be
   * rolled back out of it; in UTC it reads as the next day and would be.
   */
  it('keeps a late-evening charge inside the day it was made', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    // 22:00 on the 23rd, CDT — the 24th in UTC.
    await prisma.transaction.create({
      data: {
        accountId: checking.id,
        postedAt: new Date(Date.UTC(2026, 7, 24, 3)),
        amountCents: -10_000n,
        descriptionRaw: 'LATE',
        description: 'Late',
        source: 'simplefin',
      },
    });

    // The 23rd already includes the charge, so its balance is today's.
    const onTheDay = await rebuildDay(prisma, day(23), ZONE);
    expect(onTheDay.accounts.find((entry) => entry.accountId === checking.id)?.balanceCents).toBe(
      500_000n,
    );

    // The 22nd predates it, so it is rolled back out.
    const before = await rebuildDay(prisma, day(22), ZONE);
    expect(before.accounts.find((entry) => entry.accountId === checking.id)?.balanceCents).toBe(
      510_000n,
    );
  });

  /**
   * **The sign convention.** A charge on a card *raises* what is owed, so
   * walking backwards has to *lower* it. Getting this backwards keeps the
   * identity balanced while showing every debt moving the wrong way, which is
   * exactly why it goes through `accountBalanceDelta`.
   */
  it('walks a liability account the right way across a gap', async () => {
    const card = await makeFedAccount('Card', 'debt', 80_000n);
    // History reaching back past the gap, so the walk is exact rather than an
    // estimate — this test is about the direction, not about the cut-off.
    await post(card.id, -1_000n, day(5));
    // A $300 charge on the 24th. Debt balances are positive magnitudes, so this
    // took the card from $500 owed to $800 owed.
    await post(card.id, -30_000n, day(24));

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    const row = rebuilt.accounts.find((entry) => entry.accountId === card.id);

    // Before the charge the card owed $500 — less than it owes now, not more.
    expect(row?.balanceCents).toBe(50_000n);
    expect(row?.provenance).toBe('reconstructed');
  });

  it('walks a payment on a liability account the right way too', async () => {
    const card = await makeFedAccount('Card', 'debt', 20_000n);
    await post(card.id, -1_000n, day(5));
    // A $400 payment on the 24th reduced what is owed.
    await post(card.id, 40_000n, day(24));

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(60_000n);
  });

  /**
   * A pending charge is not in the institution's settled balance, so subtracting
   * it would push the reconstruction off by its amount.
   */
  it('ignores pending transactions', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(24), { pending: true });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(500_000n);
  });

  /**
   * Whatever an archived transaction once did to the balance was reversed when
   * it was archived, so the live balance already has it out.
   */
  it('ignores archived transactions', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(24), { archived: true });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(500_000n);
  });

  /**
   * Anchoring on the next stored snapshot rather than on today, so a long gap
   * does not have to be walked back through months of movement.
   */
  it('anchors on the next stored snapshot when there is one', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 999_999n);
    await prisma.accountSnapshot.create({
      data: {
        snapshotDate: day(24),
        accountId: checking.id,
        balanceCents: 500_000n,
        provenance: 'observed',
        accountType: 'asset',
        inBudget: true,
        inNetWorth: true,
      },
    });
    // Posted after the anchor: it moved the live balance and must not be rolled
    // back out of a figure that predates it.
    await post(checking.id, -70_000n, day(26));
    // Posted between the missing day and the anchor: this one does count.
    await post(checking.id, -20_000n, day(24));

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(520_000n);
  });

  /**
   * **Rule 5's only legitimate trigger for a fed account.** Before the earliest
   * transaction this produces a flat line at the oldest reconstructable balance,
   * which looks like data and is not — so the number is kept and stops calling
   * itself exact.
   */
  it('marks a date before its transaction history as an estimate', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(24));

    const rebuilt = await rebuildDay(prisma, day(20), ZONE);
    expect(rebuilt.accounts[0]?.provenance).toBe('interpolated');
  });

  it('marks an account with no transactions at all as an estimate', async () => {
    await makeFedAccount('Checking', 'asset', 500_000n);
    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.provenance).toBe('interpolated');
  });
});

describe('a manual account', () => {
  /**
   * **Steps, not slopes.** If property was $400,000 and $420,000 was entered on
   * the 24th, the 23rd was $400,000 — not something in between.
   */
  it('carries the last value entered on or before the date', async () => {
    const house = await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 42_000_000n,
      createdAt: noon(1),
    });
    await prisma.accountValuation.createMany({
      data: [
        { accountId: house.id, valueCents: 40_000_000n, asOf: day(10) },
        { accountId: house.id, valueCents: 42_000_000n, asOf: day(24) },
      ],
    });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    const row = rebuilt.accounts.find((entry) => entry.accountId === house.id);

    expect(row?.balanceCents).toBe(40_000_000n);
    expect(row?.provenance).toBe('carried');
  });

  it('does not interpolate between two entered values', async () => {
    const house = await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 42_000_000n,
      createdAt: noon(1),
    });
    await prisma.accountValuation.createMany({
      data: [
        { accountId: house.id, valueCents: 40_000_000n, asOf: day(10) },
        { accountId: house.id, valueCents: 42_000_000n, asOf: day(24) },
      ],
    });

    // The midpoint would be $410,000. A step function never produces it.
    for (const n of [11, 15, 20, 23]) {
      const rebuilt = await rebuildDay(prisma, day(n), ZONE);
      expect(rebuilt.accounts[0]?.balanceCents).toBe(40_000_000n);
    }
  });

  it('takes a value entered on the day itself', async () => {
    const house = await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 42_000_000n,
      createdAt: noon(1),
    });
    await prisma.accountValuation.create({
      data: { accountId: house.id, valueCents: 41_000_000n, asOf: day(23) },
    });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(41_000_000n);
  });

  /**
   * A balance typed on Settings → Accounts is a dated valuation now. Before it
   * was, cash and the exchange accounts had no history at all and there was
   * nothing for this rule to carry.
   */
  it('has something to carry, because typing a balance records one', async () => {
    const cash = await makeAccount({
      name: 'Cash',
      type: 'asset',
      balanceCents: 20_000n,
      createdAt: noon(1),
    });
    const { updateAccount } = await import('../src/domain/accounts.js');
    await updateAccount(prisma, cash.id, { balanceCents: 35_000n, timeZone: ZONE }, noon(24));

    const valuation = await prisma.accountValuation.findFirst({
      where: { accountId: cash.id },
      select: { valueCents: true, asOf: true },
    });
    expect(valuation?.valueCents).toBe(35_000n);
    expect(valuation?.asOf.toISOString().slice(0, 10)).toBe('2026-08-24');
  });
});

describe('a Bitcoin holding', () => {
  /**
   * The quantity is a dated ledger, so what was held is a fact rather than a
   * carry. Only the price can be missing.
   */
  it('uses the quantity held on the date, not the quantity held now', async () => {
    const holding = await makeHolding({
      name: 'Cold storage',
      sats: 0n,
      heldSince: day(1),
      createdAt: noon(1),
    });
    await prisma.bitcoinHoldingEvent.create({
      data: {
        accountId: holding.id,
        occurredAt: day(10),
        deltaSats: 50_000_000n,
        eventType: 'purchase',
      },
    });
    await prisma.bitcoinHoldingEvent.create({
      data: {
        accountId: holding.id,
        occurredAt: day(24),
        deltaSats: 50_000_000n,
        eventType: 'purchase',
      },
    });
    await prisma.account.update({
      where: { id: holding.id },
      data: { bitcoinSats: 100_000_000n },
    });
    await prisma.bitcoinPrice.create({
      data: { priceDate: day(23), priceCents: 10_000_000n, source: 'test', isClose: true },
    });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    const row = rebuilt.accounts.find((entry) => entry.accountId === holding.id);

    // Half a Bitcoin on the 23rd, not the whole one held now.
    expect(row?.quantitySats).toBe(50_000_000n);
    expect(row?.balanceCents).toBe(5_000_000n);
    expect(row?.provenance).toBe('reconstructed');
  });

  it('is an estimate when the price had to be carried', async () => {
    await makeHolding({
      name: 'Cold storage',
      sats: 50_000_000n,
      heldSince: day(1),
      createdAt: noon(1),
    });
    await prisma.bitcoinPrice.create({
      data: { priceDate: day(10), priceCents: 9_000_000n, source: 'test', isClose: true },
    });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.provenance).toBe('interpolated');
  });
});

describe('interpolation', () => {
  /**
   * Rule 5 is a last resort. Every account here has an exact method available,
   * so none of them may reach for it.
   */
  it('does not fire when an exact method exists', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));

    const house = await makeAccount({
      name: 'House',
      type: 'asset',
      balanceCents: 40_000_000n,
      createdAt: noon(1),
    });
    await prisma.accountValuation.create({
      data: { accountId: house.id, valueCents: 40_000_000n, asOf: day(10) },
    });

    const grocery = await makeDelegation({ name: 'Grocery', createdAt: noon(1) });
    await appendEvent(prisma, {
      delegationId: grocery.id,
      deltaCents: 10_000n,
      eventType: 'adjust',
      occurredAt: noon(20),
    });

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts.map((row) => row.provenance).sort()).toEqual([
      'carried',
      'reconstructed',
    ]);
    expect(rebuilt.delegations[0]?.provenance).toBe('reconstructed');
    expect(rebuilt.aggregate.provenance).toBe('carried');
  });

  it('takes the midpoint between the two nearest stored values', async () => {
    const cash = await makeAccount({
      name: 'Cash',
      type: 'asset',
      balanceCents: 99_999n,
      createdAt: noon(1),
    });
    for (const [n, value] of [
      [20, 10_000n],
      [26, 20_000n],
    ] as const) {
      await prisma.accountSnapshot.create({
        data: {
          snapshotDate: day(n),
          accountId: cash.id,
          balanceCents: value,
          provenance: 'observed',
          accountType: 'asset',
          inBudget: true,
          inNetWorth: true,
        },
      });
    }

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts[0]?.balanceCents).toBe(15_000n);
    expect(rebuilt.accounts[0]?.provenance).toBe('interpolated');
  });
});

describe('the rebuilt aggregate', () => {
  /**
   * One estimated account makes the day an estimate, however many exact rows sat
   * beside it.
   */
  it('takes the weakest provenance among its inputs', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));
    // No transactions and no history: an estimate.
    await makeFedAccount('Savings', 'asset', 100_000n);

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.accounts.some((row) => row.provenance === 'reconstructed')).toBe(true);
    expect(rebuilt.aggregate.provenance).toBe('interpolated');
  });

  it('is never observed, because nothing here was seen', async () => {
    await makeAccount({ name: 'Cash', type: 'asset', balanceCents: 1n, createdAt: noon(1) });
    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.aggregate.provenance).not.toBe('observed');
  });

  it('sums the scopes from the rows it rebuilt', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));
    const card = await makeFedAccount('Card', 'debt', 20_000n);
    await post(card.id, -5_000n, day(20));

    const rebuilt = await rebuildDay(prisma, day(23), ZONE);
    expect(rebuilt.aggregate.netWorthAssetsCents).toBe(500_000n);
    expect(rebuilt.aggregate.netWorthDebtsCents).toBe(20_000n);
    expect(rebuilt.aggregate.netWorthCents).toBe(480_000n);
  });
});

describe('filling a run of days', () => {
  it('writes every missing day, and stops at the one asked for', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));
    await captureSnapshot(prisma, day(21));

    const result = await fillGaps(prisma, day(25), ZONE);

    expect(result.filled).toBe(4);
    const dates = await prisma.aggregateSnapshot.findMany({
      orderBy: { snapshotDate: 'asc' },
      select: { snapshotDate: true },
    });
    expect(dates.map((row) => row.snapshotDate.toISOString().slice(0, 10))).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
    ]);
  });

  /**
   * The rule that makes a fill safe to re-run: it repairs what is missing and
   * revises nothing that was seen.
   */
  it('leaves an observed day inside the range alone', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));
    await captureSnapshot(prisma, day(21));

    // An observation in the middle of what will become the gap.
    await prisma.account.update({
      where: { id: checking.id },
      data: { balanceCents: 777_000n },
    });
    await captureSnapshot(prisma, day(23));
    await prisma.account.update({
      where: { id: checking.id },
      data: { balanceCents: 500_000n },
    });

    await fillGaps(prisma, day(25), ZONE);

    const observed = await prisma.accountSnapshot.findFirstOrThrow({
      where: { snapshotDate: day(23) },
      select: { balanceCents: true, provenance: true },
    });
    expect(observed).toEqual({ balanceCents: 777_000n, provenance: 'observed' });
  });

  it('is idempotent: filling twice changes nothing', async () => {
    const checking = await makeFedAccount('Checking', 'asset', 500_000n);
    await post(checking.id, -10_000n, day(20));
    await captureSnapshot(prisma, day(21));

    await fillGaps(prisma, day(24), ZONE);
    const before = await prisma.aggregateSnapshot.findMany({ orderBy: { snapshotDate: 'asc' } });

    const second = await fillGaps(prisma, day(24), ZONE);
    expect(second.filled).toBe(0);

    const after = await prisma.aggregateSnapshot.findMany({ orderBy: { snapshotDate: 'asc' } });
    expect(after).toEqual(before);
  });
});
