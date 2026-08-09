import type { Cents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { clearAllocations } from './allocations.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Pairing the two halves of a transfer between accounts.
 *
 * A credit card payment and a mortgage payment each produce two transactions —
 * money leaving one owned account and arriving at another — and neither is
 * spending. Left alone they inflate every spending figure by the amount moved,
 * and at a mortgage payment's size that is the difference between a useful
 * Insights page and a misleading one.
 *
 * **Suggested, never applied.** §7 is explicit that wrong automatic pairing is
 * worse than no pairing, and it is right: two $500 movements in one week are
 * genuinely ambiguous, and a machine guessing wrong would silently erase a real
 * expense. The heuristic proposes; the owner confirms.
 */

/** §7's rule, exactly: opposite signs, matching amount, owned accounts, 5 days. */
export const PAIRING_WINDOW_DAYS = 5;

export interface PairCandidate {
  readonly outflow: PairSide;
  readonly inflow: PairSide;
  /** Whole days between the two, for the UI to show how close a match it is. */
  readonly daysApart: number;
}

export interface PairSide {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly postedAt: Date;
  readonly amountCents: Cents;
  readonly description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Finds candidate pairs among transactions that are not already paired.
 *
 * Amount matching is exact on the magnitude. A near-match is not offered at all:
 * a payment of $500.00 against a credit of $499.50 is either two unrelated
 * movements or a fee, and both readings need a human. Guessing between them is
 * how a real expense disappears.
 */
export async function findPairCandidates(
  db: Db,
  now: Date = new Date(),
  windowDays = 90,
): Promise<PairCandidate[]> {
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      pairedTransactionId: null,
      // A row already confirmed as a transfer needs no suggestion, and income is
      // money arriving from outside rather than moving between owned accounts.
      kind: 'normal',
      pending: false,
      postedAt: { gte: since },
    },
    select: {
      id: true,
      accountId: true,
      postedAt: true,
      amountCents: true,
      description: true,
      account: { select: { name: true } },
    },
    orderBy: { postedAt: 'asc' },
  });

  const outflows = transactions.filter((row) => row.amountCents < 0n);
  const inflows = transactions.filter((row) => row.amountCents > 0n);

  const candidates: PairCandidate[] = [];
  const claimed = new Set<string>();

  for (const outflow of outflows) {
    const match = inflows.find(
      (inflow) =>
        !claimed.has(inflow.id) &&
        // Both accounts are owned by definition — everything here is ours.
        inflow.accountId !== outflow.accountId &&
        inflow.amountCents === -outflow.amountCents &&
        Math.abs(inflow.postedAt.getTime() - outflow.postedAt.getTime()) <=
          PAIRING_WINDOW_DAYS * DAY_MS,
    );
    if (!match) continue;

    // One suggestion per transaction. Offering the same inflow against three
    // outflows would ask the owner to resolve an ambiguity the list created.
    claimed.add(match.id);
    claimed.add(outflow.id);

    candidates.push({
      outflow: side(outflow),
      inflow: side(match),
      daysApart: Math.round(
        Math.abs(match.postedAt.getTime() - outflow.postedAt.getTime()) / DAY_MS,
      ),
    });
  }

  return candidates;
}

function side(row: {
  id: string;
  accountId: string;
  postedAt: Date;
  amountCents: Cents;
  description: string;
  account: { name: string };
}): PairSide {
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.account.name,
    postedAt: row.postedAt,
    amountCents: row.amountCents,
    description: row.description,
  };
}

/**
 * Confirms a pair.
 *
 * Both rows become `kind = 'transfer'` and point at each other, which excludes
 * them from every spending figure. Any categorization they carried is cleared
 * first: a transfer allocates to nothing, and leaving an allocation behind would
 * keep a delegation moved by money that never left the household.
 */
export async function confirmPair(db: Db, firstId: string, secondId: string): Promise<void> {
  if (firstId === secondId) {
    throw new ValidationError('pair_same_transaction', 'A transaction cannot pair with itself.');
  }

  const [first, second] = await Promise.all([
    db.transaction.findUnique({
      where: { id: firstId },
      select: {
        id: true,
        accountId: true,
        amountCents: true,
        archivedAt: true,
        pairedTransactionId: true,
      },
    }),
    db.transaction.findUnique({
      where: { id: secondId },
      select: {
        id: true,
        accountId: true,
        amountCents: true,
        archivedAt: true,
        pairedTransactionId: true,
      },
    }),
  ]);

  if (!first) throw new NotFoundError('Transaction', firstId);
  if (!second) throw new NotFoundError('Transaction', secondId);
  if (first.archivedAt || second.archivedAt) {
    throw new ConflictError('pair_archived', 'An archived transaction cannot be paired.');
  }
  if (first.pairedTransactionId || second.pairedTransactionId) {
    throw new ConflictError(
      'already_paired',
      'One of those is already paired with something else.',
    );
  }
  if (first.accountId === second.accountId) {
    throw new ConflictError(
      'pair_same_account',
      'A transfer moves between two accounts; both of these are on the same one.',
    );
  }
  if (first.amountCents !== -second.amountCents) {
    // Not a judgement call: a pair that does not net to zero is not a transfer,
    // and treating it as one would remove real spending from the figures.
    throw new ConflictError(
      'pair_amounts_do_not_offset',
      'A pair must be equal and opposite. These do not offset.',
    );
  }

  // Clearing first: a transfer allocates to nothing, and a stale allocation
  // would leave a delegation moved by money that never left the household.
  await clearAllocations(db, firstId);
  await clearAllocations(db, secondId);

  await db.transaction.update({
    where: { id: firstId },
    data: { kind: 'transfer', pairedTransactionId: secondId },
  });
  await db.transaction.update({
    where: { id: secondId },
    data: { kind: 'transfer', pairedTransactionId: firstId },
  });
}

/**
 * Unpairs. Both rows go back to `normal` and uncategorized.
 *
 * Deliberately not restoring whatever categorization they had before pairing:
 * that is history the allocation rows no longer hold, and inventing one would be
 * worse than leaving two rows in the queue where the owner can see them.
 */
export async function unpair(db: Db, transactionId: string): Promise<void> {
  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    select: { id: true, pairedTransactionId: true },
  });
  if (!transaction) throw new NotFoundError('Transaction', transactionId);
  if (!transaction.pairedTransactionId) {
    throw new ConflictError('not_paired', 'That transaction is not paired with anything.');
  }

  const partnerId = transaction.pairedTransactionId;

  await db.transaction.update({
    where: { id: transactionId },
    data: { kind: 'normal', pairedTransactionId: null },
  });
  await db.transaction.update({
    where: { id: partnerId },
    data: { kind: 'normal', pairedTransactionId: null },
  });
}
