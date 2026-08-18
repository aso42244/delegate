/**
 * `recompute-balances` — rebuilds every cached balance from its event ledger.
 *
 * Two caches, two ledgers, one command: delegation balances against
 * `delegation_events`, and Bitcoin quantities against
 * `bitcoin_holding_events`. Both exist for the same reason and both are checked
 * the same way, so there is no second thing to remember to run.
 *
 * The cache exists so the Budget page can render without aggregating the whole
 * event table on every view. The events are the truth. If the two ever disagree,
 * this command makes the cache match the events and prints what it changed; a
 * disagreement is a bug worth investigating, so it reports rather than fixing
 * silently.
 *
 * Pass --check to report without writing, which is what CI uses.
 */

import { formatBitcoin, formatCents } from '@budget/shared';
import { prisma } from '../db/client.js';
import { recomputeHoldings } from '../domain/bitcoin-holdings.js';
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

  const holdings = await prisma
    .$transaction(async (tx) => {
      const outcome = await recomputeHoldings(tx, { check: checkOnly });
      if (checkOnly && outcome.drifted.length > 0) throw new HoldingDryRunRollback(outcome);
      return outcome;
    })
    .catch((error: unknown) => {
      if (error instanceof HoldingDryRunRollback) return error.result;
      throw error;
    });

  console.log(`Checked ${result.checked} delegation(s) and ${holdings.checked} holding(s).`);

  if (holdings.drifted.length > 0) {
    console.log(
      checkOnly
        ? `${holdings.drifted.length} cached Bitcoin quantit(ies) DISAGREE with the ledger:`
        : `Corrected ${holdings.drifted.length} cached Bitcoin quantit(ies):`,
    );
    for (const drift of holdings.drifted) {
      console.log(
        `  ${drift.accountId}: cached ${formatBitcoin(drift.cached)} → ledger ${formatBitcoin(drift.actual)}`,
      );
    }
  }

  if (result.corrected === 0 && holdings.drifted.length === 0) {
    console.log('Every cached balance already matched its event ledger.');
    return 0;
  }

  if (result.corrected === 0) return 1;

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

class HoldingDryRunRollback extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof recomputeHoldings>>) {
    super('dry run');
  }
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
