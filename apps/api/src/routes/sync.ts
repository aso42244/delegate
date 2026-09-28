import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { ConflictError } from '../domain/errors.js';
import {
  connectWithAccessUrl,
  connectWithSetupToken,
  disconnect,
  resolveConnection,
} from '../domain/simplefin-config.js';
import { runSync } from '../domain/sync.js';
import { AUTHENTICATED, requireSettingsManagement } from '../plugins/auth.js';
import { HttpSimpleFinClient } from '../simplefin/client.js';

/**
 * Sync status and the manual sync button.
 *
 * The access URL is a bearer credential for the household's bank data. It is
 * read from configuration here and never returned by any route — `configured`
 * says whether one is set, and nothing more.
 *
 * **Connect and disconnect are administrator-only; syncing is not.** The line is
 * whether the route decides *where* this server sends a request, not whether it
 * makes one: connect stores a URL the hourly job will then fetch forever, and
 * disconnect silently ends the household's feed. Pressing Sync uses the
 * credential already stored and chooses nothing, so it stays what it looks like
 * — an ordinary act of refreshing your own budget.
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
    const connection = await resolveConnection(
      prisma,
      fastify.config.SIMPLEFIN_ACCESS_URL,
      fastify.config.dataKey,
    );
    const runs = await prisma.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    const [latest] = runs;
    const lastSuccess = runs.find((run) => run.status === 'succeeded');

    return {
      configured: connection.accessUrl !== null,
      // Where the credential came from, never what it is.
      credentialSource: connection.source,
      connectedAt: connection.connectedAt?.toISOString() ?? null,
      credentialProblem: connection.problem,
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
    const connection = await resolveConnection(prisma, config.SIMPLEFIN_ACCESS_URL, config.dataKey);

    if (!connection.accessUrl) {
      throw new ConflictError(
        'simplefin_not_configured',
        connection.problem ??
          'SimpleFIN is not connected. Connect it in Settings, or set SIMPLEFIN_ACCESS_URL.',
      );
    }

    const summary = await runSync(prisma, {
      client: new HttpSimpleFinClient({ accessUrl: connection.accessUrl }),
      backfillMonths: config.SIMPLEFIN_BACKFILL_MONTHS,
      logger: request.log,
      actorId: request.currentUser?.id ?? null,
    });

    return summary;
  });

  /**
   * Connect: either claim a one-time setup token, or store an access URL the
   * owner already holds. Both end up encrypted in the database.
   */
  fastify.post(
    '/api/sync/connect',
    { preHandler: [requireSettingsManagement] },
    async (request) => {
      const body = z
        .union([
          z.object({ setupToken: z.string().min(1).max(4000) }),
          z.object({ accessUrl: z.string().min(1).max(4000) }),
        ])
        .parse(request.body);

      const result =
        'setupToken' in body
          ? await connectWithSetupToken(prisma, body.setupToken, fastify.config.dataKey)
          : await connectWithAccessUrl(prisma, body.accessUrl, fastify.config.dataKey);

      // The credential itself is never logged, only that one was stored.
      request.log.info({ actorId: request.currentUser?.id }, 'SimpleFIN connected');
      return { connectedAt: result.connectedAt.toISOString() };
    },
  );

  fastify.post(
    '/api/sync/disconnect',
    { preHandler: [requireSettingsManagement] },
    async (request) => {
      await disconnect(prisma);
      request.log.info({ actorId: request.currentUser?.id }, 'SimpleFIN disconnected');
      return { ok: true };
    },
  );

  done();
};
