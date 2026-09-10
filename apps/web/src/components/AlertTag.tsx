import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { tagFace, type TagTone } from './Tag.js';

/**
 * Something the application needs to say about itself, as a tag.
 *
 * The budget's own reading — Balanced, To delegate, Over-delegated — was the
 * first of these, and the notifications became the rest. They were full-width
 * bars, then pills beside the page title, and they now sit at the foot of the
 * sidebar: a standing column of what is true, in the one place that is on every
 * screen and is not competing with the page's own heading.
 *
 * The face is `Tag`, the same object as every chip and state tag in the
 * application. It used to carry a 1px border that nothing else had, which was
 * the single thing making these read as a different species; colour carries it
 * now, as it does everywhere else. What is still particular to this one is the
 * *detail* — the whole sentence, one hover or one focus away.
 */

export type PillTone = Extract<TagTone, 'info' | 'positive' | 'confirm' | 'warning' | 'danger'>;

/**
 * How wide the detail is allowed to be.
 *
 * `w-96` from the field scale in `ui-system.md` §2 — the width that holds
 * prose. It replaces `w-max`, which let the detail be as wide as its longest
 * possible single line: the "6 not reporting" message names six accounts and
 * ran about 1,500px, straight off the right of the screen with most of the
 * sentence unreachable.
 *
 * **Deliberately tall rather than wide.** A detail is read once and dismissed
 * by moving the mouse, so wrapping costs nothing; running past the edge of the
 * screen costs the half of the sentence that was cut off.
 */
const DETAIL_WIDTH_PX = 384;

/** Breathing room at either edge, so the detail never sits flush against it. */
const DETAIL_MARGIN_PX = 16;

/**
 * Where the detail sits, so that it is always wholly on the screen.
 *
 * Anchoring it to the pill's left edge is right for every pill with room and
 * wrong for one near the right of the display — and a pill *can* be near the
 * right, because they sit in a wrapping row after the page title and after the
 * budget's own reading.
 *
 * Flipping to the other edge was tried and is not enough: on a phone the pill
 * itself is narrower than the detail, so hanging the detail from the pill's
 * right edge puts its left edge off the *left* of the screen — the same bug
 * mirrored. So this clamps rather than flips. The detail is placed at the
 * pill's left edge where that fits, and pushed back inside the margin where it
 * does not.
 *
 * Measured from the pill, never from the detail: the detail is `display: none`
 * until revealed and a hidden element has no box. The pill is always on screen
 * and the detail's width is known from the constant above, so the answer needs
 * only one of them.
 *
 * The offset is relative to the pill, so it stays correct as the page scrolls
 * vertically — an absolute `left` in the pill's own coordinate space rather
 * than a viewport position that would go stale.
 */
function useDetailOffset(): {
  ref: React.RefObject<HTMLSpanElement | null>;
  offsetPx: number;
} {
  const ref = useRef<HTMLSpanElement>(null);
  const [offsetPx, setOffsetPx] = useState(0);

  useEffect(() => {
    function measure(): void {
      const element = ref.current;
      if (!element) return;

      const viewport = window.innerWidth;
      const width = Math.min(DETAIL_WIDTH_PX, viewport - 2 * DETAIL_MARGIN_PX);
      const pillLeft = element.getBoundingClientRect().left;

      // Where it would like to be, then bounded by both margins. The lower
      // bound is applied second so a viewport narrower than the detail still
      // starts it on screen rather than off the left.
      const wanted = pillLeft;
      const rightmost = viewport - width - DETAIL_MARGIN_PX;
      const placed = Math.max(DETAIL_MARGIN_PX, Math.min(wanted, rightmost));

      setOffsetPx(placed - pillLeft);
    }

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return { ref, offsetPx };
}

export function AlertTag({
  tone,
  label,
  detail,
  detailId,
  to,
}: {
  readonly tone: PillTone;
  /** Two or three words. The pill is about as wide as "Over-delegated". */
  readonly label: ReactNode;
  /** The whole of it, revealed on hover and on focus. */
  readonly detail: ReactNode;
  /** Stable id for `aria-describedby`; the caller owns it via `useId`. */
  readonly detailId: string;
  /** Given, the pill is a link to where the condition is dealt with. */
  readonly to?: string;
}): ReactNode {
  // `truncate` because this sits in a fixed-width column now: a long reading has
  // to give way rather than widen the sidebar, and the whole of it is in the
  // detail below and in the `title` either way.
  const face = `${tagFace(tone, 'md')} truncate`;
  const { ref, offsetPx } = useDetailOffset();

  return (
    <span ref={ref} className="group relative shrink-0">
      {to === undefined ? (
        /*
         * Not a button, because there is nothing to press: it reports, it does
         * not act. It still takes focus — the detail has to be reachable
         * without a mouse, and `tabIndex` plus `aria-describedby` is what gets
         * it to a keyboard and to a screen reader. A description referenced
         * this way is read even while the element holding it is hidden.
         *
         * `role="status"` rather than `alert`: a standing reading, not an
         * interruption, and it changes on every edit. The detail sits outside
         * the live region deliberately — inside it, revealing the tooltip would
         * re-announce the whole thing on every hover.
         */
        <span
          role="status"
          tabIndex={0}
          aria-describedby={detailId}
          className={`cursor-default ${face}`}
        >
          {label}
        </span>
      ) : (
        <Link to={to} aria-describedby={detailId} className={face}>
          {label}
        </Link>
      )}

      <span
        id={detailId}
        role="tooltip"
        /*
         * A fixed, prose-shaped width that wraps, hung from whichever edge keeps
         * it on screen. It used to be `w-max` with a viewport-width cap, and the
         * cap could not work: it bounded the detail's *width* while its left
         * edge was already however far across the page the pill happened to sit,
         * so anything long ran off the right with the end of the sentence
         * unreachable.
         */
        className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-canvas px-3 py-2 text-quiet text-ink shadow-lg group-hover:block group-focus-within:block"
        style={{ transform: `translateX(${offsetPx}px)` }}
      >
        {detail}
      </span>
    </span>
  );
}
