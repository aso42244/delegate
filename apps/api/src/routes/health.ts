import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';

/**
 * Health check for Docker's HEALTHCHECK and the Synology container UI.
 *
 * Deliberately unauthenticated and deliberately quiet: it reports whether the
 * process can reach its database, and nothing about versions, schema or data.
 * A health endpoint is the most-probed URL on any host.
 */
export const healthRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get('/health', async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      // Logged in full, reported as one word: a connection string in a health
      // response would be a credential leak.
      request.log.error({ err: error }, 'health check failed: database unreachable');
      return reply.code(503).send({ status: 'degraded' });
    }
  });

  done();
};
