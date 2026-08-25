import { CYCLES_PER_YEAR, PAY_CADENCES } from '@budget/shared';
import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger, FastifyPluginCallback } from 'fastify';
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

const updateSchema = z
  .object({
    undoWindowHours: z.number().int().optional(),
    identityToleranceCents: centsIn.optional(),
    payCadence: z.enum(PAY_CADENCES).optional(),
    remoteOverTorEnabled: z.boolean().optional(),
  })
  /*
   * Unknown fields are refused rather than stripped, which is zod's default.
   *
   * `requireTotp` used to live here. Once it was removed, a PATCH still
   * carrying it answered 200 with the field quietly discarded — a request that
   * looks to the caller like it turned two-factor off for the household, and a
   * success. Refusing is the only honest answer.
   */
  .strict();

function present(settings: BudgetSettings, logger: FastifyBaseLogger): Record<string, unknown> {
  return {
    undoWindowHours: settings.undoWindowHours,
    identityToleranceCents: centsOut(settings.identityToleranceCents),
    goLiveAt: dateOut(settings.goLiveAt),
    payCadence: settings.payCadence,
    // The divisor the Utilities page uses, resolved here so the interface never
    // has to keep its own copy of the mapping.
    cyclesPerYear: CYCLES_PER_YEAR[settings.payCadence],
    remoteOverTorEnabled: settings.remoteOverTorEnabled,
    remoteOverTorEnabledAt: dateOut(settings.remoteOverTorEnabledAt),
    // The address itself, when the onion service has been started. Read from
    // the file Tor writes; absent means nobody has started it.
    onionAddress: readOnionAddress(logger),
  };
}

/**
 * The onion address, if there is one.
 *
 * The tor entrypoint republishes it here once the hidden service exists. Read on
 * every request rather than cached at boot: the service can be started long
 * after the application, and an operator who has just started it should not have
 * to restart Delegate to see the address.
 *
 * `/tor/hostname`, not the key directory. That directory is 0700 and owned by
 * tor — necessarily, since the private key is in it — and this process is a
 * different unprivileged user, so reading from it failed with EACCES on every
 * request. Silently, because the catch below returned null and null is also what
 * "no service yet" looks like.
 *
 * Which is why only a missing file is quiet now. Anything else is a
 * misconfiguration, and it says so rather than presenting itself as the ordinary
 * state.
 */
function readOnionAddress(logger: FastifyBaseLogger): string | null {
  try {
    return readFileSync('/tor/hostname', 'utf8').trim() || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The ordinary state: Tor has not created the service, which is the default.
    if (code === 'ENOENT') return null;

    logger.error({ err: error, code }, 'could not read the onion address');
    return null;
  }
}

export const settingsRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/settings', async (request) =>
    present(await getBudgetSettings(prisma), request.log),
  );

  /**
   * Reading is for everyone; changing is not.
   *
   * These are not cosmetic preferences. `remoteOverTorEnabled` decides whether
   * the budget answers anything arriving from outside the house, and an
   * ordinary account able to switch that on would make every other protection
   * worth what the weakest session is worth.
   */
  fastify.patch('/api/settings', { preHandler: [requireSettingsManagement] }, async (request) => {
    const body = updateSchema.parse(request.body);
    const before = await getBudgetSettings(prisma);
    const settings = await updateBudgetSettings(prisma, body);

    // Old and new for the one that decides who gets in. A log line saying only
    // "settings updated" cannot answer the question anybody would ask later.
    request.log.info(
      {
        actorId: request.currentUser?.id,
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
    return present(settings, request.log);
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
