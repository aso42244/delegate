import { formatCents } from '@budget/shared';
import type { BudgetRowDto } from '../api/budget.js';

/**
 * A maximum, in words.
 *
 * One place, for the reason `target-text.ts` is one place: the same ceiling is
 * described on the Budget row's amount to delegate, in its row menu, and on
 * Settings → Delegations, and three phrasings of one fact is three things to
 * keep in step.
 *
 * **Nothing is computed here.** What the next press would move arrives with the
 * row, from the same function the run itself uses — so a sentence on a row
 * cannot promise a figure the ledger then disagrees with.
 *
 * Every sentence says where the withheld money goes, because that is the part
 * somebody would otherwise guess at: it goes nowhere. It stays undelegated,
 * which is the reading at the top of the page, and is therefore offered back
 * rather than quietly absorbed by another line.
 */

/** The whole sentence, for the figure the maximum acts on. */
export function describeMaximum(row: BudgetRowDto): string | null {
  const max = row.max;
  if (!max) return null;

  const ceiling = formatCents(BigInt(max.maxBalanceCents));

  switch (max.status) {
    case 'full':
      return `Maximum ${ceiling} — this line is full, so Delegate adds nothing and leaves ${formatCents(
        BigInt(max.withheldCents),
      )} available.`;
    case 'partial':
      return `Maximum ${ceiling} — Delegate adds ${formatCents(
        BigInt(max.delegatingCents),
      )} of this and leaves ${formatCents(BigInt(max.withheldCents))} available.`;
    case 'room':
      return `Maximum ${ceiling} — ${formatCents(BigInt(max.roomCents))} of room left, so the whole amount fits.`;
  }
}

/** The short form, for the one line a menu item's hint gets. */
export function summarizeMaximum(row: BudgetRowDto): string {
  const max = row.max;
  if (!max) return '';

  const ceiling = formatCents(BigInt(max.maxBalanceCents));

  switch (max.status) {
    case 'full':
      return `${ceiling} — full, so Delegate adds nothing.`;
    case 'partial':
      return `${ceiling} — only ${formatCents(BigInt(max.delegatingCents))} of the amount still fits.`;
    case 'room':
      return `${ceiling} — ${formatCents(BigInt(max.roomCents))} of room left.`;
  }
}
