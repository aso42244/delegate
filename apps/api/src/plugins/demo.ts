import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * A demo instance is read-only, and this is where that is true.
 *
 * **A wall rather than a mode.** Every request that is not a read is refused
 * here, before it reaches a route — so "read-only" is one rule somebody can read
 * in twenty seconds and audit, rather than a promise spread across every button
 * in the interface and every handler behind them. The interface hides what it
 * cannot do, because a control that fails is worse than one that is absent; but
 * the interface is not what enforces this.
 *
 * The method is the test, not a list of paths. A list of write endpoints is a
 * list somebody has to remember to add to, and the one nobody adds is the one
 * that matters — whereas every write in this application is a POST, PUT, PATCH
 * or DELETE, and every read is a GET or a HEAD. Adding a route cannot widen this.
 *
 * **Sign-out is the one exception.** It is a POST, it destroys only the
 * visitor's own session, and without it somebody looking at the demo cannot
 * leave it. Refusing it would be enforcing nothing and costing something.
 */
const READABLE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The one write a visitor may make: ending their own session. */
const ALLOWED_WRITES = new Set(['/api/auth/logout']);

// eslint-disable-next-line @typescript-eslint/require-await -- a plugin's signature
const demoPluginCallback: FastifyPluginAsync = async (fastify) => {
  if (!fastify.config.DELEGATE_DEMO) return;

  fastify.log.warn('Demo mode: this instance is read-only and serves invented data.');

  fastify.addHook('onRequest', async (request, reply) => {
    if (READABLE.has(request.method)) return;

    const path = new URL(request.url, 'http://localhost').pathname;
    if (ALLOWED_WRITES.has(path)) return;

    await reply.code(403).send({
      error: {
        code: 'demo_read_only',
        // Said as a fact about the instance rather than about the visitor: they
        // have not done anything wrong, and there is no permission to ask for.
        message: 'This is a read-only demo. Nothing here can be changed.',
      },
    });
  });
};

export const demo = fp(demoPluginCallback, { name: 'demo' });
