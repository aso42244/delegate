import type { FastifyPluginCallback } from 'fastify';
import { listBackups } from '../domain/backup.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * What is in the backup directory.
 *
 * Read from the disk on every request rather than from a table. A row recording
 * that a backup succeeded is a second thing that can be right while the file is
 * missing, and the file is the only one of the two that restores.
 */
export const backupRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/backups', async () => {
    const files = await listBackups(fastify.config.BACKUP_DIR);
    const complete = files.filter((file) => file.hasChecksum);

    return {
      // Shown so somebody chasing a missing dump knows which path to look at,
      // and because it is configuration rather than a secret.
      directory: fastify.config.BACKUP_DIR,
      // The same directory as the host names it, when compose passed it through.
      // Null rather than a guess: a wrong path sends somebody looking in a place
      // that does not exist, which is worse than the container's own answer.
      hostDirectory: fastify.config.BACKUP_HOST_DIR || null,

      // The schedule as configured, so the interface describes this deployment
      // rather than the defaults. The card used to assert "nightly at 02:30 UTC,
      // kept for 30 days" whatever these were set to — a smaller version of
      // exactly the problem this endpoint exists to solve, which is an interface
      // stating something nothing checks.
      cron: fastify.config.BACKUP_CRON,
      timezone: fastify.config.SCHEDULE_TIMEZONE,
      retentionDays: fastify.config.BACKUP_RETENTION_DAYS,

      count: complete.length,
      newestAt: complete[0]?.writtenAt.toISOString() ?? null,
      recent: files.slice(0, 5).map((file) => ({
        name: file.name,
        bytes: file.bytes,
        writtenAt: file.writtenAt.toISOString(),
        hasChecksum: file.hasChecksum,
      })),
    };
  });

  done();
};
