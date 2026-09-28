import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { startScheduler, type Scheduler } from '../src/scheduler.js';
import { resetDatabase } from './helpers.js';

/**
 * The scheduler reads its time zone from Settings.
 *
 * This is the half of ADR 036 that could silently not work. `node-cron` fixes a
 * task's zone when the task is created, so a stored zone that never rebuilds the
 * tasks is a setting that saves, reports itself saved, and changes nothing until
 * the next restart — which is the shape of failure this project has already paid
 * for once, with a nightly backup that reported itself fine while failing every
 * night for weeks.
 *
 * The cron expressions here are the real ones: hourly and nightly, so nothing
 * fires during a test that takes two seconds.
 */

interface LogLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/** Enough of a Fastify logger to capture what the scheduler says it did. */
function recordingLogger(lines: LogLine[]): FastifyBaseLogger {
  const record =
    () =>
    (first: unknown, second?: unknown): void => {
      if (typeof first === 'string') {
        lines.push({ fields: {}, message: first });
        return;
      }
      lines.push({
        fields: (first ?? {}) as Record<string, unknown>,
        message: typeof second === 'string' ? second : '',
      });
    };

  const logger = {
    info: record(),
    warn: record(),
    error: record(),
    debug: record(),
    fatal: record(),
    trace: record(),
    silent: () => {},
    level: 'info',
  };
  return { ...logger, child: () => logger } as unknown as FastifyBaseLogger;
}

function testConfig(environmentTimezone: string): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    SCHEDULE_TIMEZONE: environmentTimezone,
  });
}

/** The zone the most recent "schedules built" line reported. */
function builtTimezone(lines: readonly LogLine[]): unknown {
  const built = lines.filter((line) => line.message === 'schedules built');
  return built[built.length - 1]?.fields['timezone'];
}

let scheduler: Scheduler | null = null;
let lines: LogLine[] = [];

beforeEach(async () => {
  await resetDatabase();
  lines = [];
});

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
});

async function chooseTimezone(zone: string | null): Promise<void> {
  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, scheduleTimezone: zone },
    update: { scheduleTimezone: zone },
  });
}

describe('the schedule timezone', () => {
  /**
   * The upgrade case. Nobody has chosen, so the schedules stay exactly where the
   * environment put them — this feature must change when nothing fires.
   */
  it('follows the environment when nothing has been chosen', async () => {
    await chooseTimezone(null);
    scheduler = await startScheduler(testConfig('UTC'), recordingLogger(lines));

    expect(builtTimezone(lines)).toBe('UTC');
  });

  it('prefers the zone chosen in Settings over the environment', async () => {
    await chooseTimezone('America/Chicago');
    scheduler = await startScheduler(testConfig('UTC'), recordingLogger(lines));

    expect(builtTimezone(lines)).toBe('America/Chicago');
  });

  /**
   * The one that matters. Without a rebuild the new zone sits in the database
   * doing nothing while the tasks keep the zone they were created with.
   */
  it('rebuilds the tasks when the zone changes, without a restart', async () => {
    await chooseTimezone('UTC');
    scheduler = await startScheduler(testConfig('UTC'), recordingLogger(lines));
    expect(builtTimezone(lines)).toBe('UTC');

    await chooseTimezone('America/Chicago');
    await scheduler.reload();

    expect(builtTimezone(lines)).toBe('America/Chicago');
  });

  it('goes back to the environment when the choice is cleared', async () => {
    await chooseTimezone('Europe/London');
    scheduler = await startScheduler(testConfig('America/Chicago'), recordingLogger(lines));
    expect(builtTimezone(lines)).toBe('Europe/London');

    await chooseTimezone(null);
    await scheduler.reload();

    expect(builtTimezone(lines)).toBe('America/Chicago');
  });

  /**
   * A leaked task would double every job. Two syncs collide harmlessly on
   * `sync_already_running`, but two backups are two dumps and two snapshot runs
   * are wasted work on a two-core NAS.
   */
  it('stops the old tasks rather than leaving them running beside the new ones', async () => {
    await chooseTimezone('UTC');
    scheduler = await startScheduler(testConfig('UTC'), recordingLogger(lines));

    const first = lines.filter((line) => line.message === 'schedules built')[0];
    const jobs = first?.fields['jobs'];

    await scheduler.reload();
    await scheduler.reload();

    // Each build reports the same number of tasks. A build that appended to the
    // previous set instead of replacing it would report a growing count.
    const counts = lines
      .filter((line) => line.message === 'schedules built')
      .map((line) => line.fields['jobs']);
    expect(counts).toEqual([jobs, jobs, jobs]);
  });
});

/**
 * The snapshot job is one of the schedules, and runs in the same zone as the
 * rest. Its date labelling depends on that zone, so a job registered without it
 * would file rows under the wrong day.
 */
describe('the nightly snapshot', () => {
  it('is scheduled, in the zone the others use', async () => {
    await chooseTimezone('America/Chicago');
    scheduler = await startScheduler(testConfig('UTC'), recordingLogger(lines));

    const enabled = lines.find((line) => line.message === 'nightly snapshot enabled');
    expect(enabled).toBeDefined();
    expect(enabled?.fields['timezone']).toBe('America/Chicago');
    expect(enabled?.fields['cron']).toBe('10 3 * * *');
  });

  /**
   * Off the hour so it does not contend with the hourly sync on two cores, after
   * the price fetch so yesterday's Bitcoin close is settled by the time it runs,
   * and outside 02:00-02:59 — an hour that does not exist locally on the
   * spring-forward morning.
   */
  it('runs after the price fetch and clear of the non-existent hour', () => {
    const config = testConfig('UTC');
    const [snapshotMinute, snapshotHour] = config.SNAPSHOT_CRON.split(' ');
    const [priceMinute] = config.BITCOIN_PRICE_CRON.split(' ');

    expect(Number(snapshotHour)).toBe(3);
    expect(Number(snapshotMinute)).toBeGreaterThan(Number(priceMinute));
  });
});
