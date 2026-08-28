import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { ValidationError } from '../domain/errors.js';
import { getBudgetSettings, resolveScheduleTimezone } from '../domain/settings.js';
import {
  captureSnapshot,
  snapshotDateFor,
  snapshotStatus,
  type WriteResult,
} from '../domain/snapshots.js';
import { dateOut } from '../http/serialize.js';
import { AUTHENTICATED, requireSettingsManagement } from '../plugins/auth.js';

/**
 * Snapshots: whether the nightly job is running, and a way to make it run.
 *
 * Reading is for everyone, because Insights needs it and plain Users have full
 * budget access. Running it is administrator-only — it is a maintenance action,
 * not a budget one.
 */

export const snapshotRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /**
   * Did the job run, and when.
   *
   * This exists because of the specific way the nightly backup failed: it
   * reported every failure correctly, into a log nobody read, and the question
   * nobody thought to ask was whether a dump was actually on disk. The lesson in
   * `docs/handoff.md` is to check for the evidence a job leaves rather than for
   * the absence of an error, so this answers from the rows.
   */
  fastify.get('/api/snapshots/status', async () => {
    const [status, settings] = await Promise.all([
      snapshotStatus(prisma),
      getBudgetSettings(prisma),
    ]);

    return {
      latestDate: dateOut(status.latestDate),
      latestProvenance: status.latestProvenance,
      days: status.days,
      stale: status.stale,
      cron: fastify.config.SNAPSHOT_CRON,
      // The zone it actually runs in, resolved the same way the scheduler
      // resolves it. A page that names a schedule from somewhere else is how
      // Settings → Sync claimed "02:30 UTC" for months while the deployment ran
      // on something else entirely.
      timezone: resolveScheduleTimezone(settings, fastify.config.SCHEDULE_TIMEZONE),
    };
  });

  /**
   * Run it by hand, for a date.
   *
   * For testing and for recovery. Defaults to the same date tonight's run would
   * write — the previous day in the household's zone — so pressing it with no
   * argument does exactly what the schedule does.
   *
   * Safe to point at any date: an `observed` row is never overwritten, so a
   * re-run repairs what is missing and revises nothing that was seen.
   */
  fastify.post(
    '/api/snapshots/run',
    { preHandler: [requireSettingsManagement] },
    async (request) => {
      const body = z
        .object({ date: z.coerce.date().optional() })
        .strict()
        .parse(request.body ?? {});

      const settings = await getBudgetSettings(prisma);
      const timezone = resolveScheduleTimezone(settings, fastify.config.SCHEDULE_TIMEZONE);
      const snapshotDate = body.date ?? snapshotDateFor(new Date(), timezone);

      /*
       * A date in the future has nothing to observe: the state this would record
       * is today's, filed under a day that has not happened. Refused rather than
       * written, because a stored row nobody can distinguish from a real one is
       * worse than an error message.
       */
      if (snapshotDate.getTime() > snapshotDateFor(new Date(), timezone).getTime()) {
        throw new ValidationError(
          'snapshot_date_in_the_future',
          'That date has not finished yet. The latest a snapshot can cover is the previous day.',
        );
      }

      const result = await captureSnapshot(prisma, snapshotDate, request.log);

      request.log.info(
        {
          actorId: request.currentUser?.id,
          snapshotDate: result.snapshotDate,
          accounts: result.accountsWritten,
          delegations: result.delegationsWritten,
          kept: result.accountsKept + result.delegationsKept,
        },
        'snapshot run by hand',
      );

      return present(result);
    },
  );

  done();
};

function present(result: WriteResult): Record<string, unknown> {
  return {
    snapshotDate: dateOut(result.snapshotDate),
    accountsWritten: result.accountsWritten,
    delegationsWritten: result.delegationsWritten,
    // Rows left alone because they were already observed. The number that
    // distinguishes "there was nothing to do" from "nothing happened".
    accountsKept: result.accountsKept,
    delegationsKept: result.delegationsKept,
    aggregateWritten: result.aggregateWritten,
    derived: result.derived,
  };
}
