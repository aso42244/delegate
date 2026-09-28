import type { FastifyPluginCallback } from 'fastify';

/**
 * What the UI needs before anyone has signed in.
 *
 * Only the application's display name, which comes from configuration so that a
 * household name never reaches the repository. Deliberately unauthenticated: the
 * sign-in screen renders it.
 */
export const appInfoRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get('/api/app', () => ({ appName: fastify.config.APP_NAME }));
  done();
};
