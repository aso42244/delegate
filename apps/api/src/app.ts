import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getConfig, type AppConfig } from './config.js';
import { errorHandler } from './http/errors.js';
import { auth } from './plugins/auth.js';
import { configPlugin } from './plugins/config.js';
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
 * Builds the Fastify instance.
 *
 * Separated from `server.ts` so tests can build an app, drive it through
 * `app.inject()` and never bind a port.
 */
export async function buildApp(config: AppConfig = getConfig()): Promise<FastifyInstance> {
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
    trustProxy: false,
  });

  app.setErrorHandler(errorHandler);
  // The not-found handler is set by the spa plugin, which owns the decision
  // between a JSON 404 and the client-side routing fallback.

  await app.register(configPlugin, { config });
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
