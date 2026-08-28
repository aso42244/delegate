import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { prisma } from './db/client.js';
import { ConflictError } from './domain/errors.js';
import { runBackup } from './domain/backup.js';
import { fetchAndRecordPrice, providerByName, revalueBitcoinHoldings } from './domain/bitcoin.js';
import { scanAllWallets } from './domain/bitcoin-wallets.js';
import { getBudgetSettings, resolveScheduleTimezone } from './domain/settings.js';
import { resolveConnection } from './domain/simplefin-config.js';
import { captureSnapshot, snapshotDateFor } from './domain/snapshots.js';
import { runSync } from './domain/sync.js';
import { HttpSimpleFinClient } from './simplefin/client.js';

/**
 * In-process scheduled jobs.
 *
 * `node-cron` rather than a queue: a single household does not justify a Redis
 * dependency, and the only recurring work is one hourly HTTP fetch.
 *
 * SimpleFIN publishes no rate limits and no guidance on sync frequency, so the
 * hourly cadence from the specification stands. See ADR 009.
 *
 * Every expression is read in one zone: the one chosen in Settings, or
 * `SCHEDULE_TIMEZONE` when nobody has chosen (ADR 036). The hourly jobs land at
 * the same instant in any zone, but passing it to one task and not the others
 * would leave a future reader working out which of the schedules meant local
 * time — and the snapshot job genuinely depends on it, because it labels its
 * rows for the local day that just ended.
 */

export interface Scheduler {
  stop(): void;
  /**
   * Rebuilds every task, picking up a time zone changed in Settings.
   *
   * Stops the old tasks first. A leaked task would double every job: two syncs
   * are a `sync_already_running` conflict and harmless, but two backups are two
   * dumps and two snapshot runs are wasted work on two cores.
   */
  reload(): Promise<void>;
}

/**
 * The zone the schedules should run in right now.
 *
 * Falls back to the environment rather than failing: a database that cannot be
 * read at boot is a reason to run the jobs at the configured hour, not a reason
 * to stop running them.
 */
async function currentTimezone(config: AppConfig, logger: FastifyBaseLogger): Promise<string> {
  try {
    const settings = await getBudgetSettings(prisma);
    return resolveScheduleTimezone(settings, config.SCHEDULE_TIMEZONE);
  } catch (error) {
    logger.warn(
      { err: error, fallback: config.SCHEDULE_TIMEZONE },
      'could not read the schedule timezone from settings; using the environment',
    );
    return config.SCHEDULE_TIMEZONE;
  }
}

export async function startScheduler(
  config: AppConfig,
  logger: FastifyBaseLogger,
): Promise<Scheduler> {
  let tasks: ScheduledTask[] = [];

  const stop = (): void => {
    for (const task of tasks) void task.stop();
    tasks = [];
  };

  const build = async (): Promise<void> => {
    const timezone = await currentTimezone(config, logger);
    stop();
    tasks = createTasks(config, logger, timezone);
    logger.info({ timezone, jobs: tasks.length }, 'schedules built');
  };

  await build();
  return { stop, reload: build };
}

