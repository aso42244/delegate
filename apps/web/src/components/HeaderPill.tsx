import type { ReactNode } from 'react';
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

  return (
    <span className="group relative shrink-0">
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
        // `w-max` keeps it on one line wherever there is room, and the cap makes
        // it wrap rather than run off a phone.
        className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-max max-w-[calc(100vw-3rem)] rounded-lg border border-line bg-canvas px-3 py-2 text-quiet text-ink shadow-lg group-hover:block group-focus-within:block"
      >
        {detail}
      </span>
    </span>
  );
}
