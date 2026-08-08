import { PrismaClient } from '@prisma/client';

/**
 * A single PrismaClient for the process. Prisma holds a connection pool; a new
 * client per request would exhaust Postgres connections on the NAS quickly.
 */
export const prisma = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * The transactional client type. Every domain function takes this rather than
 * the global client, so callers decide the transaction boundary — the ledger
 * must be able to write an event and update the cached balance atomically.
 */
export type Db = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
