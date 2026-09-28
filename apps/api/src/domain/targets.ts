import type { PayCadence, TargetProgress } from '@budget/shared';
import { targetProgress } from '@budget/shared';
import type { Db } from '../db/client.js';

/**
 * Targets, where they meet the database.
 *
 * The arithmetic itself is in `@budget/shared`, because the dialog that sets a
 * target shows the same reading live before anything is saved.
 */
/**
 * The lines that will not make their date at the amount they are set to.
 *
 * The one query this module makes, and it is here rather than in
 * `notifications.ts` so that the page and the pill cannot disagree about what
 * "behind" means — the Budget row's reading and this count come out of the same
 * function.
 */
export async function findBehindTargets(
  db: Db,
  today: Date,
  cadence: PayCadence,
): Promise<{ readonly name: string; readonly progress: TargetProgress }[]> {
  const rows = await db.delegation.findMany({
    // A check is not saving towards anything, and an archived line is history.
    where: { archivedAt: null, kind: 'envelope', targetCents: { not: null } },
    select: {
      name: true,
      balanceCents: true,
      amountToDelegateCents: true,
      targetCents: true,
      targetDate: true,
      targetIntervalMonths: true,
    },
    orderBy: { targetDate: 'asc' },
  });

  return rows
    .map((row) => ({ name: row.name, progress: targetProgress(row, cadence, today) }))
    .filter(
      (entry): entry is { name: string; progress: TargetProgress } =>
        entry.progress !== null && entry.progress.status === 'behind',
    );
}
