import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

/**
 * Rate limiting and response headers.
 *
 * The rate limit is the one that matters. Until now nothing throttled password
 * guessing beyond the ~50 ms an argon2id hash costs, which meant an attacker on
 * the LAN could try roughly twenty passwords a second forever. ADR 007 called
 * that "the single strongest reason not to expose this application before Phase
 * 3 completes"; this is that reason being addressed.
 */

/**
 * In-process, per ADR 001: a two-person household does not justify Redis, and
 * the counters live as long as the process. A restart forgives outstanding
 * attempts, which is an acceptable trade for not introducing a dependency —
 * an attacker cannot restart the container, and a crash-loop has larger
 * problems than a reset counter.
 */
const securityPlugin: FastifyPluginAsync<{ config: AppConfig }> = async (fastify, options) => {
  const { config } = options;

  await fastify.register(fastifyRateLimit, {
    global: false,
    // Keyed on the connecting address. A household behind one NAT shares a
    // bucket, which is why the authenticated limits below are generous: the
    // point is to stop a guessing loop, not to inconvenience two people.
    keyGenerator: (request) => request.ip,
    /**
     * Returns a real `Error` carrying its own status, not a plain object.
     *
     * A plain object reaches the application's error handler with no `name`,
     * `code`, `statusCode` or `message` on it, and is answered as a generic
     * 500 — a rate limit that reports "something went wrong" is one nobody can
     * tell from a broken server.
     */
    errorResponseBuilder: () => {
      const error = new Error('Too many attempts. Wait a few minutes and try again.');
      Object.assign(error, { statusCode: 429, code: 'too_many_requests' });
      return error;
    },
  });

  await fastify.register(fastifyHelmet, {
    // The application serves its own bundle from its own origin and loads
    // nothing else. Stating that explicitly means an injected script tag has
    // nowhere to fetch from.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite emits a hashed stylesheet; inline styles come from the React
        // `style` attributes the tables use for grouping tints.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Nothing here should ever be framed. Clickjacking a Delegate button
        // means clickjacking a money movement.
        frameAncestors: ["'none'"],
      },
    },
    // HSTS is meaningless over plain http and actively harmful to enable early:
    // a browser that has seen it will refuse http afterwards, which would lock
    // the household out of their own LAN deployment. It arrives with TLS.
    hsts: config.SESSION_COOKIE_SECURE,
    // The referrer of a budget page is nobody's business.
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
};

export const security = fp(securityPlugin, { name: 'security' });

/**
 * The limit for routes that verify a credential, read from configuration.
 *
 * Deliberately **not per-username**. Locking an account after N failures lets
 * anyone who knows a username lock its owner out, which turns a guessing
 * defence into a denial-of-service tool. Per-address throttling slows a guesser
 * without handing anyone that lever.
 */
export function authRateLimit(config: AppConfig): { max: number; timeWindow: string } {
  return { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: config.AUTH_RATE_LIMIT_WINDOW };
}
