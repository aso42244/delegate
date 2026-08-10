import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getConfig, type AppConfig } from './config.js';
import { errorHandler } from './http/errors.js';
import { auth } from './plugins/auth.js';
import { configPlugin } from './plugins/config.js';
import { csrf } from './plugins/csrf.js';
import { security } from './plugins/security.js';
import { spa } from './plugins/spa.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { insightRoutes } from './routes/insights.js';
import { notificationRoutes } from './routes/notifications.js';
import { ruleRoutes } from './routes/rules.js';
import { settingsRoutes } from './routes/settings.js';
import { syncRoutes } from './routes/sync.js';
import { accountRoutes } from './routes/accounts.js';
import { appInfoRoutes } from './routes/app-info.js';
import { bitcoinRoutes } from './routes/bitcoin.js';
import { budgetRoutes } from './routes/budget.js';
import { transactionRoutes } from './routes/transactions.js';
import { userRoutes } from './routes/users.js';
import { utilityRoutes } from './routes/utilities.js';

/**
 * Turns `TRUST_PROXY` into what Fastify wants.
 *
 * `false` unless configured. The reason this is opt-in rather than clever
 * auto-detection: `X-Forwarded-For` is a header, and any client can send one.
 * Trusting it while the application is also reachable directly means anyone can
 * claim to be a different address on every request — which does not merely
 * weaken the sign-in rate limit, it removes it, since each forged address gets
 * its own fresh bucket.
 *
 * So it is only correct to turn this on when the application cannot be reached
 * except through the proxy. That is a fact about the deployment, which the
 * deployment has to state.
 */
function proxyTrust(value: string): boolean | string[] {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === 'true') return true;
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads the TLS material, or returns nothing when none is configured.
 *
 * Read once at boot and held in memory. A certificate that vanished from disk
 * should not take the server down at the moment someone tries to sign in, and a
 * self-signed certificate on a NAS is replaced roughly never — when it is, the
 * container restarts anyway.
 *
 * Failures here are fatal on purpose. An unreadable key means the operator
 * believes this is encrypted; falling back to plain http would be the worst
 * possible answer.
 */
function readTls(config: AppConfig): { key: Buffer; cert: Buffer } | undefined {
  if (!config.TLS_CERT_PATH || !config.TLS_KEY_PATH) return undefined;

  try {
    return {
      key: readFileSync(config.TLS_KEY_PATH),
      cert: readFileSync(config.TLS_CERT_PATH),
    };
  } catch (error) {
    // The overwhelmingly common cause is ownership, not a missing file: the
    // container runs as `node`, and a key written by whoever generated it is
    // mode 600 and owned by them. A bare EACCES stack trace reads like a bug in
    // the application, so say what it actually is.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read the TLS material: ${detail}\n` +
        'The container runs as uid 1000. If this is a permission error, give it the files:\n' +
        '  sudo chown 1000:1000 <cert> <key>\n' +
        'Do not widen the mode instead — the key must stay unreadable to other accounts.',
    );
  }
}

/**
 * Builds the Fastify instance.
 *
 * Separated from `server.ts` so tests can build an app, drive it through
 * `app.inject()` and never bind a port.
 */
export async function buildApp(config: AppConfig = getConfig()): Promise<FastifyInstance> {
  const https = readTls(config);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Structured logs throughout. Pretty-printing is left to `pino-pretty` in
      // a dev shell rather than baked in, so container logs stay machine-readable.
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'password',
          'newPassword',
          'currentPassword',
          'temporaryPassword',
        ],
        censor: '[redacted]',
      },
    },
    // Correlation id per request, echoed to the client so a user reporting a
    // failure can quote the id from the UI and have it match a log line.
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: proxyTrust(config.TRUST_PROXY),
    // Spread rather than set: `https: undefined` is not the same as absent to
    // Fastify's overloads, and plain http is the default (ADR 017).
    ...(https ? { https } : {}),
  } satisfies FastifyServerOptions);

  app.setErrorHandler(errorHandler);
  // The not-found handler is set by the spa plugin, which owns the decision
  // between a JSON 404 and the client-side routing fallback.

  await app.register(configPlugin, { config });
  // Before the routes: the rate limiter has to be in place when they register
  // their per-route limits, and the headers apply to every response including
  // the SPA fallback.
  await app.register(security, { config });
  // Ahead of the session plugin: a forged request should be refused before it
  // costs a session lookup.
  await app.register(csrf, { config });
  await app.register(auth, { config });
  await app.register(healthRoutes);
  await app.register(appInfoRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(syncRoutes);
  await app.register(ruleRoutes);
  await app.register(settingsRoutes);
  await app.register(accountRoutes);
  await app.register(bitcoinRoutes);
  await app.register(notificationRoutes);
  await app.register(utilityRoutes);
  await app.register(insightRoutes);
  await app.register(transactionRoutes);
  await app.register(budgetRoutes);

  // Registered last: its not-found handler is the SPA fallback, so it must see
  // every API route already declared.
  await app.register(spa);

  return app;
}
