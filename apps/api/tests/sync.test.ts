import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { guessAccountType, runSync } from '../src/domain/sync.js';
import { createRule } from '../src/domain/rules.js';
import { parseFeedAmount } from '../src/simplefin/protocol.js';
import {
  delegationBalance,
  ledgerBalances,
  makeDelegation,
  makeUser,
  resetDatabase,
} from './helpers.js';
import {
  accountSet,
  epochDaysAfter,
  EPOCH_2026_08_01,
  FailingSimpleFinClient,
  legacyAccountSet,
  ScriptedSimpleFinClient,
} from './simplefin-fixtures.js';

/**
 * SimpleFIN sync.
 *
 * The cases that carry real risk are idempotency and the pending lifecycle: a
 * duplicated transaction or a pending charge counted twice moves the owner's
 * envelopes by real money, and neither is obvious from the UI afterwards.
 */

const NOW = new Date('2026-08-08T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

async function sync(client: ScriptedSimpleFinClient, now: Date = NOW): ReturnType<typeof runSync> {
  return runSync(prisma, { client, now });
}

describe('parsing feed amounts', () => {
  it('reads decimal strings as exact cents', () => {
    expect(parseFeedAmount('-33.45')).toBe(-3345n);
    expect(parseFeedAmount('1200')).toBe(120000n);
    expect(parseFeedAmount('0.07')).toBe(7n);
  });

  it('tolerates padding zeros beyond two decimal places', () => {
    // Some institutions pad; trailing zeros carry no value.
    expect(parseFeedAmount('-33.450')).toBe(-3345n);
    expect(parseFeedAmount('12.000000')).toBe(1200n);
  });

  it('refuses genuine sub-cent precision rather than rounding it away', () => {
    // Silently turning 33.456 into 33.46 is worse than a visible failure.
    expect(() => parseFeedAmount('33.456')).toThrow();
  });
});

describe('guessing an account type', () => {
  it('reads the name first', () => {
    expect(guessAccountType('Everyday Credit Card', 0n)).toBe('debt');
    expect(guessAccountType('Home Mortgage', 0n)).toBe('debt');
  });

  it('falls back to the sign of the balance', () => {
    expect(guessAccountType('Something Unusual', -5000n)).toBe('debt');
    expect(guessAccountType('Something Unusual', 5000n)).toBe('asset');
  });
});

describe('discovering accounts', () => {
  it('creates a discovered account in budget, in net worth, and flagged for review', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-1', name: 'Everyday Checking', balance: '2500.00' }]),
    ]);

    await sync(client);

    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-1' } });
    expect(account.type).toBe('asset');
    expect(account.inBudget).toBe(true);
    expect(account.inNetWorth).toBe(true);
    // The type is a guess, so the owner is asked to confirm it.
    expect(account.needsReview).toBe(true);
    expect(account.balanceCents).toBe(250000n);
  });

  it('stores a debt balance as a positive magnitude, so the identity can subtract it', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-2', name: 'Rewards Credit Card', balance: '-543.21' }]),
    ]);

    await sync(client);

    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-2' } });
    expect(account.type).toBe('debt');
    expect(account.balanceCents).toBe(54321n);
  });

  it('never re-guesses the type of an account the owner has already set', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-3', name: 'Savings', balance: '100.00' }]),
      accountSet([{ id: 'acct-3', name: 'Savings', balance: '-100.00' }]),
    ]);

    await sync(client);
    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-3' } });
    await prisma.account.update({ where: { id: account.id }, data: { needsReview: false } });

    // A balance that dips negative must not silently flip an asset into a debt.
    await sync(client, new Date(NOW.getTime() + 60_000));

    const after = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-3' } });
    expect(after.type).toBe('asset');
    expect(after.balanceCents).toBe(-10000n);
  });

  it('reads the institution name too when guessing the type', async () => {
    // Shape taken from a real feed: the institution carries "Credit Card" and the
    // account name is just the holder. Guessing from the account name alone read
    // this as an asset, which adds to the identity instead of subtracting.
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-card', name: 'A Person (7169)', balance: '120.00' }], {
        institution: 'Discover Credit Card',
      }),
    ]);

    await sync(client);

    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-card' } });
    expect(account.type).toBe('debt');
  });

  it('skips a non-USD account and reports why', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-eur', name: 'Euro Account', balance: '10.00', currency: 'EUR' }]),
    ]);

    const summary = await sync(client);

    expect(await prisma.account.count()).toBe(0);
    expect(summary.errors.join(' ')).toMatch(/USD only/);
  });

  it('reads the legacy protocol shape as well as the current one', async () => {
    const client = new ScriptedSimpleFinClient([
      legacyAccountSet([{ id: 'acct-v1', name: 'Old Format Checking', balance: '42.00' }]),
    ]);

    await sync(client);

    expect(await prisma.account.findFirst({ where: { externalId: 'acct-v1' } })).not.toBeNull();
  });
});