function createTasks(
  config: AppConfig,
  logger: FastifyBaseLogger,
  timezone: string,
): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  const options = { timezone };

  if (!cron.validate(config.SIMPLEFIN_SYNC_CRON)) {
    // Loud rather than silently never running: a mistyped expression that simply
    // did nothing would look identical to a working sync that finds no changes.
    throw new Error(
      `SIMPLEFIN_SYNC_CRON is not a valid cron expression: "${config.SIMPLEFIN_SYNC_CRON}"`,
    );
  }

  tasks.push(
    cron.schedule(
      config.SIMPLEFIN_SYNC_CRON,
      () => {
        void runScheduledSync(config, logger);
      },
      options,
    ),
  );

  logger.info(
    { cron: config.SIMPLEFIN_SYNC_CRON, timezone: options.timezone },
    'scheduled sync enabled',
  );

  if (!cron.validate(config.BACKUP_CRON)) {
    throw new Error(`BACKUP_CRON is not a valid cron expression: "${config.BACKUP_CRON}"`);
  }

  tasks.push(
    cron.schedule(
      config.BACKUP_CRON,
      () => {
        void runScheduledBackup(config, logger);
      },
      options,
    ),
  );

  logger.info(
    { cron: config.BACKUP_CRON, timezone: options.timezone, directory: config.BACKUP_DIR },
    'nightly backup enabled',
  );

  if (!cron.validate(config.BITCOIN_PRICE_CRON)) {
    throw new Error(
      `BITCOIN_PRICE_CRON is not a valid cron expression: "${config.BITCOIN_PRICE_CRON}"`,
    );
  }

  tasks.push(
    cron.schedule(
      config.BITCOIN_PRICE_CRON,
      () => {
        void runScheduledPriceFetch(config, logger);
      },
      options,
    ),
  );

  logger.info(
    { cron: config.BITCOIN_PRICE_CRON, timezone: options.timezone },
    'Bitcoin price fetch enabled',
  );

  if (!cron.validate(config.SNAPSHOT_CRON)) {
    throw new Error(`SNAPSHOT_CRON is not a valid cron expression: "${config.SNAPSHOT_CRON}"`);
  }

  tasks.push(
    cron.schedule(
      config.SNAPSHOT_CRON,
      () => {
        void runScheduledSnapshot(timezone, logger);
      },
      options,
    ),
  );

  logger.info(
    { cron: config.SNAPSHOT_CRON, timezone: options.timezone },
    'nightly snapshot enabled',
  );

  return tasks;
}

/**
 * The nightly record of the financial picture, labelled for the previous day.
 *
 * Never throws into the timer, for the same reason as sync and backup: an
 * unhandled rejection in a cron callback takes the process down, and losing the
 * budget because a snapshot failed would be far worse than the missing
 * snapshot — which the gap-filler repairs on the next run anyway.
 *
 * The log line names the date, the counts and the duration, and says explicitly
 * when nothing was written. "Snapshot complete" with no numbers behind it is the
 * shape of message that let a nightly backup fail for weeks in plain sight.
 */
async function runScheduledSnapshot(timezone: string, logger: FastifyBaseLogger): Promise<void> {
  const startedAt = Date.now();

  try {
    const snapshotDate = snapshotDateFor(new Date(), timezone);
    const result = await captureSnapshot(prisma, snapshotDate, logger);
    const durationMs = Date.now() - startedAt;

    const written = result.accountsWritten + result.delegationsWritten;
    if (written === 0 && !result.aggregateWritten) {
      // Not a failure — a re-run over a day already observed does exactly this —
      // but it must never be indistinguishable from having done the work.
      logger.warn(
        { snapshotDate, durationMs, kept: result.accountsKept + result.delegationsKept },
        'nightly snapshot wrote nothing: every row for this date was already observed',
      );
      return;
    }

    logger.info(
      {
        snapshotDate,
        accounts: result.accountsWritten,
        delegations: result.delegationsWritten,
        aggregate: result.aggregateWritten,
        durationMs,
        // Only ever present when a row was not a straight observation, so an
        // ordinary night's line stays short and an unusual one stands out.
        ...(Object.keys(result.derived).length > 0 ? { derived: result.derived } : {}),
      },
      'nightly snapshot written',
    );
  } catch (error) {
    logger.error({ err: error, durationMs: Date.now() - startedAt }, 'nightly snapshot failed');
  }
}

/**
 * A price that cannot be fetched is not a fault to escalate. The last known one
 * is held and flagged stale wherever it is displayed — §8 is explicit that a
 * holding must never read zero or blank — so a quiet log line is the right
 * volume for a feed having a bad hour.
 */
