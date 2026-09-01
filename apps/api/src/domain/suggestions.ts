import { merchantKey } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * What the queue already knows.
 *
 * Rules are written by hand, so a merchant only stops arriving in the queue once
 * somebody sits down and writes one. Until then the same decision is made over
 * and over — and every one of those decisions is already recorded, as an
 * allocation against a transaction whose description is right there.
 *
 * This reads them back. For an uncategorized row it answers "where did this
 * merchant go the last few times", with the count that makes the answer
 * checkable: `Grocery · 14 of 15`. It suggests and nothing more — nothing here
 * writes, exactly as the pair suggestions do, because a wrong automatic
 * categorization moves an envelope balance and is worth more to undo than a
 * suggestion is to make.
 *
 * What counts as one merchant lives in `@budget/shared`, with the function that
 * turns a description into a rule's match text: the suggestion you accept is the
 * rule you would create, so both sides read the same normalization.
 */

/**
 * How far back the evidence is read.
 *
 * Deliberately a cap rather than everything: this runs whenever the register is
 * opened, and a household's register grows for ever. Recent history is also
 * better evidence than old history — where a merchant went last year matters
 * less than where it went last month.
 */
const HISTORY_LIMIT = 5000;

/**
 * How many rows of the queue are answered at once.
 *
 * The queue is bounded by how fast somebody works through it, so in practice
 * this is never reached. If it ever is, the rows past it simply carry no
 * suggestion and gain one as the queue shrinks — advice that is absent is the
 * right failure for advice.
 */
const BACKLOG_LIMIT = 1000;

/**
 * The evidence a suggestion needs before it is offered.
 *
 * Two, and a majority of them. One prior categorization is as often a
 * coincidence as a pattern, and a merchant split evenly between two envelopes
 * has no answer to give — offering either would be inventing one.
 */
const MIN_EVIDENCE = 2;

export interface DelegationSuggestion {
  readonly transactionId: string;
  readonly delegationId: string;
  readonly delegationName: string;
  /** How many of this merchant's categorized transactions went to that delegation. */
  readonly matchCount: number;
  /** How many it has in total. Both, so `14 of 15` can be shown rather than asserted. */
  readonly totalCount: number;
}

/**
 * The raw text where there is one.
 *
 * Feeds reword a description between the pending and the posted version of one
 * purchase, and the raw text is the half that stays still — which is also what
 * `createRuleFromTransaction` matches on. Grouping on anything else would mean
 * the suggestion and the rule it turns into disagreed about what a merchant is.
 */
function subject(row: { descriptionRaw: string; description: string }): string {
  return row.descriptionRaw || row.description;
}

/**
 * Suggests a delegation for every uncategorized transaction that has enough
 * history behind it.
 *
 * Two queries and a tally in memory rather than a query per row: the register is
 * one table and the backlog is most of a page of it, so a per-row lookup would
 * be fifty round trips to answer one screen.
 */
export async function suggestDelegations(db: Db): Promise<DelegationSuggestion[]> {
  const backlog = await db.transaction.findMany({
    where: { archivedAt: null, kind: 'normal', allocations: { none: {} } },
    select: { id: true, description: true, descriptionRaw: true },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    take: BACKLOG_LIMIT,
  });
  if (backlog.length === 0) return [];

  const history = await db.transaction.findMany({
    where: {
      archivedAt: null,
      kind: 'normal',
      allocations: {
        // A live envelope only. An archived delegation still resolves for
        // history, but suggesting one would offer a category that no longer
        // exists; a check is settled by matching rather than categorized.
        some: { delegation: { archivedAt: null, kind: 'envelope' } },
      },
    },
    select: {
      description: true,
      descriptionRaw: true,
      allocations: { select: { delegationId: true, delegation: { select: { name: true } } } },
    },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_LIMIT,
  });

  /** key → delegationId → how many times. */
  const tallies = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();

  for (const row of history) {
    // A split is a decision about one transaction rather than about a merchant:
    // it says this charge was two things, which is not a fact the next charge
    // from the same shop inherits.
    const allocation = row.allocations.length === 1 ? row.allocations[0] : undefined;
    if (!allocation) continue;

    const key = merchantKey(subject(row));
    const tally = tallies.get(key) ?? new Map<string, number>();
    tally.set(allocation.delegationId, (tally.get(allocation.delegationId) ?? 0) + 1);
    tallies.set(key, tally);
    names.set(allocation.delegationId, allocation.delegation.name);
  }

  const suggestions: DelegationSuggestion[] = [];

  for (const row of backlog) {
    const tally = tallies.get(merchantKey(subject(row)));
    if (!tally) continue;

    let bestId: string | null = null;
    let bestCount = 0;
    let total = 0;
    for (const [delegationId, count] of tally) {
      total += count;
      if (count > bestCount) {
        bestId = delegationId;
        bestCount = count;
      }
    }

    const name = bestId === null ? undefined : names.get(bestId);
    if (bestId === null || name === undefined) continue;
    // A majority, not a plurality. A merchant that goes three ways is a merchant
    // with no answer, and the third-largest share of it is not one.
    if (total < MIN_EVIDENCE || bestCount * 2 <= total) continue;

    suggestions.push({
      transactionId: row.id,
      delegationId: bestId,
      delegationName: name,
      matchCount: bestCount,
      totalCount: total,
    });
  }

  return suggestions;
}
