import Fastify, { type FastifyInstance } from 'fastify';
import { getConfig, type AppConfig } from './config.js';
import { errorHandler } from './http/errors.js';
import { auth } from './plugins/auth.js';
import { configPlugin } from './plugins/config.js';
import { spa } from './plugins/spa.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { ruleRoutes } from './routes/rules.js';
import { syncRoutes } from './routes/sync.js';
import { appInfoRoutes } from './routes/app-info.js';
import { budgetRoutes } from './routes/budget.js';
import { transactionRoutes } from './routes/transactions.js';
import { userRoutes } from './routes/users.js';

/**
 * Builds the Fastify instance.
 *
 * Separated from `server.ts` so tests can build an app, drive it through
 * `app.inject()` and never bind a port.
 */
/**
 * Correlation ids: a base-36 process stamp plus a counter, e.g. `mfk2p1x-1`.
 *
 * The stamp differs per process start and the counter per request, so an id is
 * unique across restarts without needing a random source — correlation is not a
 * security property, and this keeps the ids short enough for a user to read one
 * off the screen and quote it.
 */
function createRequestIdFactory(): () => string {
  const processStamp = Date.now().toString(36);
  let counter = 0;
  return () => `${processStamp}-${++counter}`;
}

export async function buildApp(config: AppConfig = getConfig()): Promise<FastifyInstance> {
  const nextRequestId = createRequestIdFactory();

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
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? nextRequestId(),
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
  await app.register(transactionRoutes);
  await app.register(budgetRoutes);

  // Registered last: its not-found handler is the SPA fallback, so it must see
  // every API route already declared.
  await app.register(spa);

  return app;
}
