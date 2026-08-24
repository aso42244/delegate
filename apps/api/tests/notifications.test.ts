import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { recordSpotPrice } from '../src/domain/bitcoin.js';
import { buildNotifications } from '../src/domain/notifications.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The banners the application raises about itself.
 *
 * Each of these is a condition the owner would otherwise discover only by
 * noticing a number was wrong. The test that matters most is the negative one:
 * a condition that has resolved must stop being reported, because these are
 * computed rather than stored and nothing ever "clears" them.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const NOW = new Date('2026-08-09T12:00:00Z');

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      // These suites sign in on every test from one address. The limit itself
      // is proved in auth.test.ts, which builds an app with a low one.
      AUTH_RATE_LIMIT_MAX: '100000',
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(response.headers);
  await markTwoFactorEnrolled();
});

const kinds = async (now = NOW): Promise<string[]> =>
  (await buildNotifications(prisma, now)).map((notification) => notification.kind);

describe('a quiet system', () => {
  it('raises nothing at all', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 100n });
    expect(await kinds()).toEqual([]);
  });
});

describe('a failing sync', () => {
  it('is reported, because a failure must be visible outside the logs', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-07T03:00:00Z'),
        finishedAt: new Date('2026-08-07T03:00:05Z'),
        error: 'the bridge refused',
        correlationId: 'test-run-1',
      },
    });

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.kind).toBe('sync_failing');
    expect(notifications[0]?.severity).toBe('danger');
    // How long it has been broken is the part that decides whether to act.
    expect(notifications[0]?.message).toContain('2 days ago');
  });

  it('stops being reported once a later run succeeds', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-07T03:00:00Z'),
        correlationId: 'test-run-1',
      },
    });
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-08T03:00:00Z'),
        correlationId: 'test-run-2',
      },
    });

    expect(await kinds()).not.toContain('sync_failing');
  });
});

describe('a sync that succeeded but complained', () => {
  it('reports the institution the feed named', async () => {
    // The real shape of an expired bank login: SimpleFIN reports the problem
    // per-institution and the run still succeeds, because everything else
    // synced. Before this, the account quietly stopped updating while the whole
    // interface looked healthy.
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-09T09:00:00Z'),
        finishedAt: new Date('2026-08-09T09:00:05Z'),
        error: 'Connection to Frontier Bank may need attention. Auth required',
        correlationId: 'test-run-1',
      },
    });

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.kind).toBe('sync_warning');
    expect(notifications[0]?.severity).toBe('warning');
    // The feed's own words: it names the bank, and paraphrasing would lose that.
    expect(notifications[0]?.message).toBe(
      'Connection to Frontier Bank may need attention. Auth required',
    );
  });

  it('joins several institutions into one banner', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-09T09:00:00Z'),
        error: 'Frontier Bank: auth required\nPlains Commerce: temporarily unavailable',
        correlationId: 'test-run-1',
      },
    });

    expect((await buildNotifications(prisma, NOW))[0]?.message).toBe(
      'Frontier Bank: auth required · Plains Commerce: temporarily unavailable',
    );
  });

  it('says nothing about a clean run', async () => {
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-09T09:00:00Z'),
        correlationId: 'test-run-1',
      },
    });

    expect(await kinds()).not.toContain('sync_warning');
  });

  it('is superseded by an outright failure rather than shown beside it', async () => {
    // A later failed run is the more serious reading of the same connection.
    await prisma.syncRun.create({
      data: {
        status: 'succeeded',
        startedAt: new Date('2026-08-08T03:00:00Z'),
        error: 'Frontier Bank: auth required',
        correlationId: 'test-run-1',
      },
    });
    await prisma.syncRun.create({
      data: {
        status: 'failed',
        startedAt: new Date('2026-08-09T03:00:00Z'),
        error: 'the bridge refused',
        correlationId: 'test-run-2',
      },
    });

    const reported = await kinds();
    expect(reported).toContain('sync_failing');
    expect(reported).not.toContain('sync_warning');
  });
});

