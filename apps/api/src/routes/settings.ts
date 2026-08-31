import { CYCLES_PER_YEAR, isKnownTimeZone, knownTimeZones, PAY_CADENCES } from '@budget/shared';
import { readFileSync } from 'node:fs';
import type { FastifyBaseLogger, FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { listArchivedEntities } from '../domain/archive.js';
import {
  getBudgetSettings,
  resolveScheduleTimezone,
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
    /**
     * An IANA zone, or null to go back to following `SCHEDULE_TIMEZONE`.
     *
     * Checked here as well as in the domain so the refusal is a 400 with a
     * readable message rather than a zone the picker offered and the server
     * silently declined.
     */
    scheduleTimezone: z
      .string()
      .refine(isKnownTimeZone, {
        message:
          'Not an IANA time zone name. Abbreviations ("CST") and fixed offsets ("-05:00") are refused: neither observes daylight saving, so a job set for a civil hour would drift.',
      })
      .nullable()
      .optional(),
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

function present(
  settings: BudgetSettings,
  logger: FastifyBaseLogger,
  environmentTimezone: string,
): Record<string, unknown> {
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

    /**
     * Three fields rather than one, because the interface has three things to
     * say: what was chosen, what the environment would fall back to, and which
     * of them is actually in force.
     *
     * Resolving on the server so the page and the scheduler cannot disagree.
     * Settings → Sync asserted "nightly at 02:30 UTC" whatever the deployment
     * was configured with for months, and nothing checked it.
     */
    scheduleTimezone: settings.scheduleTimezone,
    environmentTimezone,
    effectiveTimezone: resolveScheduleTimezone(settings, environmentTimezone),
    // Offered here rather than assembled in the browser, so the picker cannot
    // offer a zone this server would refuse.
    availableTimezones: knownTimeZones(),

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
    present(await getBudgetSettings(prisma), request.log, fastify.config.SCHEDULE_TIMEZONE),
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

    /**
     * Rebuild the cron tasks when the zone moved.
     *
     * `node-cron` fixes a task's zone at creation, so without this the setting
     * would save, report itself saved, and change nothing until the next
     * restart. Compared rather than fired on every write: rebuilding the
     * schedules because somebody changed the undo window is work for nothing.
     */
    const timezoneMoved = before.scheduleTimezone !== settings.scheduleTimezone;
    if (timezoneMoved) {
      await fastify.schedules.reload();
    }

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
        // The zone decides when every job fires, including the one that stamps a
        // date onto stored history. Worth a line naming both ends.
        ...(timezoneMoved
          ? {
              scheduleTimezone: {
                from: before.scheduleTimezone,
                to: settings.scheduleTimezone,
                effective: resolveScheduleTimezone(settings, fastify.config.SCHEDULE_TIMEZONE),
              },
            }
          : {}),
      },
      'budget settings updated',
    );
    return present(settings, request.log, fastify.config.SCHEDULE_TIMEZONE);
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
