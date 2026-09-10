import type { ReactNode } from 'react';

/**
 * The one small mark: chip, tag and alert pill are all this.
 *
 * There were four of them, and they had drifted into four different objects
 * saying the same kind of thing. The letter chips beside a row were 11px at a
 * 4px radius; the bill states were 10px fully rounded; the Asset/Debt tags were
 * 11px at 4px; and the alert pills in the page header were 13px at 8px with a
 * 1px border nothing else had. Three radii, three sizes, two colour recipes.
 *
 * One construction now — **soft fill, tinted text, no border, fully rounded** —
 * and the only thing that varies is the size. The border is what mattered most:
 * it was the single thing that made the alerts read as a different species, and
 * without it colour does the work here the way it does everywhere else.
 *
 * Colour is never the only carrier. Every one of these paints words, or a letter
 * with its meaning alongside it, and that is a rule rather than a habit —
 * design.md §9.
 */

export type TagTone = 'quiet' | 'info' | 'positive' | 'confirm' | 'warning' | 'danger' | 'negative';

/**
 * Soft tint behind, the same hue in front.
 *
 * `quiet` is the absence of a claim rather than a colour: a fact about a row,
 * not something to do about it.
 */
const TONES: Record<TagTone, string> = {
  quiet: 'bg-surface-2 text-muted',
  info: 'bg-accent-soft text-accent',
  positive: 'bg-positive-soft text-positive',
  // Purple: worked out, not yet acted on, waiting on a person.
  confirm: 'bg-confirm-soft text-confirm',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  negative: 'bg-negative-soft text-negative',
};

/**
 * Two sizes and no more.
 *
 * `sm` sits inside a data row, where it is competing with the figures for the
 * row's width. `md` stands on its own in the sidebar, where it is the thing
 * being read rather than an annotation on something else.
 *
 * The line-height is set rather than inherited, because these sit inside rows
 * whose own line-height varies and a tag that changes height by context is the
 * drift this file exists to end.
 */
const SIZES = {
  sm: 'px-[6px] text-label leading-[18px]',
  md: 'px-2 text-quiet leading-[20px]',
} as const;

export type TagSize = keyof typeof SIZES;

/**
 * The face, for the two places that need to put it on something other than a
 * `<span>` — a link, or a focusable reading with a description attached.
 */
export function tagFace(tone: TagTone, size: TagSize = 'sm'): string {
  return `inline-flex max-w-full shrink-0 items-center rounded-full font-semibold ${SIZES[size]} ${TONES[tone]}`;
}

export function Tag({
  tone = 'quiet',
  size = 'sm',
  title,
  children,
}: {
  readonly tone?: TagTone;
  readonly size?: TagSize;
  /** The whole of it, where the face is an abbreviation of something longer. */
  readonly title?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span className={tagFace(tone, size)} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}