describe('stale balances', () => {
  it('names the accounts nobody has confirmed lately', async () => {
    await makeAccount({
      name: 'Physical Cash',
      type: 'asset',
      balanceCents: 20000n,
      stalenessIntervalDays: 30,
      balanceAsOf: new Date('2026-06-01T00:00:00Z'),
    });

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.kind).toBe('stale_balances');
    expect(notifications[0]?.message).toContain('Physical Cash');
  });

  /** A null interval means "never goes stale" — cash you check weekly, say. */
  it('says nothing about an account with no staleness interval', async () => {
    await makeAccount({
      name: 'Physical Cash',
      type: 'asset',
      balanceCents: 20000n,
      stalenessIntervalDays: null,
      balanceAsOf: new Date('2020-01-01T00:00:00Z'),
    });

    expect(await kinds()).toEqual([]);
  });

  it('summarizes rather than listing every one', async () => {
    for (const name of ['Cash', 'Wallet', 'House', 'Boat', 'Vault']) {
      await makeAccount({
        name,
        type: 'asset',
        balanceCents: 1n,
        stalenessIntervalDays: 30,
        balanceAsOf: new Date('2026-06-01T00:00:00Z'),
      });
    }

    const notifications = await buildNotifications(prisma, NOW);
    expect(notifications[0]?.message).toContain('2 more');
  });
});

describe('the uncategorized backlog', () => {
  it('is informational rather than a fault, and reports its age', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    await makeTransaction({
      accountId: account.id,
      amountCents: -4210n,
      postedAt: new Date('2026-07-30T00:00:00Z'),
    });

    const notifications = await buildNotifications(prisma, NOW);
    const backlog = notifications.find((n) => n.kind === 'uncategorized_backlog');
    expect(backlog?.severity).toBe('info');
    expect(backlog?.message).toContain('10 days ago');
  });

  it('disappears once everything is categorized', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    const grocery = await makeDelegation({ name: 'Grocery' });
    const transaction = await makeTransaction({ accountId: account.id, amountCents: -4210n });
    await categorizeTransaction(prisma, transaction.id, grocery.id);

    expect(await kinds()).not.toContain('uncategorized_backlog');
  });

  /** Income and confirmed transfers allocate to nothing; they are not a backlog. */
  it('ignores transactions that are not spending', async () => {
    const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
    await makeTransaction({ accountId: account.id, amountCents: 489000n, kind: 'income' });

    expect(await kinds()).not.toContain('uncategorized_backlog');
  });
});

describe('a stale Bitcoin price', () => {
  it('is flagged, since holdings are still valued at it', async () => {
    await recordSpotPrice(
      prisma,
      { priceCents: 10_000_000n, source: 'coingecko' },
      new Date('2026-08-07T12:00:00Z'),
    );

    const notifications = await buildNotifications(prisma, NOW);
    const stale = notifications.find((n) => n.kind === 'bitcoin_price_stale');
    expect(stale?.severity).toBe('warning');
    expect(stale?.message).toContain('2 days ago');
  });

  it('says nothing when the price is today', async () => {
    await recordSpotPrice(prisma, { priceCents: 10_000_000n, source: 'coingecko' }, NOW);
    expect(await kinds()).not.toContain('bitcoin_price_stale');
  });
});

describe('accounts a sync discovered', () => {
  it('are flagged, because their type is a guess', async () => {
    const account = await makeAccount({ name: 'Discovered', type: 'asset', balanceCents: 1n });
    await prisma.account.update({ where: { id: account.id }, data: { needsReview: true } });

    expect(await kinds()).toContain('accounts_need_review');
  });
});

