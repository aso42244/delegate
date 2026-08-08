import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The account list.
 *
 * The Main Budget's read model carries only in-budget accounts, because that is
 * what the identity is made of. Entering a transaction by hand needs the whole
 * live set: a mortgage payment lands on an account that is deliberately
 * off-budget, and leaving it unpickable would mean the register for it could
 * never be corrected.
 */

const listQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
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
        archivedAt: true,
      },
      // Alphabetical is the only order this system has.
      orderBy: { name: 'asc' },
    });

    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        source: account.source,
        balanceCents: centsOut(account.balanceCents),
        inBudget: account.inBudget,
        inNetWorth: account.inNetWorth,
        needsReview: account.needsReview,
        balanceAsOf: dateOut(account.balanceAsOf),
        stalenessIntervalDays: account.stalenessIntervalDays,
        groupingId: account.groupingId,
        archivedAt: dateOut(account.archivedAt),
      })),
    };
  });

  done();
};
