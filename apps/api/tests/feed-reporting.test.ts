import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { buildNotifications } from '../src/domain/notifications.js';
import { runSync } from '../src/domain/sync.js';
import { resetDatabase } from './helpers.js';
import { accountSet, EPOCH_2026_08_01, ScriptedSimpleFinClient } from './simplefin-fixtures.js';

/**
 * "The bank has gone quiet about an account."
 *
 * Two conditions with one pill, and neither could raise one before. The row
 * carried an `s` that checked feed staleness; the pill checked only the manual
 * confirmation interval, which is never set on a discovered account — so for
 * every synced account it was permanently false, and a frozen feed's only
 * signal was a single letter on a page somebody had to already be looking at.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-08T12:00:00Z');

beforeEach(async () => {
  await resetDatabase();
});

/** A healthy run, so the suppression rule below is satisfied by default. */
async function syncedOnce(balanceDate: number | null = EPOCH_2026_08_01): Promise<string> {
  const client = new ScriptedSimpleFinClient([
    accountSet([
      {
        id: 'acct-1',
        name: 'Checking',
        balance: '100.00',
        ...(balanceDate === null ? { balanceDate: null } : { balanceDate }),
      },
    ]),
  ]);
  await runSync(prisma, { client, now: NOW });
  const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-1' } });
  return account.id;
}

function pillOf(list: Awaited<ReturnType<typeof buildNotifications>>): string | undefined {
  return list.find((entry) => entry.kind === 'feed_not_reporting')?.pill;
}

describe('an account the feed still lists', () => {
  it('says nothing while the feed is current', async () => {
    await syncedOnce(Math.floor(NOW.getTime() / 1000));
    expect(pillOf(await buildNotifications(prisma, 'UTC', NOW))).toBeUndefined();
  });

  it('raises a pill once the bank’s own answer has aged', async () => {
    await syncedOnce(Math.floor((NOW.getTime() - 5 * DAY) / 1000));

    const pill = pillOf(await buildNotifications(prisma, 'UTC', NOW));
    expect(pill).toBe('1 account not reporting');

    // The wording separates the two cases: still listed, just old.
    const entry = (await buildNotifications(prisma, 'UTC', NOW)).find(
      (n) => n.kind === 'feed_not_reporting',
    );
    expect(entry?.message).toContain('the connection itself is working');
  });
});

describe('an account the feed has stopped listing', () => {
  it('is named, and says the account may have been closed', async () => {
    const id = await syncedOnce();
    // Three days of runs that no longer mention it.
    await prisma.account.update({
      where: { id },
      data: { feedLastSeenAt: new Date(NOW.getTime() - 3 * DAY) },
    });

    const entry = (await buildNotifications(prisma, 'UTC', NOW)).find(
      (n) => n.kind === 'feed_not_reporting',
    );
    expect(entry?.pill).toBe('1 account not reporting');
    expect(entry?.message).toContain('no longer listed by the feed');
  });

  /**
   * The case that decides whether this is readable at all. Null means "no sync
   * has stamped this yet", which is true of every row on the morning the column
   * ships — reading it as missing would raise an alarm about the whole
   * household exactly once, and teach somebody to ignore the pill.
   */
  it('is silent about an account no sync has stamped yet', async () => {
    await prisma.account.create({
      data: {
        name: 'Legacy Checking',
        type: 'asset',
        source: 'simplefin',
        externalId: 'legacy-1',
        balanceCents: 100000n,
        balanceAsOf: new Date(NOW.getTime() - 200 * DAY),
        feedLastSeenAt: null,
        feedBalanceAsOf: null,
      },
    });
    await prisma.syncRun.create({
      data: { status: 'succeeded', startedAt: NOW, finishedAt: NOW, correlationId: 'seed' },
    });

    expect(pillOf(await buildNotifications(prisma, 'UTC', NOW))).toBeUndefined();
  });

  it('never speaks about a manual account, which no feed reports', async () => {
    await prisma.account.create({
      data: {
        name: 'Physical Cash',
        type: 'asset',
        source: 'manual',
        balanceCents: 101200n,
        balanceAsOf: NOW,
        feedLastSeenAt: new Date(NOW.getTime() - 90 * DAY),
      },
    });
    await prisma.syncRun.create({
      data: { status: 'succeeded', startedAt: NOW, finishedAt: NOW, correlationId: 'seed' },
    });

    expect(pillOf(await buildNotifications(prisma, 'UTC', NOW))).toBeUndefined();
  });
});

describe('while the sync itself is failing', () => {
  /**
   * A bridge that is down lists nothing, so every account would qualify at once
   * and say what `sync_failing` is already saying — louder and less accurately.
   * The interesting condition is the other one: the sync works and has
   * forgotten an account.
   */
  it('says nothing, because sync_failing already covers it', async () => {
    const id = await syncedOnce();
    await prisma.account.update({
      where: { id },
      data: { feedLastSeenAt: new Date(NOW.getTime() - 10 * DAY) },
    });
    // The run that succeeded is pushed into the past, so the failing one below
    // is genuinely the most recent — `latestRun` orders by `startedAt`, and a
    // tie there decides nothing.
    await prisma.syncRun.updateMany({
      where: { status: 'succeeded' },
      data: { startedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) },
    });
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date(NOW.getTime() - 60_000),
        finishedAt: NOW,
        correlationId: 'failing',
        error: 'Could not reach SimpleFIN',
      },
    });

    const all = await buildNotifications(prisma, 'UTC', NOW);
    expect(pillOf(all)).toBeUndefined();
    expect(all.find((n) => n.kind === 'sync_failing')).toBeDefined();
  });
});

describe('the sync itself', () => {
  it('stamps every account the feed named', async () => {
    const id = await syncedOnce();
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.feedLastSeenAt?.getTime()).toBe(NOW.getTime());
  });

  it('stamps it even when the feed says nothing about its own freshness', async () => {
    // The gap this column exists for: feedBalanceAsOf is null here, so the
    // older safeguard could never call this account stale in either direction.
    const id = await syncedOnce(null);
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(account.feedBalanceAsOf).toBeNull();
    expect(account.feedLastSeenAt?.getTime()).toBe(NOW.getTime());
  });

  it('leaves it where it was for an account the feed stopped listing', async () => {
    const id = await syncedOnce();

    // A later run that lists a different account entirely.
    const client = new ScriptedSimpleFinClient([
      accountSet([{ id: 'acct-2', name: 'Savings', balance: '50.00' }]),
    ]);
    const later = new Date(NOW.getTime() + 3 * DAY);
    await runSync(prisma, { client, now: later });

    const first = await prisma.account.findUniqueOrThrow({ where: { id } });
    expect(first.feedLastSeenAt?.getTime()).toBe(NOW.getTime());

    const second = await prisma.account.findFirstOrThrow({ where: { externalId: 'acct-2' } });
    expect(second.feedLastSeenAt?.getTime()).toBe(later.getTime());
  });
});
