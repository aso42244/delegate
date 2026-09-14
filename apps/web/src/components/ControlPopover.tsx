import type { ReactNode } from 'react';

/**
 * What a control in the sidebar's foot has to say, one hover or one focus away.
 *
 * Two things wear this: **Sync SimpleFIN**, carrying everything the bank feed is
 * currently reporting (ADR 063), and the budget's **reading**, carrying the
 * arithmetic behind the figure. Both are controls at the bottom of a 180px
 * column that have sentences to show, and a second shape for the second one is
 * how a set stops looking like a set.
 *
 * **To the right of its control, never above it.** It opened upwards at first,
 * which meant it covered the button above — Sync's panel sat over Delegate, and
 * the reading's sat over the alerts. A panel that hides a control you might have
 * been reaching for is worse than one that hides nothing, and the whole page is
 * to the right of this column and free.
 *
 * **Aligned to the control's own top**, so it appears where the pointer already
 * is rather than jumping to a corner. It is placed by the control's position,
 * not the pointer's: a panel that follows the mouse is a panel whose links move
 * while you aim at them.
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
export function ControlPopover({
  id,
  children,
}: {
  /** The caller's `useId`, so its control can describe itself with this. */
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      id={id}
      role="tooltip"
      className="absolute top-0 left-full z-20 hidden w-96 max-w-[calc(100vw-2rem)] pl-1 group-hover:block group-focus-within:block"
    >
      {/* The same card `AlertTag` hangs its detail from — one floating reading,
          not a second shape for one. Notably *not* the tile surface, which
          `ui-system.test.ts` reserves for `Tile`. */}
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2 shadow-lg">
        {children}
      </div>
    </div>
  );
}
