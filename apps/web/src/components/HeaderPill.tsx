import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * A reading in the page header, beside the title.
 *
 * The budget's own reading — Balanced, To delegate, Over-delegated — was the
 * first of these, and the notifications became the rest. They were full-width
 * bars until now: a yellow one and a blue one stacked above the page pushed the
 * budget a third of the way down the screen to say two things that fit in six
 * words between them. The bar is reserved for what can cost the household its
 * data; everything else is this.
 *
 * One component, so they are the same object rather than two things that
 * resemble each other. 28px like every other control on a row, its detail one
 * hover or one focus away.
 */

export type PillTone = 'info' | 'positive' | 'confirm' | 'warning' | 'danger';

const TONES: Record<PillTone, string> = {
  info: 'border-accent bg-accent-soft text-accent',
  positive: 'border-positive bg-positive-soft text-positive',
  // Purple: worked out, not yet acted on, waiting on a person.
  confirm: 'border-confirm-line bg-confirm-soft text-confirm',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
};

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

export function HeaderPill({
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
  const face = `inline-flex min-h-[28px] items-center rounded-lg border px-3 text-quiet font-semibold ${TONES[tone]}`;
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
