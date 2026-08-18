import { bitcoinValueCents } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { NODE_MODES, SUGGESTED_NODES, reachOf } from '@budget/shared';
import { fetchAndRecordPrice, latestPrice, providerByName } from '../domain/bitcoin.js';
import { checkNode, readNodeSettings, saveNodeSettings } from '../domain/bitcoin-node.js';
import { createHolding, updateHolding } from '../domain/managed-accounts.js';
import {
  costBasis,
  recordHoldingEvent,
  reverseHoldingEvent,
  setHoldingQuantity,
} from '../domain/bitcoin-holdings.js';
import { centsInLoose, centsOut, dateOut } from '../http/serialize.js';
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

    // Through the ledger: writing the column directly would put the cache and
    // the events out of step, and the net worth chart would go back to guessing.
    await prisma.$transaction((tx) =>
      setHoldingQuantity(tx, id, sats ?? 0n, { actorId: request.currentUser?.id ?? null }),
    );

    request.log.info({ accountId: id, actorId: request.currentUser?.id }, 'Bitcoin holding set');
    return { ok: true };
  });

  // --- The holdings ledger ------------------------------------------------

  /**
   * The dated history behind a holding, newest first, with what it cost.
   *
   * Reversed events are carried rather than hidden: a correction is part of the
   * story of what the chart showed, and dropping it would make the history read
   * as though nobody ever got anything wrong.
   */
  fastify.get('/api/bitcoin/holdings/:id/events', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    const [events, basis, account, price] = await Promise.all([
      prisma.bitcoinHoldingEvent.findMany({
        where: { accountId: id },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          occurredAt: true,
          deltaSats: true,
          eventType: true,
          priceCents: true,
          note: true,
          reversedAt: true,
        },
      }),
      costBasis(prisma, { accountId: id }),
      prisma.account.findUnique({ where: { id }, select: { bitcoinSats: true } }),
      latestPrice(prisma),
    ]);

    const heldSats = account?.bitcoinSats ?? 0n;
    const worthCents = price === null ? null : bitcoinValueCents(heldSats, price.priceCents);

    return {
      events: events.map((event) => ({
        id: event.id,
        occurredAt: dateOut(event.occurredAt),
        deltaSats: event.deltaSats.toString(),
        eventType: event.eventType,
        priceCents: event.priceCents === null ? null : centsOut(event.priceCents),
        // What this event's Bitcoin cost, so a row can be read on its own.
        costCents:
          event.priceCents === null
            ? null
            : centsOut(
                bitcoinValueCents(
                  event.deltaSats < 0n ? -event.deltaSats : event.deltaSats,
                  event.priceCents,
                ),
              ),
        note: event.note,
        reversedAt: dateOut(event.reversedAt),
      })),
      costBasis: {
        costCents: centsOut(basis.costCents),
        basisSats: basis.basisSats.toString(),
        // Held Bitcoin whose cost nobody knows — an opening balance, a transfer
        // in. Reported rather than valued at zero, which would read as "free".
        unpricedSats: basis.unpricedSats.toString(),
      },
      // Only against the priced portion, because that is the only part a gain
      // can honestly be computed for.
      unrealizedCents:
        price === null || basis.basisSats === 0n
          ? null
          : centsOut(bitcoinValueCents(basis.basisSats, price.priceCents) - basis.costCents),
      worthCents: worthCents === null ? null : centsOut(worthCents),
    };
  });

  /** A dated purchase, sale, transfer or correction. */
  fastify.post('/api/bitcoin/holdings/:id/events', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({
        eventType: z.enum(['opening', 'purchase', 'sale', 'transfer_in', 'transfer_out']),
        sats: satsIn,
        occurredAt: z.coerce.date(),
        priceCents: centsInLoose.nullish(),
        note: z.string().max(500).nullish(),
      })
      .parse(request.body);

    const result = await prisma.$transaction((tx) =>
      recordHoldingEvent(tx, {
        accountId: id,
        eventType: body.eventType,
        sats: body.sats,
        occurredAt: body.occurredAt,
        priceCents: body.priceCents ?? null,
        note: body.note ?? null,
        actorId: request.currentUser?.id ?? null,
      }),
    );

    request.log.info(
      { accountId: id, eventId: result.id, actorId: request.currentUser?.id },
      'Bitcoin holding event recorded',
    );
    return reply.code(201).send({ id: result.id, balanceSats: result.balanceSats.toString() });
  });

  /** Backs one out. Stamped, never deleted — see the domain header. */
  fastify.post('/api/bitcoin/events/:id/reverse', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const result = await prisma.$transaction((tx) => reverseHoldingEvent(tx, id));
    return result;
  });

  // --- The node -----------------------------------------------------------

  fastify.get('/api/bitcoin/node', async () => {
    const settings = await readNodeSettings(prisma);
    return {
      mode: settings.mode,
      baseUrl: settings.baseUrl,
      useTor: settings.useTor,
      reach: settings.baseUrl === null ? null : reachOf(settings.baseUrl),
      lastCheckedAt: dateOut(settings.lastCheckedAt),
      lastHeight: settings.lastHeight,
      lastError: settings.lastError,
      suggestions: SUGGESTED_NODES,
    };
  });

  /**
   * Stores where to ask. The URL is checked here rather than when it is used —
   * a public endpoint saved over plain http would sit looking fine and then send
   * every address lookup across the internet in the clear.
   */
  fastify.put('/api/bitcoin/node', async (request) => {
    const body = z
      .object({
        mode: z.enum(NODE_MODES),
        baseUrl: z.string().max(500).nullish(),
        useTor: z.boolean().optional(),
      })
      .parse(request.body);

    await saveNodeSettings(prisma, body);
    request.log.info(
      // The URL is not a secret, but it is not logged either: on Tor it names
      // which onion service the household talks to.
      { mode: body.mode, actorId: request.currentUser?.id },
      'Bitcoin node configured',
    );
    return { ok: true };
  });

  /** Asks for the chain tip, which is the cheapest proof a node is answering. */
  fastify.post('/api/bitcoin/node/check', async () => checkNode(prisma));

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
