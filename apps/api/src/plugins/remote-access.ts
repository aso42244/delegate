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
 * While it is off, **every** path answers an empty 404 — `/health` included.
 * That endpoint used to be exempt so a health check would keep working, which
 * sounded reasonable and was the loudest signal here: Docker's own health check
 * runs inside the compose network and never carries an onion `Host`, so the
 * exemption served nothing and confirmed a live service to anyone holding the
 * address. Logging out was exempt on similar reasoning — a session that cannot
 * reach anything does not need ending from here, and it can be ended from the
 * LAN or by changing a password, which revokes every other session anyway.
 *
 * The test is the `Host` header. A Tor Browser asking for `abc…xyz.onion` sends
 * exactly that, and nothing on the local network does — a LAN request carries an
 * IP address or a hostname. That also makes the CSRF origin check work over Tor
 * with no extra configuration, because origin and host agree.
 */

// eslint-disable-next-line @typescript-eslint/require-await -- fastify-plugin's signature
const remoteAccessPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    // Port stripped: an onion service may be published on a non-standard one.
    if (!/\.onion(:\d+)?$/i.test(host)) return;

    const { remoteOverTorEnabled } = await getBudgetSettings(prisma);
    if (remoteOverTorEnabled) return;

    // Logged here, where the household can read it and nobody else can.
    request.log.warn({ url: request.url }, 'remote access over Tor is off; request refused');

    /*
     * An empty 404, and nothing else.
     *
     * This used to answer 403 with "Remote access over Tor is switched off.
     * Turn it on from Settings → …", on the reasoning that whoever read it was
     * overwhelmingly likely to be the household having forgotten. That is
     * probably true and it is the wrong trade, because of who *else* it can be.
     *
     * Anyone reaching this holds the address. To them the old reply confirmed
     * four things: that a service is really there, that it is this application,
     * that remote access is a feature of it, and that it is currently off —
     * which is to say the address is live and worth keeping for later. A 404
     * with no body confirms none of them. Off is indistinguishable from nothing
     * ever having been here.
     *
     * The household loses a hint they can get from the LAN in one tap, on the
     * page that holds the switch.
     */
    await reply.code(404).send();
  });
};

export const remoteAccess = fp(remoteAccessPlugin, { name: 'remote-access' });
