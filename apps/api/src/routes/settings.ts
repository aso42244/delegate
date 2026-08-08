import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { getBudgetSettings, updateBudgetSettings } from '../domain/settings.js';
import { centsIn, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Settings → Budget.
 *
 * Two values with real consequences: the tolerance decides when the Main Budget
 * banner stops saying "Balanced", and the undo window decides how long a
 * Delegate press can be taken back.
 */

const updateSchema = z.object({
  undoWindowHours: z.number().int().optional(),
  identityToleranceCents: centsIn.optional(),
});

export const settingsRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/settings', async () => {
    const settings = await getBudgetSettings(prisma);
    return {
      undoWindowHours: settings.undoWindowHours,
      identityToleranceCents: centsOut(settings.identityToleranceCents),
      goLiveAt: dateOut(settings.goLiveAt),
    };
  });

  fastify.patch('/api/settings', async (request) => {
    const body = updateSchema.parse(request.body);
    const settings = await updateBudgetSettings(prisma, body);

    request.log.info({ actorId: request.currentUser?.id }, 'budget settings updated');
    return {
      undoWindowHours: settings.undoWindowHours,
      identityToleranceCents: centsOut(settings.identityToleranceCents),
      goLiveAt: dateOut(settings.goLiveAt),
    };
  });

  done();
};
