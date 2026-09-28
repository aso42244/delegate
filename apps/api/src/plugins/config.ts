import type { FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

/**
 * Makes the application's configuration reachable from any route as
 * `fastify.config`.
 *
 * Routes must not reach for the process-wide config directly: that is a second
 * source of truth, and it silently ignores whatever configuration the app was
 * actually built with — which makes any route that reads it untestable.
 */

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

const configPluginCallback: FastifyPluginCallback<{ config: AppConfig }> = (
  fastify,
  options,
  done,
) => {
  fastify.decorate('config', options.config);
  done();
};

export const configPlugin = fp(configPluginCallback, { name: 'config' });
