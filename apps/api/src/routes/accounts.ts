import { ACCOUNT_TYPES } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  archiveAccount,
  createManualAccount,
  restoreAccount,
  updateAccount,
} from '../domain/accounts.js';
import { centsInLoose, centsOut, dateOut } from '../http/serialize.js';
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

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(ACCOUNT_TYPES),
  balanceCents: centsInLoose,
  inBudget: z.boolean().optional(),
  inNetWorth: z.boolean().optional(),
  stalenessIntervalDays: z.number().int().nullish(),
  groupingId: z.string().uuid().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  inBudget: z.boolean().optional(),
  inNetWorth: z.boolean().optional(),
  stalenessIntervalDays: z.number().int().nullish(),
  groupingId: z.string().uuid().nullish(),
  needsReview: z.boolean().optional(),
  balanceCents: centsInLoose.optional(),
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

  done();
};
