import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { prisma } from './db/client.js';
import { assertDataKeyReadsStoredSecrets, DataKeyError } from './domain/data-key-check.js';
import { getBudgetSettings, resolveScheduleTimezone } from './domain/settings.js';
import { fillGaps } from './domain/snapshot-fill.js';
import { snapshotDateFor } from './domain/snapshots.js';
import { startScheduler } from './scheduler.js';

/**
 * Process entrypoint: build the app, listen, and shut down cleanly.
 *
 * Graceful shutdown matters more than usual here. Docker sends SIGTERM on every
 * restart and Synology package update; dropping a request mid-write could leave
 * a delegation event without its matching cached-balance update.
 */

const config = getConfig();
const app = await buildApp(config);

/*
 * Before anything listens: prove the at-rest key can still read what is stored.
 *
 * After `buildApp` so this reports through the same logger as everything else,
 * and before `listen` so a container in this state never answers a request. A
 * key that cannot read the database is not a thing to discover at a sign-in
 * screen — the second factor is decrypted before recovery codes are even
 * considered, so the whole household is locked out at once and the symptom names
 * nothing.
 *
 * Fatal on purpose. A process that answers /health while nobody can sign in is
 * the dead-backup shape wearing new clothes.
 */
try {
  await assertDataKeyReadsStoredSecrets(prisma, config.dataKey, config.DATA_ENCRYPTION_KEY !== '');
} catch (error) {
  if (error instanceof DataKeyError) {
    app.log.fatal(error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
  throw error;
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });

/**
 * Say out loud which of the two it is.
 *
 * Plain http on a trusted LAN is the documented default (ADR 017), not an
 * accident — but "not an accident" only holds if it is visible. A log line on
 * every boot is the cheapest way for this to stay a decision rather than
 * something nobody remembers choosing.
 */
if (config.TLS_CERT_PATH) {
  app.log.info({ cert: config.TLS_CERT_PATH }, 'serving over TLS');
  if (!config.SESSION_COOKIE_SECURE) {
    app.log.warn(
      'TLS is on but SESSION_COOKIE_SECURE is false. Set it to true so the session cookie is never sent in clear text.',
    );
  }
} else if (config.TRUST_PROXY) {
  // Plain http to a proxy on the same host is loopback traffic. Saying "clear
  // text" here would be alarming and wrong.
  app.log.info(
    { trustProxy: config.TRUST_PROXY },
    'serving plain http behind a trusted proxy, which is expected to terminate TLS',
  );
} else {
  app.log.warn(
    'serving over plain http: passwords, two-factor codes and the session cookie are readable by anything else on this network. See ADR 017.',
  );
  if (config.SESSION_COOKIE_SECURE) {
    app.log.warn(
      'SESSION_COOKIE_SECURE is true without TLS here. Sign-in will fail unless something in front of this terminates TLS.',
    );
  }
}

// The warning that stood here — a trusted proxy while two-factor was optional —
// cannot happen now. A second factor is required of every account, always.

// Started after the listener is up, so a slow first sync cannot delay the app
// becoming reachable and failing its container health check.
const scheduler = await startScheduler(config, app.log);

// The zone the schedules run in is a setting now, and node-cron fixes a task's
// zone when the task is created — so a save has to rebuild them. Without this
// the setting would appear to work and take effect only on the next restart.
app.schedules.setReloader(() => scheduler.reload());

/**
 * Repair any snapshot days missed while this was not running.
 *
 * A restart is the commonest reason for a gap — the NAS reboots, a deploy
 * replaces the container, the power goes — and waiting until 03:10 to notice
 * would leave the charts holed for most of a day.
 *
 * Deliberately not awaited. The listener is already up and this can take a
 * moment over a long outage; blocking boot on it would risk the container's own
 * health check, and the nightly run repairs the same gap anyway if this fails.
 */
void (async () => {
  try {
    const timezone = await currentScheduleTimezone();
    const yesterday = snapshotDateFor(new Date(), timezone);
    const filled = await fillGaps(prisma, yesterday, timezone, app.log);
    if (filled.filled > 0) {
      app.log.info({ days: filled.filled }, 'snapshot days missed during downtime were rebuilt');
    }
  } catch (error) {
    // Never fatal: a budget that will not start because a chart has a hole in it
    // is a far worse outcome than the hole.
    app.log.error({ err: error }, 'could not rebuild missed snapshot days at startup');
  }
})();

async function currentScheduleTimezone(): Promise<string> {
  const settings = await getBudgetSettings(prisma);
  return resolveScheduleTimezone(settings, config.SCHEDULE_TIMEZONE);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');
  try {
    // Order matters: stop scheduling new work, stop accepting requests, let
    // in-flight ones finish, then release the connection pool.
    scheduler.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void shutdown(signal));
}
