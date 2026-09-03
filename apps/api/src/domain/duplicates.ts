import { merchantKey, type Cents } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * The same charge, in the register twice.
 *
 * This is not hypothetical and it is not rare. Reconnecting an institution at
 * the bridge changes every account's external id, so a sync brings back
 * transactions that are already here as though they were new — the whole of a
 * card's recent history, at once. It is written down in `docs/handoff.md` as
 * something that happened, and the fix at the time was to archive rows by hand.
 *
 * **Nothing found this.** Archiving a duplicate has been possible from the row
 * menu since v0.29, but only for a duplicate somebody had already noticed —
 * which in practice means noticing that a balance is wrong and working
 * backwards. This reads them out.
 *
 * It **proposes and never acts**, which is the line this application draws
 * everywhere it guesses: a cleared check ([ADR 030]), a transfer pair (§7), a
 * suggested delegation ([ADR 044]). Archiving reverses envelope movements, and a
 * wrong guess about which of two identical rows is the copy is not a thing to
 * discover later.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far apart two copies of one charge may post.
 *
 * A re-import lands them on the same day, because the day comes from the feed
 * along with everything else. Two days of slack covers the case that actually
 * varies — a pending row that settled, and its re-imported twin arriving
 * against the settled date — without reaching far enough to sweep in a
 * subscription that genuinely bills twice a week.
 */
export const DUPLICATE_WINDOW_DAYS = 2;

/** How far back to look. As elsewhere: this runs on a page load, not nightly. */
const HISTORY_LIMIT = 5000;

export interface DuplicateCandidate {
  /** The one that was here first — by posting date, then by when it was created. */
  readonly original: DuplicateSide;
  /** The one that looks like a copy of it, and the one the button archives. */
  readonly copy: DuplicateSide;
  readonly daysApart: number;
  /**
   * True when the two came from the feed with different external ids, which is
   * the re-import signature rather than a coincidence.
   */
  readonly differentExternalIds: boolean;
}

export interface DuplicateSide {
  readonly id: string;
  readonly accountName: string;
  readonly postedAt: Date;
  readonly amountCents: Cents;
  readonly description: string;
  readonly categorized: boolean;
}

/**
 * Reads out charges that look like the same charge twice.
 *
 * The match is deliberately narrow: **same account, same amount to the cent,
 * within two days, and neither already archived**. Every loosening of that was
 * considered and refused —
 *
 * - **A near amount is not a duplicate.** $42.10 against $42.09 is a fee or two
 *   different purchases, and both readings need a person.
 * - **A different account is not a duplicate.** The same amount leaving two
 *   accounts on one day is what a transfer looks like, and there is already a
 *   pairing proposal for that. Offering to archive half of one would be wrong in
 *   a way that is expensive to undo.
 * - **A different merchant is not a duplicate.** This bullet used to say the
 *   opposite — that a feed rewords its own text between the pending and posted
 *   versions of a purchase, so descriptions need not match. The first real run
 *   showed what that costs: `ACH Payment Strike (Zap Solu` and `ACH Payment City
 *   of Sioux Fa`, both $60.00, two days apart, read as one charge twice. That is
 *   a household paying two bills in a week, which is not rare at all.
 *
 *   The reasoning was wrong in a specific way. A re-import — the case this
 *   exists for — replays the feed's own rows, so the descriptions come back
 *   **identical**. Nothing about that case needed the looseness, and the
 *   looseness is what produced a false positive that could never go away.
 *   `merchantKey` is the test, so a store number or a reference fragment still
 *   does not split one merchant in two.
 *
 * A pair that came back with different external ids is marked, because that is
 * the re-import signature: a genuine second identical charge on one day — two
 * coffees, the same card — carries one id from the feed and appears once.
 */
/**
 * One pair, in the order the table stores it.
 *
 * Sorted by id so that "A and B are not each other" and "B and A are not each
 * other" are the same row. The check constraint on the table enforces the same
 * thing, so a row written any other way is refused rather than duplicated.
 */
export function dismissalPair(
  first: string,
  second: string,
): { readonly firstTransactionId: string; readonly secondTransactionId: string } {
  const [low, high] = [first, second].sort();
  return { firstTransactionId: low!, secondTransactionId: high! };
}

/**
 * Records that two rows are not the same charge.
 *
 * An upsert, because pressing the button twice is a thing that happens and the
 * second press means the same as the first.
 */