describe('idempotency', () => {
  const payload = accountSet([
    {
      id: 'acct-1',
      name: 'Everyday Checking',
      balance: '2500.00',
      transactions: [
        { id: 'txn-1', amount: '-42.10', description: 'Grocery store' },
        { id: 'txn-2', amount: '-8.75', description: 'Coffee' },
      ],
    },
  ]);

  it('imports each transaction once', async () => {
    const client = new ScriptedSimpleFinClient([payload]);
    const summary = await sync(client);

    expect(summary.transactionsAdded).toBe(2);
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('adds nothing on a re-run of the identical payload', async () => {
    const client = new ScriptedSimpleFinClient([payload, payload]);

    await sync(client);
    const second = await sync(client, new Date(NOW.getTime() + 60_000));

    // Re-running must never duplicate: the unique index is on account + feed id.
    expect(second.transactionsAdded).toBe(0);
    expect(second.transactionsUpdated).toBe(0);
    expect(await prisma.transaction.count()).toBe(2);
  });

  it('updates a description in place rather than inserting a second row', async () => {
    const client = new ScriptedSimpleFinClient([
      payload,
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            { id: 'txn-1', amount: '-42.10', description: 'GROCERY STORE #114' },
            { id: 'txn-2', amount: '-8.75', description: 'Coffee' },
          ],
        },
      ]),
    ]);

    await sync(client);
    const second = await sync(client, new Date(NOW.getTime() + 60_000));

    expect(second.transactionsUpdated).toBe(1);
    expect(await prisma.transaction.count()).toBe(2);
  });
});

describe('backfill window', () => {
  it('requests twelve months on the first run', async () => {
    const client = new ScriptedSimpleFinClient([accountSet([])]);

    await sync(client);

    const [call] = client.calls;
    const monthsBack =
      (NOW.getFullYear() - call!.startDate!.getFullYear()) * 12 +
      (NOW.getMonth() - call!.startDate!.getMonth());
    expect(monthsBack).toBe(12);
  });

  it('requests only a short overlap once a run has succeeded', async () => {
    const client = new ScriptedSimpleFinClient([accountSet([]), accountSet([])]);

    await sync(client);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await sync(client, later);

    // The last call is the incremental sync: the first run is a backfill and is
    // split into several windowed requests ahead of it.
    const incremental = client.calls.at(-1);
    const daysBack = (later.getTime() - incremental!.startDate!.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysBack).toBeGreaterThan(6);
    expect(daysBack).toBeLessThan(9);
  });
});

