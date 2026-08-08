/**
 * Integration test setup.
 *
 * These tests run against a real PostgreSQL database, not a mock. The whole point
 * is to verify BIGINT arithmetic, real transactions, check constraints and the
 * budget identity as the database will actually behave — a mocked Prisma client
 * would verify only that the test author's assumptions are self-consistent.
 */

import { config } from 'dotenv';
import { beforeAll } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests need a throwaway database — they truncate it.',
  );
}

// Point Prisma at the test database before any client is constructed. Guarding on
// the name as well: these tests truncate every table, and doing that to a
// development or production database would be unrecoverable.
if (!/_test(\?|$)/.test(testDatabaseUrl)) {
  throw new Error(
    `Refusing to run integration tests against "${testDatabaseUrl}" — the database name must end in _test.`,
  );
}
process.env['DATABASE_URL'] = testDatabaseUrl;

beforeAll(async () => {
  const { prisma } = await import('../src/db/client.js');
  // Fail fast with a clear message if the schema was never migrated.
  await prisma.$queryRaw`SELECT 1 FROM budget_settings LIMIT 1`.catch(() => {
    throw new Error(
      'The test database has no schema. Run: npm run db:deploy -- --schema apps/api/prisma/schema.prisma',
    );
  });
});