/**
 * The backup, which is the only condition here that can cost the household its
 * data rather than its accuracy.
 *
 * These exist because the real deployment's nightly dump failed with a
 * permission error every night from go-live, was logged at error level each
 * time, and nothing anywhere read the log. The lesson is in the shape of the
 * check: it asks whether a dump has landed, not whether the last attempt threw.
 */
describe('the backup', () => {
  async function backupDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'delegate-backups-'));
  }

  /**
   * Ages the deployment past one backup cycle.
   *
   * The check stays quiet on an install too young for a dump to have been due,
   * so every test that expects it to speak has to get past that first — which
   * is the clearest possible statement of the rule.
   */
  async function deploymentIsOldEnough(): Promise<void> {
    await prisma.user.updateMany({
      data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });
  }

  /** A dump and its checksum, aged by however many hours. */
  async function writeDump(directory: string, hoursOld: number): Promise<void> {
    const name = join(directory, `delegate-2026${String(hoursOld).padStart(4, '0')}-000000.dump`);
    await writeFile(name, 'x'.repeat(2048));
    await writeFile(`${name}.sha256`, 'deadbeef');
    const when = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    await utimes(name, when, when);
  }

  it('says so, in the strongest terms, when none has ever completed', async () => {
    await deploymentIsOldEnough();
    const directory = await backupDir();
    const notifications = await buildNotifications(prisma, new Date(), { backupDir: directory });

    const backup = notifications.find((one) => one.kind === 'backup_failing');
    expect(backup?.severity).toBe('danger');
    expect(backup?.message).toContain('exists in one place');
  });

  it('is quiet when a recent dump is there', async () => {
    const directory = await backupDir();
    await writeDump(directory, 3);

    const notifications = await buildNotifications(prisma, new Date(), { backupDir: directory });
    expect(notifications.find((one) => one.kind === 'backup_failing')).toBeUndefined();
  });

  it('raises once two nightly runs have been missed', async () => {
    await deploymentIsOldEnough();
    const directory = await backupDir();
    await writeDump(directory, 60);

    const notifications = await buildNotifications(prisma, new Date(), { backupDir: directory });
    expect(notifications.find((one) => one.kind === 'backup_failing')?.message).toContain(
      '2 days old',
    );
  });

  /*
   * The failure that actually happened, in miniature.
   *
   * `backup.sh` writes to a `.partial` name and renames the dump and its
   * checksum together, so a dump with no sidecar is the wreckage of a run that
   * died partway. Counting it would report a backup on the strength of the file
   * that proves there isn't one.
   */
  it('does not count a dump whose checksum never landed', async () => {
    await deploymentIsOldEnough();
    const directory = await backupDir();
    await writeFile(join(directory, 'delegate-20260824-000000.dump'), 'x'.repeat(2048));

    const notifications = await buildNotifications(prisma, new Date(), { backupDir: directory });
    expect(notifications.find((one) => one.kind === 'backup_failing')).toBeDefined();
  });

  /*
   * A deployment younger than one backup cycle is not failing, it is new. A
   * banner that is wrong on day one is one nobody trusts on day ninety.
   */
  it('stays quiet on an install too young for a dump to have been due', async () => {
    const directory = await backupDir();
    const notifications = await buildNotifications(prisma, new Date(), { backupDir: directory });
    expect(notifications.find((one) => one.kind === 'backup_failing')).toBeUndefined();
  });

  it('does not run at all when no directory is configured', async () => {
    const notifications = await buildNotifications(prisma, new Date());
    expect(notifications.find((one) => one.kind === 'backup_failing')).toBeUndefined();
  });
});

describe('the route', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(response.statusCode).toBe(401);
  });

  it('carries the action so a banner can lead somewhere', async () => {
    await prisma.syncRun.create({
      data: { status: 'failed', startedAt: new Date(), correlationId: 'test-run-3' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie },
    });
    const body = response.json<{ notifications: { actionPath: string }[] }>();

    expect(body.notifications[0]?.actionPath).toBe('/settings/sync');
  });
});