describe('pending transactions', () => {
  /** Categorizes a transaction so the pending row has a real effect to preserve or undo. */
  async function categorizeFirstPending(delegationId: string): Promise<string> {
    const pending = await prisma.transaction.findFirstOrThrow({ where: { pending: true } });
    const actor = await makeUser('owner');
    await categorizeTransaction(prisma, pending.id, delegationId, { actorId: actor.id });
    return pending.id;
  }

  it('lets a pending transaction move a delegation immediately', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [{ id: 'pend-1', amount: '-50.00', description: 'Grocery', pending: true }],
        },
      ]),
    ]);

    await sync(client);
    await categorizeFirstPending(grocery.id);

    expect(await delegationBalance(grocery.id)).toBe(-5000n);
  });

  it('carries the categorization across when the same id stops being pending', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [{ id: 'pend-1', amount: '-50.00', description: 'Grocery', pending: true }],
        },
      ]),
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2450.00',
          transactions: [
            { id: 'pend-1', amount: '-50.00', description: 'Grocery', pending: false },
          ],
        },
      ]),
    ]);

    await sync(client);
    await categorizeFirstPending(grocery.id);
    await sync(client, new Date(NOW.getTime() + 60_000));

    const settled = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'pend-1' } });
    expect(settled.pending).toBe(false);
    // Counted exactly once: the row is the same row, so nothing moved twice.
    expect(await delegationBalance(grocery.id)).toBe(-5000n);
  });

  it('carries the categorization across when the bank re-issues it under a new id', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            {
              id: 'pend-1',
              amount: '-50.00',
              description: 'Grocery',
              pending: true,
              transacted_at: EPOCH_2026_08_01,
            },
          ],
        },
      ]),
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2450.00',
          transactions: [
            {
              id: 'posted-9',
              amount: '-50.00',
              description: 'GROCERY STORE #114',
              posted: epochDaysAfter(EPOCH_2026_08_01, 2),
            },
          ],
        },
      ]),
    ]);

    await sync(client);
    const pendingId = await categorizeFirstPending(grocery.id);
    await sync(client, new Date(NOW.getTime() + 60_000));

    const settled = await prisma.transaction.findFirstOrThrow({
      where: { externalId: 'posted-9' },
    });
    expect(settled.pending).toBe(false);

    // The categorization moved to the posted row, and the spend still counts once.
    const allocations = await prisma.transactionAllocation.findMany({
      where: { transactionId: settled.id },
    });
    expect(allocations).toHaveLength(1);
    expect(await delegationBalance(grocery.id)).toBe(-5000n);

    // The pending row is archived, never deleted.
    const retired = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingId } });
    expect(retired.archivedAt).not.toBeNull();
  });

  it('reverses a pending transaction that vanishes without posting', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            {
              id: 'pend-1',
              amount: '-50.00',
              description: 'Held at the pump',
              pending: true,
              transacted_at: EPOCH_2026_08_01,
            },
          ],
        },
      ]),
      accountSet([
        { id: 'acct-1', name: 'Everyday Checking', balance: '2500.00', transactions: [] },
      ]),
    ]);

    await sync(client);
    const pendingId = await categorizeFirstPending(grocery.id);
    expect(await delegationBalance(grocery.id)).toBe(-5000n);

    const summary = await sync(client, new Date(NOW.getTime() + 60_000));

    // The money never left, so the envelope must read exactly what it did before.
    expect(summary.transactionsReversed).toBe(1);
    expect(await delegationBalance(grocery.id)).toBe(0n);

    const reversed = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingId } });
    expect(reversed.archivedAt).not.toBeNull();
  });

  it('leaves a pending row alone while the feed still reports it', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const stillPending = accountSet([
      {
        id: 'acct-1',
        name: 'Everyday Checking',
        balance: '2500.00',
        transactions: [
          {
            id: 'pend-1',
            amount: '-50.00',
            description: 'Grocery',
            pending: true,
            transacted_at: EPOCH_2026_08_01,
          },
        ],
      },
    ]);
    const client = new ScriptedSimpleFinClient([stillPending, stillPending]);

    await sync(client);
    await categorizeFirstPending(grocery.id);
    const summary = await sync(client, new Date(NOW.getTime() + 60_000));

    expect(summary.transactionsReversed).toBe(0);
    expect(await delegationBalance(grocery.id)).toBe(-5000n);
  });

  it('still reconciles a hold older than the incremental overlap', async () => {
    const travel = await makeDelegation({ name: 'Travel' });
    // A rental-car deposit placed three weeks ago and never captured. The
    // incremental window only reaches back seven days, so the requested window
    // has to be widened to cover outstanding pending rows or this is never
    // reconciled and the envelope stays wrong indefinitely.
    const heldAt = Math.floor(NOW.getTime() / 1000) - 21 * 24 * 60 * 60;
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            {
              id: 'hold-1',
              amount: '-250.00',
              description: 'Car rental hold',
              pending: true,
              transacted_at: heldAt,
            },
          ],
        },
      ]),
      accountSet([
        { id: 'acct-1', name: 'Everyday Checking', balance: '2500.00', transactions: [] },
      ]),
    ]);

    await sync(client);
    await categorizeFirstPending(travel.id);
    expect(await delegationBalance(travel.id)).toBe(-25000n);

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const summary = await sync(client, later);

    expect(summary.transactionsReversed).toBe(1);
    expect(await delegationBalance(travel.id)).toBe(0n);
    // The request must have reached back past the hold, or its absence proves
    // nothing.
    const [, second] = client.calls;
    expect(second!.startDate!.getTime()).toBeLessThanOrEqual(heldAt * 1000);
  });

  it('backs out a categorization when the settled amount differs', async () => {
    const dining = await makeDelegation({ name: 'Dining' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            { id: 'pend-1', amount: '-40.00', description: 'Restaurant', pending: true },
          ],
        },
      ]),
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2452.00',
          // The tip was added at settlement, under the same id.
          transactions: [
            { id: 'pend-1', amount: '-48.00', description: 'Restaurant', pending: false },
          ],
        },
      ]),
    ]);

    await sync(client);
    await categorizeFirstPending(dining.id);
    await sync(client, new Date(NOW.getTime() + 60_000));

    // Allocations that no longer sum to the transaction would be a lie, so the
    // categorization is reversed and it resurfaces as uncategorized.
    expect(await delegationBalance(dining.id)).toBe(0n);
    const settled = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'pend-1' } });
    expect(settled.amountCents).toBe(-4800n);
    expect(await prisma.transactionAllocation.count({ where: { transactionId: settled.id } })).toBe(
      0,
    );
  });

  it('keeps cached balances in step with the ledger through the whole lifecycle', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            {
              id: 'pend-1',
              amount: '-50.00',
              description: 'Grocery',
              pending: true,
              transacted_at: EPOCH_2026_08_01,
            },
          ],
        },
      ]),
      accountSet([
        { id: 'acct-1', name: 'Everyday Checking', balance: '2500.00', transactions: [] },
      ]),
    ]);

    await sync(client);
    await categorizeFirstPending(grocery.id);
    await sync(client, new Date(NOW.getTime() + 60_000));

    const fromEvents = await ledgerBalances();
    expect(await delegationBalance(grocery.id)).toBe(fromEvents.get(grocery.id) ?? 0n);
  });
});

