import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { prisma } from './db/client.js';
import { getBudgetSettings } from './domain/settings.js';
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

// 0.0.0.0, not localhost: inside a container, binding to the loopback interface
// makes the app unreachable from the host no matter how ports are published.
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

/**
 * The combination worth refusing to be quiet about: reachable from the internet
 * through a proxy, while the sign-in page is protected by a password alone.
 *
 * Not an error — the household may be mid-enrolment, and refusing to boot would
 * lock them out of the screen where they fix it.
 */
if (config.TRUST_PROXY) {
  const { requireTotp } = await getBudgetSettings(prisma);
  if (!requireTotp) {
    app.log.warn(
      'a proxy is trusted, so this may be reachable from outside the LAN, but two-factor is not required of every account. Turn it on in Settings -> Security.',
    );
  }
}

// Started after the listener is up, so a slow first sync cannot delay the app
// becoming reachable and failing its container health check.
const scheduler = startScheduler(config, app.log);

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
