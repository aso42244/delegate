import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { ValidationError } from '../domain/errors.js';
import { getBudgetSettings, resolveScheduleTimezone } from '../domain/settings.js';
import {
  accountSeries,
  aggregateSeries,
  changePerCycle,
  compositionSeries,
  dailyAggregateRows,
  debtTrajectory,
  delegationDrillDown,
  UNGROUPED,
  downsample,
  equitySeries,
  momentum,
  SNAPSHOT_RANGES,
  type Series,
  type SeriesPoint,
} from '../domain/snapshot-series.js';
import {
  captureSnapshot,
  snapshotDateFor,
  snapshotStatus,
  type WriteResult,
} from '../domain/snapshots.js';
import { centsOut, dateOut } from '../http/serialize.js';
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
    const settings = await getBudgetSettings(prisma);
    // The zone decides what "today" is, and therefore how old the newest
    // snapshot is. Resolved before the status rather than beside it, so the
    // staleness the page reports is measured against the household's day.
    const timezone = resolveScheduleTimezone(settings, fastify.config.SCHEDULE_TIMEZONE);
    const status = await snapshotStatus(prisma, timezone);

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
      timezone,
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

  /**
   * Everything the page draws that does not depend on a picker, in one request.
   *
   * Already downsampled and already shaped: the browser is handed points it can
   * draw rather than a year of rows to reduce. Above roughly 180 stored days a
   * series buckets to weekly and above 730 to monthly, and a bucket takes the
   * weakest provenance in it — so a week containing one estimated day renders as
   * estimated, which is the honest reading of a line drawn through it.
   */
  fastify.get('/api/insights/snapshots', async (request) => {
    const { range } = rangeSchema.parse(request.query ?? {});

    const [aggregate, composition, equity, daily, accounts] = await Promise.all([
      aggregateSeries(prisma, range),
      compositionSeries(prisma, range),
      equitySeries(prisma, range),
      dailyAggregateRows(prisma, range),
      // The picker for the balance-history widget. Only accounts that actually
      // have history, so it never offers one that draws an empty box.
      prisma.accountSnapshot
        .groupBy({ by: ['accountId'], _count: { accountId: true } })
        .then(async (groups) => {
          const rows = await prisma.account.findMany({
            where: { id: { in: groups.map((group) => group.accountId) } },
            select: { id: true, name: true, nickname: true, type: true },
            orderBy: { name: 'asc' },
          });
          return rows;
        }),
    ]);

    const cycles = await changePerCycle(prisma, daily);
    const trajectory = debtTrajectory(daily, aggregate.bucket);

    return {
      range,
      /*
       * One aggregate series, not three.
       *
       * Net worth over time, assets against debts, and identity drift are the
       * same stored rows read differently — every field each of them needs is on
       * every point. Sending the payload three times under three keys would have
       * been three copies of a year of history to say the same thing.
       */
      aggregate: series(aggregate),
      net_worth_composition: {
        bucket: composition.bucket,
        days: composition.days,
        points: composition.points.map((entry) => ({
          date: dateOut(entry.date),
          provenance: entry.provenance,
          bitcoinCents: centsOut(entry.bitcoinCents),
          otherAssetsCents: centsOut(entry.otherAssetsCents),
          debtsCents: centsOut(entry.debtsCents),
        })),
      },
      home_equity: {
        name: equity.name,
        bucket: equity.bucket,
        days: equity.days,
        points: equity.points.map(point),
      },
      thirty_day_momentum: {
        bucket: aggregate.bucket,
        // Computed on the daily rows before bucketing: a rolling window over
        // weekly averages is a different and much blunter thing.
        points: downsample(momentum(daily), aggregate.bucket).map(point),
      },
      change_per_cycle: cycles.map((cycle) => ({
        startedAt: dateOut(cycle.startedAt),
        endedAt: dateOut(cycle.endedAt),
        changeCents: centsOut(cycle.changeCents),
        provenance: cycle.provenance,
        partial: cycle.partial,
      })),
      debt_trajectory: {
        bucket: aggregate.bucket,
        points: trajectory.points.map(point),
        payoffDate: dateOut(trajectory.payoffDate),
        hasEnoughHistory: trajectory.hasEnoughHistory,
      },
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.nickname ?? account.name,
        type: account.type,
      })),
    };
  });

  /** One account's balance history — the widget with a picker. */
  fastify.get('/api/insights/snapshots/account/:accountId', async (request) => {
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const { range } = rangeSchema.parse(request.query ?? {});
    return series(await accountSeries(prisma, accountId, range));
  });

  /**
   * The delegation drill-down: all groupings, one grouping's delegations, or one
   * delegation. Widgets 4, 5 and 12 read the same shape.
   */
  fastify.get('/api/insights/snapshots/delegations', async (request) => {
    const { range, groupingId, delegationId } = z
      .object({
        range: z.enum(SNAPSHOT_RANGES).default('90d'),
        // A grouping's id, or the literal standing for the lines in none.
        groupingId: z.union([z.string().uuid(), z.literal(UNGROUPED)]).optional(),
        delegationId: z.string().uuid().optional(),
      })
      .parse(request.query ?? {});

    const drill = await delegationDrillDown(prisma, { range, groupingId, delegationId });

    return {
      level: drill.level,
      bucket: drill.bucket,
      days: drill.days,
      cyclesPerYear: drill.cyclesPerYear,
      groupingName: drill.groupingName,
      delegationName: drill.delegationName,
      series: drill.series.map((entry) => ({
        key: entry.key,
        name: entry.name,
        color: entry.color,
        burnRateCents: centsOut(entry.burnRateCents),
        changeCents: centsOut(entry.changeCents),
        points: entry.points.map(point),
      })),
    };
  });

  done();
};

const rangeSchema = z.object({ range: z.enum(SNAPSHOT_RANGES).default('90d') });

/** One point, with its money as decimal strings and its provenance intact. */
function point(entry: SeriesPoint): Record<string, unknown> {
  return {
    date: dateOut(entry.date),
    provenance: entry.provenance,
    days: entry.days,
    ...Object.fromEntries(
      Object.entries(entry.fields).map(([name, value]) => [name, centsOut(value)]),
    ),
  };
}

function series(value: Series): Record<string, unknown> {
  return {
    bucket: value.bucket,
    days: value.days,
    earliest: dateOut(value.earliest),
    points: value.points.map(point),
    // Snapshots are labelled for the previous day, so every chart would
    // otherwise end a day behind. The client draws this distinctly — a hollow
    // marker or a dashed final segment — because it is current state rather
    // than a stored observation.
    live:
      value.live === null
        ? null
        : Object.fromEntries(
            Object.entries(value.live).map(([name, amount]) => [name, centsOut(amount)]),
          ),
  };
}

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
