import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * What a control in the sidebar's foot has to say, one hover or one focus away.
 *
 * Three things wear this: **Sync SimpleFIN**, carrying everything the bank feed
 * is currently reporting (ADR 063), the **backlog**, carrying how old the oldest
 * waiting charge is (ADR 066), and the budget's **reading**, carrying the
 * arithmetic behind the figure. All are controls at the foot of a 180px column
 * that have sentences to show, and a second shape for the second one is how a
 * set stops looking like a set.
 *
 * **To the right of its control, never above it.** It opened upwards at first,
 * which meant it covered the button above — Sync's panel sat over Delegate, and
 * the reading's sat over the alerts. A panel that hides a control you might have
 * been reaching for is worse than one that hides nothing, and the whole page is
 * to the right of this column and free.
 *
 * **Aligned to the control's own bottom, growing upward.** It was aligned to the
 * control's *top* and grew downward, which put the bottom of a tall panel below
 * the bottom of the window: Sync's own list, on the owner's screen, with the
 * sentence naming the bank cut off. This zone is pinned to the foot of the
 * viewport by construction — `mt-auto` and last in the column — so there is
 * almost no room below a control in it and almost the whole window above.
 * Growing upward is the direction with the space in it.
 *
 * That is a *flip* where `AlertTag` clamps, and the asymmetry is deliberate.
 * `AlertTag` clamps because a pill can sit anywhere along a wrapping row and
 * flipping it off one edge is the same bug mirrored. A control in this zone is
 * always near the bottom, so there is one right answer rather than two.
 *
 * **And it is capped at the room it actually has**, measured from the control
 * rather than guessed at with a `vh` fraction. Unbounded, five simultaneous bank
 * conditions on a short window would run off the *top* instead — the same defect
 * pointing the other way, which is not a fix.
 *
 * **Wider than the sidebar**, because these are sentences — the same 384px that
 * holds prose everywhere else (`ui-system.md` §2), capped so it cannot run off a
 * narrow window.
 *
 * **The offset is padding on the wrapper, never a margin on the card.** The 4px
 * between the control and the panel has to be *inside* the hover target: a bare
 * margin is a dead strip that drops `:hover` on the way into the panel, so a
 * link inside it closes as the mouse reaches for it.
 *
 * The caller owns the `group relative` wrapper and the `useId`, because it also
 * owns the control that points at this with `aria-describedby`.
 */

/** Breathing room at the top of the window, so a capped panel is not flush. */
const MARGIN_PX = 16;

/**
 * How tall this panel may be, from the control it hangs off.
 *
 * Measured from the **wrapper**, which is the control and is always rendered.
 * The panel itself cannot be measured: it is `display: none` until revealed, and
 * a hidden element has no box — the same reason `AlertTag` measures its pill
 * rather than its detail.
 *
 * No dependency array, matching `useDetailOffset`: this has to be right again
 * after anything that moves the control, and the sidebar collapsing is a
 * re-render rather than a resize.
 */
function useRoomAbove(): {
  ref: React.RefObject<HTMLDivElement | null>;
  maxHeightPx: number | null;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeightPx, setMaxHeightPx] = useState<number | null>(null);

  useEffect(() => {
    function measure(): void {
      // The `group relative` wrapper this is absolutely positioned inside.
      const control = ref.current?.parentElement;
      if (!control) return;

      // Bottom-aligned, so the room is everything between the top of the window
      // and the bottom of the control.
      const room = Math.round(control.getBoundingClientRect().bottom) - MARGIN_PX;
      setMaxHeightPx(room > 0 ? room : null);
    }

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return { ref, maxHeightPx };
}

export function ControlPopover({
  id,
  children,
}: {
  /** The caller's `useId`, so its control can describe itself with this. */
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  const { ref, maxHeightPx } = useRoomAbove();

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="absolute bottom-0 left-full z-20 hidden w-96 max-w-[calc(100vw-2rem)] pl-1 group-hover:block group-focus-within:block"
    >
      {/* The same card `AlertTag` hangs its detail from — one floating reading,
          not a second shape for one. Notably *not* the tile surface, which
          `ui-system.test.ts` reserves for `Tile`.

          `overflow-y-auto` is the last resort rather than the mechanism: the cap
          is generous enough that nothing this zone reports reaches it on an
          ordinary window, and a panel that scrolls is still better than one
          whose first line is off the screen. */}
      <div
        className="flex flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-canvas px-3 py-2 shadow-lg"
        style={maxHeightPx === null ? undefined : { maxHeight: `${maxHeightPx}px` }}
      >
        {children}
      </div>
    </div>
  );
}