describe('auto-categorization on import', () => {
  it('categorizes newly imported transactions', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole foods',
      delegationId: grocery.id,
    });

    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [
            { id: 'txn-1', amount: '-42.10', description: 'Whole Foods Market' },
            { id: 'txn-2', amount: '-8.75', description: 'Unmatched coffee' },
          ],
        },
      ]),
    ]);

    const summary = await sync(client);

    expect(summary.transactionsCategorized).toBe(1);
    expect(await delegationBalance(grocery.id)).toBe(-4210n);
  });

  it('does not re-run rules over transactions imported by an earlier sync', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const payload = accountSet([
      {
        id: 'acct-1',
        name: 'Everyday Checking',
        balance: '2500.00',
        transactions: [{ id: 'txn-1', amount: '-42.10', description: 'Whole Foods Market' }],
      },
    ]);
    const client = new ScriptedSimpleFinClient([payload, payload]);

    await sync(client);

    // The rule arrives after the transaction did. Applying it here would make an
    // unrelated sync silently recategorize history; that belongs to the explicit
    // "apply to existing" action.
    await createRule(prisma, {
      matchMode: 'contains',
      matchValue: 'whole foods',
      delegationId: grocery.id,
    });
    const second = await sync(client, new Date(NOW.getTime() + 60_000));

    expect(second.transactionsCategorized).toBe(0);
    expect(await delegationBalance(grocery.id)).toBe(0n);
  });
});

describe('sync runs', () => {
  it('records a successful run with its counts', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'acct-1',
          name: 'Everyday Checking',
          balance: '2500.00',
          transactions: [{ id: 'txn-1', amount: '-42.10', description: 'Grocery store' }],
        },
      ]),
    ]);

    const summary = await sync(client);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: summary.syncRunId } });
    expect(run.status).toBe('succeeded');
    expect(run.finishedAt).not.toBeNull();
    expect(run.accountsTouched).toBe(1);
    expect(run.transactionsAdded).toBe(1);
    expect(run.correlationId).not.toBe('');
  });

  it('records a failed run with the error, and re-raises it', async () => {
    await expect(
      runSync(prisma, { client: new FailingSimpleFinClient(), now: NOW }),
    ).rejects.toThrow(/unreachable/);

    const run = await prisma.syncRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(run.status).toBe('failed');
    // Surfaced as a banner, not buried in logs.
    expect(run.error).toMatch(/unreachable/);
  });

  it('records feed errors even when the run itself succeeds', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-1', name: 'Everyday Checking', balance: '2500.00' }], {
        errors: ['Connection to Test Bank needs attention'],
      }),
    ]);

    const summary = await sync(client);

    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id: summary.syncRunId } });
    expect(run.status).toBe('succeeded');
    expect(run.error).toMatch(/needs attention/);
  });

  it('refuses to start while another run is in flight', async () => {
    await prisma.syncRun.create({
      data: { status: 'running', startedAt: NOW, correlationId: 'sync-in-flight' },
    });

    // The hourly job and the manual button must not reconcile pending rows at
    // the same time.
    await expect(sync(new ScriptedSimpleFinClient([accountSet([])]))).rejects.toThrow(
      /already in progress/,
    );
  });

  it('takes over from a run abandoned by a killed process', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'running',
        startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        correlationId: 'sync-abandoned',
      },
    });

    const summary = await sync(new ScriptedSimpleFinClient([accountSet([])]));

    expect(summary.status).toBe('succeeded');
    const abandoned = await prisma.syncRun.findFirstOrThrow({
      where: { correlationId: 'sync-abandoned' },
    });
    expect(abandoned.status).toBe('failed');
  });
});

