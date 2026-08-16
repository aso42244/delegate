/**
 * `recompute-balances` — rebuilds every cached delegation balance from the event
 * ledger.
 *
 * The cache exists so the Budget page can render without aggregating the whole
 * event table on every view. The events are the truth. If the two ever disagree,
 * this command makes the cache match the events and prints what it changed; a
 * disagreement is a bug worth investigating, so it reports rather than fixing
 * silently.
 *
 * Pass --check to report without writing, which is what CI uses.
 */

import { formatCents } from '@budget/shared';
import { prisma } from '../db/client.js';
import { recomputeAllBalances } from '../domain/ledger.js';

async function main(): Promise<number> {
  const checkOnly = process.argv.includes('--check');

  const result = await prisma
    .$transaction(async (tx) => {
      const outcome = await recomputeAllBalances(tx);
      if (checkOnly && outcome.corrected > 0) {
        // Roll back so --check is genuinely read-only.
        throw new DryRunRollback(outcome);
      }
      return outcome;
    })
    .catch((error: unknown) => {
      if (error instanceof DryRunRollback) return error.result;
      throw error;
    });

  console.log(`Checked ${result.checked} delegation(s).`);

  if (result.corrected === 0) {
    console.log('Every cached balance already matched the event ledger.');
    return 0;
  }

  console.log(
    checkOnly
      ? `${result.corrected} cached balance(s) DISAGREE with the ledger:`
      : `Corrected ${result.corrected} cached balance(s):`,
  );
  for (const correction of result.corrections) {
    console.log(
      `  ${correction.name}: cached ${formatCents(correction.cachedCents)} → ledger ${formatCents(correction.actualCents)}`,
    );
  }

  // A mismatch is a real defect. Exit non-zero so CI and cron notice.
  return 1;
}

class DryRunRollback extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof recomputeAllBalances>>) {
    super('dry run');
  }
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
