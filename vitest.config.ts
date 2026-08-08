import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately separated:
 *
 * - `unit` is pure and needs no services. It runs on every commit and in
 *   watch mode.
 * - `integration` talks to a real PostgreSQL instance. The money math and the
 *   budget identity are only meaningfully verified against real BIGINT columns
 *   and real transactions, so these are not mocked. They run serially: each
 *   test truncates shared tables.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/tests/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['apps/api/tests/setup.ts'],
          // One worker for the whole project, so the files run one after another.
          // They share a database and each truncates it, so anything concurrent
          // deletes another file's fixtures mid-test. `fileParallelism` does not
          // work here — it is a root-level option and is ignored inside a
          // project, which is exactly the trap this replaces.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