async function runScheduledPriceFetch(config: AppConfig, logger: FastifyBaseLogger): Promise<void> {
  try {
    const result = await fetchAndRecordPrice(prisma, [
      providerByName(config.BITCOIN_PRICE_PRIMARY),
      providerByName(config.BITCOIN_PRICE_FALLBACK),
    ]);
    if (result) {
      logger.info(
        { source: result.source, closesSettled: result.closesSettled },
        'Bitcoin price recorded',
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'Bitcoin price fetch failed; holding the last known price');
  }

  // Wallets, on the same hourly beat as the price. Separate try blocks the
  // whole way down: a node that is unreachable must not stop the price being
  // recorded, and neither must stop the revaluation below.
  try {
    const scanned = await scanAllWallets(prisma, config.dataKey, logger, {
      torSocksUrl: config.TOR_SOCKS_URL,
    });
    if (scanned > 0) logger.info({ wallets: scanned }, 'Bitcoin wallets scanned');
  } catch (error) {
    logger.warn({ err: error }, 'Bitcoin wallet scan failed; the last known holding stands');
  }

  // Separately from the fetch, and deliberately outside its try: a holding whose
  // dollar figure is a day old should be brought forward on the last price we
  // have even when today's fetch failed. Only in-budget holdings have one at
  // all, and it moves once a day rather than hourly — see
  // `revalueBitcoinHoldings` for why the banner is not allowed to track the
  // market.
  try {
    const { revalued } = await revalueBitcoinHoldings(prisma);
    if (revalued > 0) logger.info({ revalued }, 'in-budget Bitcoin holdings revalued');
  } catch (error) {
    logger.warn({ err: error }, 'Bitcoin revaluation failed; the previous figure stands');
  }
}

/**
 * A failed backup is logged at error level rather than thrown, for the same
 * reason as sync: an unhandled rejection in a cron callback takes the process
 * down, and losing the application because a dump failed would be worse than the
 * failed dump.
 */
async function runScheduledBackup(config: AppConfig, logger: FastifyBaseLogger): Promise<void> {
  try {
    const result = await runBackup({
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
      BACKUP_DIR: config.BACKUP_DIR,
      BACKUP_RETENTION_DAYS: String(config.BACKUP_RETENTION_DAYS),
    });
    logger.info({ path: result.path, bytes: result.bytes }, 'backup written');
  } catch (error) {
    logger.error({ err: error }, 'backup failed');
  }
}

/**
 * The scheduled job never throws into the timer. An unhandled rejection in a
 * cron callback takes the process down, and a failed sync is a banner in the UI,
 * not a reason to stop serving the budget.
 */
async function runScheduledSync(config: AppConfig, logger: FastifyBaseLogger): Promise<void> {
  try {
    // Resolved per run rather than at startup: the owner can connect SimpleFIN
    // from Settings at any time, and the job must pick that up without a restart.
    const connection = await resolveConnection(prisma, config.SIMPLEFIN_ACCESS_URL, config.dataKey);

    if (!connection.accessUrl) {
      logger.debug(
        { problem: connection.problem },
        'scheduled sync skipped: SimpleFIN is not connected',
      );
      return;
    }

    const summary = await runSync(prisma, {
      client: new HttpSimpleFinClient({ accessUrl: connection.accessUrl }),
      backfillMonths: config.SIMPLEFIN_BACKFILL_MONTHS,
      logger,
      // Scheduled runs have no user behind them.
      actorId: null,
    });
    logger.info({ syncRunId: summary.syncRunId }, 'scheduled sync complete');
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'sync_already_running') {
      // The manual button and the hourly job overlapped. Expected, not a fault.
      logger.info('scheduled sync skipped: a sync is already running');
      return;
    }
    // Already recorded on the sync run and surfaced as a banner; this is the
    // operator-facing copy.
    logger.error({ err: error }, 'scheduled sync failed');
  }
}
