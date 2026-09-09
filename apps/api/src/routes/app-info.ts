import type { FastifyPluginCallback } from 'fastify';

/**
 * What the UI needs before anyone has signed in.
 *
 * Only the application's display name, which comes from configuration so that a
 * household name never reaches the repository. Deliberately unauthenticated: the
 * sign-in screen renders it.
 */
export const appInfoRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get('/api/app', () => ({
    appName: fastify.config.APP_NAME,
    /*
     * Whether this instance is a read-only demo.
     *
     * The interface needs to know so it can stop offering what it cannot do: a
     * control that answers 403 is worse than one that is not there. This is the
     * *presentation* of the rule and never the rule itself — that is the wall in
     * `plugins/demo.ts`, which refuses a write whatever the interface drew.
     */
    demo: fastify.config.DELEGATE_DEMO,
  }));
  done();
};
