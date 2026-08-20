import { CYCLES_PER_YEAR, PAY_CADENCES } from '@budget/shared';
import { readFileSync } from 'node:fs';
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
import { AUTHENTICATED, requireSettingsManagement } from '../plugins/auth.js';

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
  payCadence: z.enum(PAY_CADENCES).optional(),
  requireTotp: z.boolean().optional(),
  remoteOverTorEnabled: z.boolean().optional(),
});

function present(settings: BudgetSettings): Record<string, unknown> {
  return {
    undoWindowHours: settings.undoWindowHours,
    identityToleranceCents: centsOut(settings.identityToleranceCents),
    goLiveAt: dateOut(settings.goLiveAt),
    payCadence: settings.payCadence,
    // The divisor the Utilities page uses, resolved here so the interface never
    // has to keep its own copy of the mapping.
    cyclesPerYear: CYCLES_PER_YEAR[settings.payCadence],
    requireTotp: settings.requireTotp,
    remoteOverTorEnabled: settings.remoteOverTorEnabled,
    remoteOverTorEnabledAt: dateOut(settings.remoteOverTorEnabledAt),
    // The address itself, when the onion service has been started. Read from
    // the file Tor writes; absent means nobody has started it.
    onionAddress: readOnionAddress(),
  };
}

/**
 * The onion address, if there is one.
 *
 * Tor writes it to a `hostname` file when it first creates the service. Read on
 * every request rather than cached at boot: the service can be started long
 * after the application, and an operator who has just started it should not have
 * to restart Delegate to see the address.
 *
 * A missing file is the ordinary state — it means the Tor service has not been
 * started, which is the default.
 */
function readOnionAddress(): string | null {
  try {
    return readFileSync('/tor/delegate/hostname', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const settingsRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/settings', async () => present(await getBudgetSettings(prisma)));

  /**
   * Reading is for everyone; changing is not.
   *
   * These are not cosmetic preferences. `requireTotp` decides whether two-factor
   * is demanded of the whole household, and `remoteOverTorEnabled` decides
   * whether the budget answers anything arriving from outside the house. An
   * ordinary account able to switch either off would make every other protection
   * worth what the weakest session is worth.
   */
  fastify.patch('/api/settings', { preHandler: [requireSettingsManagement] }, async (request) => {
    const body = updateSchema.parse(request.body);
    const before = await getBudgetSettings(prisma);
    const settings = await updateBudgetSettings(prisma, body);

    // Old and new, for the two that decide who gets in. A log line saying only
    // "settings updated" cannot answer the question anybody would ask later.
    request.log.info(
      {
        actorId: request.currentUser?.id,
        ...(body.requireTotp === undefined
          ? {}
          : { requireTotp: { from: before.requireTotp, to: settings.requireTotp } }),
        ...(body.remoteOverTorEnabled === undefined
          ? {}
          : {
              remoteOverTorEnabled: {
                from: before.remoteOverTorEnabled,
                to: settings.remoteOverTorEnabled,
              },
            }),
      },
      'budget settings updated',
    );
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
