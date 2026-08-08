import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { prisma } from './db/client.js';

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

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');
  try {
    // Order matters: stop accepting requests, let in-flight ones finish, then
    // release the connection pool.
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
