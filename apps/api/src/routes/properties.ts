import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { createProperty, updateProperty } from '../domain/managed-accounts.js';
import { equityFor, listValuations } from '../domain/valuations.js';
import { centsInLoose, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Properties, created where they are managed.
 *
 * A property is still an ordinary row in `accounts` — the net worth chart and
 * the equity netting both read that table. What lives here is the lifecycle, so
 * a house is never entered under Settings → Accounts and then valued somewhere
 * else as a second step.
 *
 * Valuations themselves stay on `/api/accounts/:id/valuations`: recording what
 * something was worth is not specific to a house, and the same route already
 * serves anything kept by hand.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

export const propertyRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/properties', async () => {
    const accounts = await prisma.account.findMany({
      where: { archivedAt: null, managedAs: 'property' },
      select: {
        id: true,
        name: true,
        balanceCents: true,
        inBudget: true,
        inNetWorth: true,
        balanceAsOf: true,
        stalenessIntervalDays: true,
        mortgageAccountId: true,
        mortgageAccount: { select: { id: true, name: true, balanceCents: true } },
      },
      orderBy: { name: 'asc' },
    });

    const properties = await Promise.all(
      accounts.map(async (account) => {
        // Computed on read, never stored: a stored copy would drift from the
        // mortgage balance on every payment, in the direction that flatters.
        const equity = account.mortgageAccountId ? await equityFor(prisma, account.id) : null;
        const valuations = await listValuations(prisma, account.id);

        return {
          id: account.id,
          name: account.name,
          valueCents: centsOut(account.balanceCents),
          inBudget: account.inBudget,
          inNetWorth: account.inNetWorth,
          // The date the figure is *for*, which is the newest valuation's. Not
          // `balance_as_of`, which answers when someone last confirmed it and is
          // what staleness counts from.
          valuedAt: valuations[0] ? dateOut(valuations[0].asOf) : dateOut(account.balanceAsOf),
          confirmedAt: dateOut(account.balanceAsOf),
          stalenessIntervalDays: account.stalenessIntervalDays,
          mortgage: account.mortgageAccount
            ? {
                id: account.mortgageAccount.id,
                name: account.mortgageAccount.name,
                balanceCents: centsOut(account.mortgageAccount.balanceCents),
              }
            : null,
          equityCents: equity === null ? null : centsOut(equity.equityCents),
          valuations: valuations.map((valuation) => ({
            id: valuation.id,
            valueCents: centsOut(valuation.valueCents),
            asOf: dateOut(valuation.asOf),
            note: valuation.note,
          })),
        };
      }),
    );

    return { properties };
  });

  /** The property, its opening valuation and the mortgage against it, in one act. */
  fastify.post('/api/properties', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        valueCents: centsInLoose,
        asOf: z.coerce.date(),
        inBudget: z.boolean().optional(),
        inNetWorth: z.boolean().optional(),
        mortgageAccountId: z.string().uuid().nullish(),
        stalenessIntervalDays: z.number().int().nullish(),
      })
      .parse(request.body);

    const created = await prisma.$transaction((tx) =>
      createProperty(tx, { ...body, actorId: request.currentUser?.id ?? null }),
    );

    request.log.info(
      { accountId: created.id, actorId: request.currentUser?.id },
      'property created',
    );
    return reply.code(201).send({ property: created });
  });

  fastify.patch('/api/properties/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        inBudget: z.boolean().optional(),
        inNetWorth: z.boolean().optional(),
        mortgageAccountId: z.string().uuid().nullish(),
        stalenessIntervalDays: z.number().int().nullish(),
      })
      .parse(request.body);

    await prisma.$transaction((tx) => updateProperty(tx, id, body));
    return { ok: true };
  });

  done();
};
