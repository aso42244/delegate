import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { ConflictError } from '../domain/errors.js';
import { runSync } from '../domain/sync.js';
import { AUTHENTICATED } from '../plugins/auth.js';
import { HttpSimpleFinClient } from '../simplefin/client.js';

/**
 * Sync status and the manual sync button.
 *
 * The access URL is a bearer credential for the household's bank data. It is
 * read from configuration here and never returned by any route — `configured`
 * says whether one is set, and nothing more.
 */

interface SyncRunView {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly accountsTouched: number;
  readonly transactionsAdded: number;
  readonly transactionsUpdated: number;
  readonly transactionsReversed: number;
  readonly error: string | null;
}

export const syncRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /**
   * Drives the persistent failure banner: the most recent run, plus whether the
   * last one failed, so the UI does not have to interpret run history itself.
   */
  fastify.get('/api/sync/status', async () => {
    const runs = await prisma.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    const [latest] = runs;
    const lastSuccess = runs.find((run) => run.status === 'succeeded');

    return {
      configured: fastify.config.SIMPLEFIN_ACCESS_URL.length > 0,
      syncing: latest?.status === 'running',
      lastSyncAt: lastSuccess?.finishedAt?.toISOString() ?? null,
      // The banner shows while the most recent run is a failure, and clears as
      // soon as a later run succeeds.
      failing: latest?.status === 'failed',
      runs: runs.map((run): SyncRunView => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        accountsTouched: run.accountsTouched,
        transactionsAdded: run.transactionsAdded,
        transactionsUpdated: run.transactionsUpdated,
        transactionsReversed: run.transactionsReversed,
        error: run.error,
      })),
    };
  });

  fastify.post('/api/sync', async (request) => {
    const config = fastify.config;

    if (!config.SIMPLEFIN_ACCESS_URL) {
      throw new ConflictError(
        'simplefin_not_configured',
        'No SimpleFIN access URL is configured. Claim a setup token and put the result in SIMPLEFIN_ACCESS_URL.',
      );
    }

    const summary = await runSync(prisma, {
      client: new HttpSimpleFinClient({ accessUrl: config.SIMPLEFIN_ACCESS_URL }),
      backfillMonths: config.SIMPLEFIN_BACKFILL_MONTHS,
      logger: request.log,
      actorId: request.currentUser?.id ?? null,
    });

    return summary;
  });

  done();
};
