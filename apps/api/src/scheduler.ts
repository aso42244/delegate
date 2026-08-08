import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { prisma } from './db/client.js';
import { ConflictError } from './domain/errors.js';
import { runBackup } from './domain/backup.js';
import { resolveConnection } from './domain/simplefin-config.js';
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
 */

export interface Scheduler {
  stop(): void;
}

export function startScheduler(config: AppConfig, logger: FastifyBaseLogger): Scheduler {
  const tasks: ScheduledTask[] = [];

  if (!cron.validate(config.SIMPLEFIN_SYNC_CRON)) {
    // Loud rather than silently never running: a mistyped expression that simply
    // did nothing would look identical to a working sync that finds no changes.
    throw new Error(
      `SIMPLEFIN_SYNC_CRON is not a valid cron expression: "${config.SIMPLEFIN_SYNC_CRON}"`,
    );
  }

  tasks.push(
    cron.schedule(config.SIMPLEFIN_SYNC_CRON, () => {
      void runScheduledSync(config, logger);
    }),
  );

  logger.info({ cron: config.SIMPLEFIN_SYNC_CRON }, 'scheduled sync enabled');

  if (!cron.validate(config.BACKUP_CRON)) {
    throw new Error(`BACKUP_CRON is not a valid cron expression: "${config.BACKUP_CRON}"`);
  }

  tasks.push(
    cron.schedule(config.BACKUP_CRON, () => {
      void runScheduledBackup(config, logger);
    }),
  );

  logger.info({ cron: config.BACKUP_CRON, directory: config.BACKUP_DIR }, 'nightly backup enabled');

  return {
    stop: () => {
      for (const task of tasks) void task.stop();
    },
  };
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
    const connection = await resolveConnection(
      prisma,
      config.SIMPLEFIN_ACCESS_URL,
      config.SESSION_SECRET,
    );

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
