import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../db/client.js';
import { getBudgetSettings } from '../domain/settings.js';

/**
 * Whether a request arriving over the Tor onion address is answered at all.
 *
 * The onion service and the permission to use it are deliberately two separate
 * things. An onion address is 56 unguessable characters with no DNS record and
 * no certificate transparency entry, so nothing finds it by scanning — but
 * "unguessable" and "closed" are different properties, and only one of them
 * survives the address being written down, screenshotted, or read off a phone.
 *
 * So the address existing does not open the budget. Someone has to turn remote
 * access on, and the only place to do that is from the LAN, where this check
 * does not apply.
 *
 * The test is the `Host` header. A Tor Browser asking for `abc…xyz.onion` sends
 * exactly that, and nothing on the local network does — a LAN request carries an
 * IP address or a hostname. That also makes the CSRF origin check work over Tor
 * with no extra configuration, because origin and host agree.
 */

/** Bypassed, so the state can be read and a session ended over Tor regardless. */
const ALWAYS_ALLOWED = new Set(['/health', '/api/auth/logout']);

// eslint-disable-next-line @typescript-eslint/require-await -- fastify-plugin's signature
const remoteAccessPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    // Port stripped: an onion service may be published on a non-standard one.
    if (!/\.onion(:\d+)?$/i.test(host)) return;

    if (ALWAYS_ALLOWED.has(request.url.split('?')[0] ?? '')) return;

    const { remoteOverTorEnabled } = await getBudgetSettings(prisma);
    if (remoteOverTorEnabled) return;

    request.log.warn({ url: request.url }, 'remote access over Tor is off; request refused');

    // 403 and a plain explanation rather than a silent drop. Whoever is reading
    // this is overwhelmingly likely to be the household, on their own phone,
    // having forgotten they never turned it on.
    await reply.code(403).send({
      error: {
        code: 'remote_access_disabled',
        message:
          'Remote access over Tor is switched off. Turn it on from Settings → Security while on the home network.',
      },
    });
  });
};

export const remoteAccess = fp(remoteAccessPlugin, { name: 'remote-access' });
