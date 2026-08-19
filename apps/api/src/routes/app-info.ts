import type { FastifyPluginCallback } from 'fastify';

/**
 * What a client needs before it can do anything else.
 *
 * Deliberately unauthenticated: the sign-in screen renders the name, which comes
 * from configuration so a household name never reaches the repository.
 *
 * It is also the one route in the token allowlist whose answer depends on the
 * token. An MCP client has to know whether it may write *before* it advertises
 * a tool that writes — offering a model a tool that will always be refused
 * wastes a turn and reads to the user as a broken connection.
 */
export const appInfoRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get('/api/app', (request) => ({
    appName: fastify.config.APP_NAME,
    // Null for a browser, which does not have a scope and does not need one.
    tokenScope: request.apiToken?.scope ?? null,
  }));
  done();
};
