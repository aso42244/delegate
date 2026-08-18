import { bitcoinValueCents } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { fetchAndRecordPrice, latestPrice, providerByName } from '../domain/bitcoin.js';
import { createHolding, updateHolding } from '../domain/managed-accounts.js';
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
    const [price, accounts, settings] = await Promise.all([
      latestPrice(prisma),
      prisma.account.findMany({
        where: { archivedAt: null, managedAs: 'bitcoin' },
        select: {
          id: true,
          name: true,
          bitcoinSats: true,
          inBudget: true,
          inNetWorth: true,
          balanceAsOf: true,
          stalenessIntervalDays: true,
          bitcoinRevaluedAt: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.budgetSettings.findUnique({
        where: { id: 1 },
        select: { bitcoinInBudgetAckAt: true },
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
      balanceAsOf: dateOut(account.balanceAsOf),
      stalenessIntervalDays: account.stalenessIntervalDays,
      // Only in-budget holdings carry one, and it is what the identity is
      // balanced against.
      revaluedAt: dateOut(account.bitcoinRevaluedAt),
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
      // False once someone has read what an in-budget holding does to the
      // banner. The UI asks before the first one, not before every one.
      inBudgetWarningDue: settings?.bitcoinInBudgetAckAt == null,
    };
  });

  /**
   * A holding, created where it is managed.
   *
   * No account has to exist first. This is the whole point: a Bitcoin holding is
   * still an ordinary row in `accounts`, because the identity and the net worth
   * chart both read that table — but it is created, renamed and retired here
   * rather than typed into Settings → Accounts as a separate step.
   */
  fastify.post('/api/bitcoin/holdings', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        sats: satsIn.optional(),
        inBudget: z.boolean().optional(),
        inNetWorth: z.boolean().optional(),
        stalenessIntervalDays: z.number().int().nullish(),
      })
      .parse(request.body);

    const created = await prisma.$transaction((tx) => createHolding(tx, body));

    request.log.info(
      { accountId: created.id, actorId: request.currentUser?.id },
      'Bitcoin holding created',
    );
    return reply.code(201).send({ holding: created });
  });

  fastify.patch('/api/bitcoin/holdings/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        sats: satsIn.optional(),
        inBudget: z.boolean().optional(),
        inNetWorth: z.boolean().optional(),
        stalenessIntervalDays: z.number().int().nullish(),
      })
      .parse(request.body);

    await prisma.$transaction((tx) => updateHolding(tx, id, body));
    return { ok: true };
  });

  /**
   * The one-time acknowledgement of what an in-budget holding does to the banner.
   *
   * Household-wide, because the consequence is: the identity everyone reads gets
   * balanced against a Bitcoin price up to a day old. Shown once rather than on
   * every toggle — a warning repeated every time is one nobody reads.
   */
  fastify.post('/api/bitcoin/in-budget-acknowledgement', async (request) => {
    await prisma.budgetSettings.update({
      where: { id: 1 },
      data: { bitcoinInBudgetAckAt: new Date() },
    });
    request.log.info(
      { actorId: request.currentUser?.id },
      'Bitcoin in-budget warning acknowledged',
    );
    return { ok: true };
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
