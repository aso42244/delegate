import { ACCOUNT_TYPES, bitcoinValueCents } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { latestPrice } from '../domain/bitcoin.js';
import {
  archiveAccount,
  createManualAccount,
  restoreAccount,
  updateAccount,
} from '../domain/accounts.js';
import { equityFor, listValuations, recordValuation } from '../domain/valuations.js';
import { centsInLoose, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The account list.
 *
 * The Budget page's read model carries only in-budget accounts, because that is
 * what the identity is made of. Entering a transaction by hand needs the whole
 * live set: a mortgage payment lands on an account that is deliberately
 * off-budget, and leaving it unpickable would mean the register for it could
 * never be corrected.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(100),
  nickname: z.string().max(40).nullish(),
  type: z.enum(ACCOUNT_TYPES),
  balanceCents: centsInLoose,
  inBudget: z.boolean().optional(),
  inNetWorth: z.boolean().optional(),
  stalenessIntervalDays: z.number().int().nullish(),
  groupingId: z.string().uuid().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // Short by constraint: the point is fitting where the full name does not.
  nickname: z.string().max(40).nullish(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  inBudget: z.boolean().optional(),
  inNetWorth: z.boolean().optional(),
  stalenessIntervalDays: z.number().int().nullish(),
  groupingId: z.string().uuid().nullish(),
  needsReview: z.boolean().optional(),
  balanceCents: centsInLoose.optional(),
  // A property may point at the mortgage secured against it; equity is the
  // difference, computed on read.
  mortgageAccountId: z.string().uuid().nullish(),
});

export const accountRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/accounts', async (request) => {
    const query = listQuerySchema.parse(request.query ?? {});

    const accounts = await prisma.account.findMany({
      where: query.includeArchived ? {} : { archivedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        source: true,
        balanceCents: true,
        inBudget: true,
        inNetWorth: true,
        needsReview: true,
        balanceAsOf: true,
        stalenessIntervalDays: true,
        groupingId: true,
        mortgageAccountId: true,
        bitcoinSats: true,
        nickname: true,
        archivedAt: true,
      },
      // Alphabetical is the only order this system has.
      orderBy: { name: 'asc' },
    });

    // A Bitcoin account carries no dollar balance; its worth is the quantity at
    // today's price. Reporting the raw column showed a real holding as $0.00.
    const price = accounts.some((account) => account.bitcoinSats !== null)
      ? await latestPrice(prisma)
      : null;

    const worthOf = (account: (typeof accounts)[number]): bigint => {
      if (account.bitcoinSats === null) return account.balanceCents;
      return price === null ? 0n : bitcoinValueCents(account.bitcoinSats, price.priceCents);
    };

    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        nickname: account.nickname,
        type: account.type,
        source: account.source,
        balanceCents: centsOut(worthOf(account)),
        inBudget: account.inBudget,
        inNetWorth: account.inNetWorth,
        needsReview: account.needsReview,
        balanceAsOf: dateOut(account.balanceAsOf),
        stalenessIntervalDays: account.stalenessIntervalDays,
        groupingId: account.groupingId,
        mortgageAccountId: account.mortgageAccountId,
        // Satoshis as a decimal string, the same reasoning as cents.
        bitcoinSats: account.bitcoinSats?.toString() ?? null,
        archivedAt: dateOut(account.archivedAt),
      })),
    };
  });

  /** Manual accounts only; a SimpleFIN account is discovered by a sync. */
  fastify.post('/api/accounts', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const created = await createManualAccount(prisma, body);

    request.log.info(
      { accountId: created.id, actorId: request.currentUser?.id },
      'manual account created',
    );
    return reply.code(201).send({ account: created });
  });

  fastify.patch('/api/accounts/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await updateAccount(prisma, id, updateSchema.parse(request.body));
    return { ok: true };
  });

  fastify.post('/api/accounts/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    // Blocked while an in-budget account still holds money: the identity
    // subtracts what the accounts hold, so this would move the bottom line.
    await archiveAccount(prisma, id);

    request.log.info({ accountId: id, actorId: request.currentUser?.id }, 'account archived');
    return { ok: true };
  });

  fastify.post('/api/accounts/:id/restore', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await restoreAccount(prisma, id);
    return { ok: true };
  });

  // --- Valuations --------------------------------------------------------

  /**
   * Records what something was worth on a date. Manual entry only — see §8 on
   * why there is no property valuation API behind this.
   */
  fastify.post('/api/accounts/:id/valuations', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({
        valueCents: centsInLoose,
        asOf: z.coerce.date(),
        note: z.string().max(500).nullish(),
      })
      .parse(request.body);

    const result = await recordValuation(prisma, {
      accountId: id,
      valueCents: body.valueCents,
      asOf: body.asOf,
      note: body.note ?? null,
      actorId: request.currentUser?.id ?? null,
    });

    request.log.info(
      { accountId: id, isCurrent: result.isCurrent, actorId: request.currentUser?.id },
      'valuation recorded',
    );
    return reply.code(201).send(result);
  });

  /** The history behind the current figure, newest first. */
  fastify.get('/api/accounts/:id/valuations', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const valuations = await listValuations(prisma, id);

    return {
      valuations: valuations.map((valuation) => ({
        id: valuation.id,
        valueCents: centsOut(valuation.valueCents),
        asOf: dateOut(valuation.asOf),
        note: valuation.note,
      })),
    };
  });

  /** Equity, computed on read. Null when no mortgage is linked. */
  fastify.get('/api/accounts/:id/equity', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const equity = await equityFor(prisma, id);

    if (!equity) return { equity: null };
    return {
      equity: {
        propertyValueCents: centsOut(equity.propertyValueCents),
        mortgageBalanceCents: centsOut(equity.mortgageBalanceCents),
        equityCents: centsOut(equity.equityCents),
      },
    };
  });

  done();
};