export async function dismissDuplicate(
  db: Db,
  input: { readonly firstId: string; readonly secondId: string; readonly userId: string | null },
): Promise<void> {
  if (input.firstId === input.secondId) {
    throw new Error('A transaction cannot be dismissed against itself.');
  }

  const pair = dismissalPair(input.firstId, input.secondId);
  await db.duplicateDismissal.upsert({
    where: { firstTransactionId_secondTransactionId: pair },
    create: { ...pair, dismissedBy: input.userId },
    update: {},
  });
}

export async function findDuplicates(db: Db): Promise<DuplicateCandidate[]> {
  /*
   * Read first and held as a set of `a:b` keys. There are few of these by
   * construction — a household refuses a handful of proposals, not thousands —
   * and the alternative is a query per candidate pair inside the loop.
   */
  const dismissed = new Set(
    (
      await db.duplicateDismissal.findMany({
        select: { firstTransactionId: true, secondTransactionId: true },
      })
    ).map((row) => `${row.firstTransactionId}:${row.secondTransactionId}`),
  );

  const transactions = await db.transaction.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      accountId: true,
      postedAt: true,
      amountCents: true,
      description: true,
      externalId: true,
      createdAt: true,
      account: { select: { name: true, nickname: true } },
      _count: { select: { allocations: true } },
    },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_LIMIT,
  });

  /**
   * Account, amount and merchant together: everything else is a comparison
   * within a bucket.
   *
   * The merchant is part of the key rather than a filter inside the loop so that
   * two different payees at the same amount never meet — which is the false
   * positive this bucketing used to produce.
   */
  const buckets = new Map<string, typeof transactions>();
  for (const transaction of transactions) {
    const key = `${transaction.accountId}:${transaction.amountCents}:${merchantKey(transaction.description)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(transaction);
    buckets.set(key, bucket);
  }

  const found: DuplicateCandidate[] = [];
  const spent = new Set<string>();

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Oldest first, so the earlier row is the original and the later one is the
    // copy. `created_at` breaks a tie on the day, which is what a re-import
    // produces: the same posting date, imported months apart.
    const ordered = [...bucket].sort(
      (a, b) =>
        a.postedAt.getTime() - b.postedAt.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );

    for (const [index, original] of ordered.entries()) {
      if (spent.has(original.id)) continue;

      for (const copy of ordered.slice(index + 1)) {
        if (spent.has(copy.id)) continue;

        const days = Math.round(
          Math.abs(copy.postedAt.getTime() - original.postedAt.getTime()) / DAY_MS,
        );
        if (days > DUPLICATE_WINDOW_DAYS) continue;

        /*
         * Already refused. `continue` rather than `break`: this pair is settled,
         * and the row may still be a genuine copy of a third one further down.
         * Neither id is spent, so both stay eligible.
         */
        const pair = dismissalPair(original.id, copy.id);
        if (dismissed.has(`${pair.firstTransactionId}:${pair.secondTransactionId}`)) continue;

        /*
         * Each row is named once. Three copies of one charge are two proposals
         * — the first against the second, the second against the third — rather
         * than three, because confirming one changes what the others mean.
         */
        spent.add(original.id);
        spent.add(copy.id);

        found.push({
          original: side(original),
          copy: side(copy),
          daysApart: days,
          differentExternalIds:
            original.externalId !== null &&
            copy.externalId !== null &&
            original.externalId !== copy.externalId,
        });
        break;
      }
    }
  }

  // Newest first: a re-import is noticed by what has just appeared.
  return found.sort((a, b) => b.copy.postedAt.getTime() - a.copy.postedAt.getTime());
}

/** Only the fields `side` reads, spelled out rather than derived from a query. */
interface RegisterRow {
  readonly id: string;
  readonly postedAt: Date;
  readonly amountCents: bigint;
  readonly description: string;
  readonly account: { readonly name: string; readonly nickname: string | null };
  readonly _count: { readonly allocations: number };
}

function side(row: RegisterRow): DuplicateSide {
  return {
    id: row.id,
    // The short name where one exists, as everywhere else a row names its
    // account: a full bank name is the thing that pushes a register row wide.
    accountName: row.account.nickname ?? row.account.name,
    postedAt: row.postedAt,
    amountCents: row.amountCents,
    description: row.description,
    // Shown, because archiving the categorized one puts money back in an
    // envelope and archiving the other does not. The reader should be told
    // which of two identical rows is the one carrying a decision.
    categorized: row._count.allocations > 0,
  };
}
