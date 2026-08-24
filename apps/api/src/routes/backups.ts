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
