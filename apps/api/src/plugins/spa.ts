import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { notFoundHandler } from '../http/errors.js';

/**
 * Serves the built UI.
 *
 * One container serves both the API and the interface, so there is no second
 * process to run on the NAS and no cross-origin configuration to get wrong —
 * which also means the session cookie is same-origin by construction.
 *
 * In development Vite serves the UI on its own port and proxies `/api` here, so
 * with no build present this falls back to an API-only 404.
 *
 * This plugin owns the **only** not-found handler in the application. Fastify
 * permits exactly one per instance, and the SPA fallback and the JSON 404 are
 * the same decision made on the request path.
 */
const spaPluginCallback: FastifyPluginAsync = async (fastify) => {
  const root = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const hasBuild = existsSync(root);

  if (hasBuild) {
    // Files are resolved per request rather than enumerated once at startup.
    // With `wildcard: false` the routes are fixed at boot, so a rebuild while
    // the server is up leaves every newly hashed asset unroutable — and because
    // they then fall through to the SPA fallback below, the browser receives
    // `index.html` with a 200 and reports only a baffling MIME type error.
    await fastify.register(fastifyStatic, { root });
  } else {
    fastify.log.info('No UI build found; serving the API only.');
  }

  fastify.setNotFoundHandler((request, reply) => {
    // API 404s stay JSON. Returning a page of HTML to something expecting a
    // payload turns a clear mistake into a confusing one.
    if (!hasBuild || request.url.startsWith('/api')) {
      notFoundHandler(request, reply);
      return;
    }

    // A path with a file extension is asking for a *file*. If it is missing, say
    // so plainly: answering with index.html turns a missing asset into
    // "Expected a JavaScript module but got text/html", which points nowhere
    // near the actual problem.
    if (/\.[a-z0-9]+$/i.test(new URL(request.url, 'http://localhost').pathname)) {
      notFoundHandler(request, reply);
      return;
    }

    // Anything else is client-side routing: a deep link or a refresh on
    // /transactions has to render the app rather than 404.
    void reply.sendFile('index.html');
  });
};

export const spa = fp(spaPluginCallback, { name: 'spa' });
