import type { ReactNode } from 'react';
import { CHIPS, type ChipKind } from './chips.js';
import { tagFace } from './Tag.js';

/**
 * One mark beside a row's name.
 *
 * The letter is for the eye; the meaning is carried alongside it for anyone who
 * cannot see the row, and as a `title` for anyone who hovers. Both come from
 * `chips.ts`, so a chip cannot be added without saying what it means.
 *
 * `aria-hidden` on the mark and `sr-only` on the words rather than an
 * `aria-label` on the wrapper: a bare `<span>` has no role, and an `aria-label`
 * on a roleless element is ignored by some screen readers. Real text that is
 * merely not painted always works.
 */

export function Chip({ kind }: { readonly kind: ChipKind }): ReactNode {
  const { mark, meaning, tone } = CHIPS[kind];

  return (
    <span
      title={meaning}
      // `min-w-5` and centred so a one-letter chip and `btc` read as the same
      // family rather than as a dot and a word — a single letter comes out as a
      // circle, which is what the shape is for.
      className={`${tagFace(tone, 'sm')} min-w-5 justify-center px-1`}
    >
      <span aria-hidden>{mark}</span>
      <span className="sr-only">{meaning}</span>
    </span>
  );
}

/** Several chips in a row, evenly spaced and never wrapping mid-group. */
export function Chips({ kinds }: { readonly kinds: readonly ChipKind[] }): ReactNode {
  if (kinds.length === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {kinds.map((kind) => (
        <Chip key={kind} kind={kind} />
      ))}
    </span>
  );
}
