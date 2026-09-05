/**
 * What the two archive buttons on a duplicate proposal are called.
 *
 * Each rule names its own sides, because "first" and "later" are only
 * meaningful for one of them.
 *
 * A **re-import** is two rows the bank sent, arriving months apart after an
 * institution was reconnected. Which one is the copy is a judgement about time,
 * so the later is offered by default and the earlier is offered too — the row
 * carrying the categorization is sometimes the one worth keeping.
 *
 * A **standby** pair is one charge from two sources on the same day: what
 * somebody typed while the feed was behind, against the feed's own row now that
 * it has caught up. Ordering those by date says nothing. The copy is never in
 * doubt — it is the hand-entered one, whichever arrived first — and calling the
 * button "Archive the later one" described a rule the pair is not decided by.
 * It pressed correctly under the name of something else, which reads as right
 * until somebody relies on it.
 *
 * Here rather than inline in the component so the wording is one decision with
 * a test on it, the way `chips.ts` holds the chip vocabulary.
 */

export type DuplicateReason = 'reimport' | 'standby';

export interface DuplicateActionLabels {
  /** The primary button: archives `candidate.copy`. */
  readonly archiveCopy: string;
  /** The secondary button: archives `candidate.original`. */
  readonly archiveOriginal: string;
}

export function duplicateActionLabels(reason: DuplicateReason): DuplicateActionLabels {
  return reason === 'standby'
    ? { archiveCopy: 'Archive my copy', archiveOriginal: "Archive the bank's" }
    : { archiveCopy: 'Archive the later one', archiveOriginal: 'Archive the first' };
}

/**
 * The same choice for the accessible name, which carries the description too.
 *
 * A screen reader hears one of these on a page that may hold several proposals,
 * so the row it acts on has to be in the name rather than only on screen.
 */
export function duplicateActionAriaLabel(
  reason: DuplicateReason,
  side: 'copy' | 'original',
  description: string,
): string {
  if (reason === 'standby') {
    return side === 'copy'
      ? `Archive my copy of ${description}`
      : `Archive the bank's ${description}`;
  }
  return side === 'copy' ? `Archive the later ${description}` : `Archive the first ${description}`;
}
