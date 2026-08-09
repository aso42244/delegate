import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';

/**
 * Cross-site request forgery protection.
 *
 * The attack this stops: a page on another site causes the household's browser
 * to issue a state-changing request here, which the browser helpfully attaches
 * the session cookie to. Delegate is the wrong application to lose that
 * argument — a forged request can move money between delegations.
 *
 * Two independent layers, either of which is sufficient on its own:
 *
 * 1. **`SameSite=Lax` on the session cookie** (see `plugins/auth.ts`), so the
 *    browser does not attach it to cross-site form posts in the first place.
 * 2. **The origin check below**, which does not depend on the browser having
 *    got its cookie policy right.
 *
 * The deliberate choice here is *not* to use a double-submit token. A token
 * needs the client to read it and echo it on every mutation — plumbing that is
 * easy to forget on one new call site, and silently absent rather than loudly
 * broken when it is. The origin check has no per-call-site surface at all: it
 * cannot be forgotten, because there is nothing to remember.
 *
 * Why "absent header" is allowed rather than refused: the Fetch standard has
 * browsers send `Origin` on *every* request whose method is not GET or HEAD,
 * same-site included, and page script cannot remove it. So a browser making a
 * forged request always carries one. A request arriving with no `Origin` at all
 * did not come from a browser, and therefore cannot be carrying a cookie the
 * browser attached on someone else's behalf — which is the entire attack. That
 * also leaves `curl` and the test suite working without ceremony.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `Origin` is the authority; `Referer` is the fallback older clients send. */
function statedOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null') return origin;

  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // A malformed Referer is not a pass — fall through to a refusal.
      return 'malformed';
    }
  }

  return null;
}

/**
 * The set this server will answer state-changing requests from.
 *
 * Its own `Host` is always included, so a direct LAN deployment needs no
 * configuration. `TRUSTED_ORIGINS` exists for the day a reverse proxy terminates
 * TLS under a different name than the one the origin server sees.
 */
function isTrusted(origin: string, request: FastifyRequest, config: AppConfig): boolean {
  const trusted = config.TRUSTED_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (trusted.includes(origin)) return true;

  const host = request.headers.host;
  if (!host) return false;

  let hostname: string;
  try {
    hostname = new URL(origin).host;
  } catch {
    return false;
  }

  // Compared on host alone. The scheme cannot be compared usefully until TLS
  // lands: the page is served over http today, so requiring https would refuse
  // every real request, and requiring http would have to be undone later.
  return hostname === host;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify-plugin's signature
const csrfPlugin: FastifyPluginAsync<{ config: AppConfig }> = async (fastify, options) => {
  const { config } = options;

  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;

    const origin = statedOrigin(request);
    if (origin === null) return;

    if (!isTrusted(origin, request, config)) {
      request.log.warn(
        { origin, host: request.headers.host, url: request.url },
        'cross-origin request refused',
      );
      await reply.code(403).send({
        error: {
          code: 'cross_origin_refused',
          message: 'This request did not come from the budget itself.',
        },
      });
    }
  });
};

export const csrf = fp(csrfPlugin, { name: 'csrf' });
