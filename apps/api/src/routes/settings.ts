import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { listArchivedEntities } from '../domain/archive.js';
import {
  getBudgetSettings,
  updateBudgetSettings,
  type BudgetSettings,
} from '../domain/settings.js';
import { centsIn, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Settings → Budget.
 *
 * Two values with real consequences: the tolerance decides when the Budget page
 * banner stops saying "Balanced", and the undo window decides how long a
 * Delegate press can be taken back.
 */

const updateSchema = z.object({
  undoWindowHours: z.number().int().optional(),
  identityToleranceCents: centsIn.optional(),
  requireTotp: z.boolean().optional(),
});

function present(settings: BudgetSettings): Record<string, unknown> {
  return {
    undoWindowHours: settings.undoWindowHours,
    identityToleranceCents: centsOut(settings.identityToleranceCents),
    goLiveAt: dateOut(settings.goLiveAt),
    requireTotp: settings.requireTotp,
  };
}

export const settingsRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/settings', async () => present(await getBudgetSettings(prisma)));

  fastify.patch('/api/settings', async (request) => {
    const body = updateSchema.parse(request.body);
    const settings = await updateBudgetSettings(prisma, body);

    request.log.info({ actorId: request.currentUser?.id }, 'budget settings updated');
    return present(settings);
  });

  /**
   * Settings → Archived. Nothing is ever hard-deleted, so this is where an
   * archived account, delegation or grouping is found and brought back.
   */
  fastify.get('/api/archived', async () => {
    const archived = await listArchivedEntities(prisma);

    return {
      accounts: archived.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        archivedAt: dateOut(account.archivedAt),
      })),
      delegations: archived.delegations.map((delegation) => ({
        id: delegation.id,
        name: delegation.name,
        archivedAt: dateOut(delegation.archivedAt),
      })),
      groupings: archived.groupings.map((grouping) => ({
        id: grouping.id,
        name: grouping.name,
        section: grouping.section,
        archivedAt: dateOut(grouping.archivedAt),
      })),
    };
  });

  done();
};
