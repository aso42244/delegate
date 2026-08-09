import { bitcoinValueCents } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { fetchAndRecordPrice, latestPrice, providerByName } from '../domain/bitcoin.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Bitcoin holdings and the current price.
 *
 * The holding is a quantity of satoshis on an account; what it is worth is
 * computed here rather than stored. A stored dollar value would be wrong within
 * the minute and would make every historical point on the net worth chart wrong
 * too.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Satoshis, as a decimal string of whole units — the same reasoning as cents.
 * 21 million Bitcoin is 2.1 × 10^15 satoshis, which is inside a JS safe integer
 * today, but the value crosses JSON as a string so it can never quietly stop
 * being exact.
 */
const satsIn = z
  .string()
  .regex(/^\d+$/, 'Satoshis must be a whole, non-negative number, as a string')
  .transform((value) => BigInt(value));

export const bitcoinRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /**
   * The current price, the holdings, and what they are worth.
   *
   * `stale` is carried rather than hidden: a price nobody could refresh today is
   * still the best answer available, and showing it marked beats showing a zero.
   */
  fastify.get('/api/bitcoin', async () => {
    const [price, accounts] = await Promise.all([
      latestPrice(prisma),
      prisma.account.findMany({
        where: { archivedAt: null, bitcoinSats: { not: null } },
        select: { id: true, name: true, bitcoinSats: true, inBudget: true, inNetWorth: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const holdings = accounts.map((account) => ({
      id: account.id,
      name: account.name,
      sats: account.bitcoinSats?.toString() ?? '0',
      inBudget: account.inBudget,
      inNetWorth: account.inNetWorth,
      valueCents:
        price === null
          ? null
          : centsOut(bitcoinValueCents(account.bitcoinSats ?? 0n, price.priceCents)),
    }));

    return {
      price:
        price === null
          ? null
          : {
              priceCents: centsOut(price.priceCents),
              priceDate: dateOut(price.priceDate),
              source: price.source,
              fetchedAt: dateOut(price.fetchedAt),
              stale: price.stale,
            },
      holdings,
    };
  });

  /** Sets the quantity held on an account. The quantity is the fact; value is derived. */
  fastify.patch('/api/accounts/:id/bitcoin', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { sats } = z.object({ sats: z.union([satsIn, z.null()]) }).parse(request.body);

    await prisma.account.update({
      where: { id },
      data: {
        bitcoinSats: sats,
        // Typing a quantity is confirming it, which is what staleness counts from.
        balanceAsOf: new Date(),
      },
    });

    request.log.info({ accountId: id, actorId: request.currentUser?.id }, 'Bitcoin holding set');
    return { ok: true };
  });

  /** Fetch now, rather than waiting for the hour. */
  fastify.post('/api/bitcoin/refresh', async (request) => {
    const result = await fetchAndRecordPrice(prisma, [
      providerByName(request.server.config.BITCOIN_PRICE_PRIMARY),
      providerByName(request.server.config.BITCOIN_PRICE_FALLBACK),
    ]);

    if (!result) return { updated: false };
    return {
      updated: true,
      priceCents: centsOut(result.priceCents),
      source: result.source,
      closesSettled: result.closesSettled,
    };
  });

  done();
};
