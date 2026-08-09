import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { buildNotifications } from '../domain/notifications.js';
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
    notifications: await buildNotifications(prisma),
  }));

  done();
};