/**
 * An institution deleted at the bridge and connected again.
 *
 * This happened to the household on 2026-08-22. A broken Frontier Bank
 * connection was deleted and re-added at SimpleFIN, which gave every one of its
 * accounts a **new external id**. Delegate matches on that id, so they arrived
 * looking like new accounts — and creating one failed on the partial unique
 * index over `lower(name)`, because the original was still there under exactly
 * the same name.
 *
 * Two things were wrong, and the second was the worse one: the collision recurs
 * every hour forever, and the throw took the whole run with it, so the other
 * five institutions stopped updating too.
 */
describe('an institution reconnected at the bridge', () => {
  it('adopts the account it replaced rather than failing on the name', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'frontier-old', name: 'Everyday Checking', balance: '1000.00' }]),
      // Same account, same name, new id — which is all a re-link looks like.
      accountSet([{ id: 'frontier-new', name: 'Everyday Checking', balance: '1250.00' }]),
    ]);

    await sync(client);
    const before = await prisma.account.findFirstOrThrow({ where: { externalId: 'frontier-old' } });
    // The owner corrected the type and gave it a nickname; both must survive.
    await prisma.account.update({
      where: { id: before.id },
      data: { needsReview: false, nickname: 'Frontier' },
    });

    const result = await sync(client);
    expect(result.errors).toEqual([]);

    // One account, not two: the register is not split in half.
    expect(await prisma.account.count()).toBe(1);

    const after = await prisma.account.findFirstOrThrow();
    expect(after.id).toBe(before.id);
    expect(after.externalId).toBe('frontier-new');
    expect(after.balanceCents).toBe(125000n);
    expect(after.nickname).toBe('Frontier');
    expect(after.needsReview).toBe(false);
  });

  it('keeps the transactions that were already on it', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'frontier-old',
          name: 'Everyday Checking',
          balance: '1000.00',
          transactions: [
            { id: 'txn-1', amount: '-42.10', description: 'Whole Foods', posted: EPOCH_2026_08_01 },
          ],
        },
      ]),
      accountSet([{ id: 'frontier-new', name: 'Everyday Checking', balance: '1000.00' }]),
    ]);

    await sync(client);
    await sync(client);

    const account = await prisma.account.findFirstOrThrow();
    const transactions = await prisma.transaction.findMany({ where: { accountId: account.id } });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.description).toBe('Whole Foods');
  });

  /**
   * The distinguishing signal is that the old id is one the feed no longer
   * mentions. An institution that is merely erroring still lists its accounts,
   * so a live id is never mistaken for a replaced one.
   */
  it('does not adopt an account the feed still knows about', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-1', name: 'Everyday Checking', balance: '1000.00' }]),
      accountSet([
        { id: 'acct-1', name: 'Everyday Checking', balance: '1000.00' },
        // A genuinely different account that happens to collide on name.
        { id: 'acct-2', name: 'Everyday Checking', balance: '50.00' },
      ]),
    ]);

    await sync(client);
    const result = await sync(client);

    // Refused, reported, and the run still succeeds — which is the point.
    expect(result.errors.some((error) => error.includes('Everyday Checking'))).toBe(true);
    expect(await prisma.account.count()).toBe(1);
    expect((await prisma.account.findFirstOrThrow()).externalId).toBe('acct-1');
  });

  it('lets the other institutions sync even when one of them cannot', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-1', name: 'Everyday Checking', balance: '1000.00' }]),
      accountSet([
        { id: 'acct-1', name: 'Everyday Checking', balance: '1000.00' },
        { id: 'acct-2', name: 'Everyday Checking', balance: '50.00' },
        // A healthy institution, behind the broken one in the feed.
        { id: 'acct-3', name: 'Rewards Credit Card', balance: '-200.00' },
      ]),
    ]);

    await sync(client);
    const result = await sync(client);

    // The run reports the problem rather than dying of it …
    expect(result.errors).toHaveLength(1);
    // … and the account after the broken one still landed.
    const card = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-3' } });
    expect(card.balanceCents).toBe(20000n);
  });
});
