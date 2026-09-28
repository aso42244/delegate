import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { buildNotifications } from '../domain/notifications.js';
import { householdTimezone } from '../domain/settings.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * What the application wants to tell the owner about itself.
 *
 * Computed on read rather than stored: a condition that has resolved should stop
 * being reported because it resolved, not because somebody dismissed it.
 */
export const notificationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/notifications', async () => ({
    // The backup directory comes from configuration rather than a constant: the
    // check is about this deployment's disk, not about the code's idea of one.
    notifications: await buildNotifications(
      prisma,
      // "Is the price from today" is a question about the household's today.
      await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE),
      new Date(),
      { backupDir: fastify.config.BACKUP_DIR },
    ),
  }));

  done();
};
