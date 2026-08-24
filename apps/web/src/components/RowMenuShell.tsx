import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLongPress } from '../useLongPress.js';

/**
 * The mechanics shared by every row menu on the Budget page: the `⋯` trigger,
 * the popover, dismissal, and the "move to grouping" sub-panel.
 *
 * Delegations and accounts need different *items* but identical behaviour, and
 * the behaviour is the part that would be easy to get subtly wrong twice — the
 * trigger has to be reachable by keyboard although it is revealed on hover, and
 * the menu has to close on Escape and on a click elsewhere.
 *
 * Three ways in, one per input device: hover and click the `⋯`, focus the row
 * and press it by keyboard, or **touch and hold the row** on a phone, where
 * there is no hover to reveal anything with.
 */

export interface GroupingOption {
  readonly id: string;
  readonly name: string;
}

/** Handed to the items, so one can close the menu or open the grouping panel. */
export interface RowMenuControls {
  readonly close: () => void;
  readonly openGroupingPanel: () => void;
}

const ITEM_LAYOUT =
  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-quiet hover:bg-surface-2';

export const ITEM_CLASS = `${ITEM_LAYOUT} text-ink`;

/**
 * Archive, and nothing else.
 *
 * Composed from the shared layout rather than written as `ITEM_CLASS
 * text-danger`: those two colour utilities have equal specificity, so which one
 * won depended on the order Tailwind happened to emit them in — and it was
 * `text-ink`, which left the one destructive item in the menu looking like all
 * the others. The design asks for it in red, and that is the only signal
 * separating it from Rename.
 */
export const DANGER_ITEM_CLASS = `${ITEM_LAYOUT} text-danger`;

export interface RowMenuShellProps {
  readonly name: string;
  /**
   * Omit all three to get a menu with no "move to grouping" panel. A transaction
   * has no grouping, and an outstanding check is not moved out of the one the
   * budget puts it in.
   */
  readonly groupings?: readonly GroupingOption[];
  readonly currentGroupingId?: string | null;
  readonly onMoveToGrouping?: (groupingId: string | null) => void;
  /** Rendered under the name, above the items — the delegation note panel. */
  readonly header?: ReactNode;
  /** The menu items, on the root panel. */
  readonly children: (controls: RowMenuControls) => ReactNode;
  /** Dialogs, rendered outside the popover so they outlive it closing. */
  readonly overlay?: ReactNode;
}

export function RowMenuShell({
  name,
  groupings,
  currentGroupingId = null,
  onMoveToGrouping,
  header,
  children,
  overlay,
}: RowMenuShellProps): ReactNode {
  const canMove = groupings !== undefined && onMoveToGrouping !== undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'root' | 'grouping'>('root');

  /**
   * Which way the menu opens, and how tall it is allowed to be.
   *
   * It used to always open downwards, which is right for every row except the
   * ones near the bottom of the window — and the last row of a long table is
   * exactly where somebody is when they want to rename the line they just added.
   * The menu ran off the screen and the items could not be reached at all.
   *
   * Measured rather than guessed: the item count varies, and the grouping panel
   * is a different height from the root one.
   */
  const [placement, setPlacement] = useState<{ side: 'below' | 'above'; maxHeight: number | null }>(
    {
      side: 'below',
      maxHeight: null,
    },
  );

  /**
   * The row this menu belongs to, found rather than passed.
   *
   * Every caller renders this inside a cell of the row it acts on, so the
   * relationship is already true — threading a ref through each one would only
   * be a second place for it to be stated, and to be stated wrongly.
   */
  useEffect(() => {
    rowRef.current = containerRef.current?.closest('tr') ?? null;
  });

  useLongPress(
    rowRef,
    useCallback(() => {
      setPanel('root');
      setOpen(true);
    }, []),
  );

  /**
   * Places the menu after it has rendered but before the browser paints.
   *
   * `useLayoutEffect` rather than `useEffect` so the flip is never seen: the
   * menu is measured and moved in the same frame it appears in. Measuring the
   * real element rather than estimating from the item count is what makes this
   * hold for the grouping panel, which is a different height and grows with the
   * number of groupings.
   */
  useLayoutEffect(() => {
    if (!open) return;

    function place(): void {
      const menu = menuRef.current;
      const anchor = containerRef.current;
      if (!menu || !anchor) return;

      const rect = anchor.getBoundingClientRect();
      // A little air, so the menu never sits flush against the window edge.
      const margin = 8;
      const below = window.innerHeight - rect.bottom - margin;
      const above = rect.top - margin;
      const wanted = menu.scrollHeight;

      // Flipped only when it genuinely does not fit *and* the other side is
      // roomier. Flipping to somewhere equally cramped would move the problem
      // rather than fix it.
      const side = wanted > below && above > below ? 'above' : 'below';
      const available = side === 'above' ? above : below;

      setPlacement({
        side,
        // Scrolls rather than overflows when neither side is tall enough — a
        // long list of groupings on a short window has nowhere else to go.
        maxHeight: wanted > available ? Math.max(available, 120) : null,
      });
    }

    place();

    // The window can change under an open menu: a rotated phone, a resized
    // window, a page scrolled with the keyboard.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, panel]);

  useEffect(() => {
    if (!open) return;

    function dismiss(): void {
      setOpen(false);
      setPanel('root');
    }
    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) dismiss();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') dismiss();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const controls: RowMenuControls = {
    close: () => {
      setOpen(false);
      setPanel('root');
    },
    openGroupingPanel: () => {
      if (canMove) setPanel('grouping');
    },
  };

  return (
    <div ref={containerRef} className="relative flex justify-end">
      {/* Revealed on hover, and always reachable by keyboard: a control that
          exists only under a mouse pointer is a control some people never get. */}
      <button
        type="button"
        onClick={() => (open ? controls.close() : setOpen(true))}
        aria-label={`Options for ${name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="row-menu-trigger rounded px-2 py-0.5 text-muted"
      >
        ⋯
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Options for ${name}`}
          className={`absolute right-0 z-20 w-[250px] overflow-y-auto rounded-[10px] border border-line bg-canvas p-2 shadow-[0_4px_16px_rgba(0,0,0,.10)] ${
            placement.side === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          {...(placement.maxHeight === null ? {} : { style: { maxHeight: placement.maxHeight } })}
        >
          {panel === 'root' || !canMove ? (
            <>
              <p className="px-2 py-1 text-quiet font-semibold text-ink">{name}</p>
              {header}
              {children(controls)}
            </>
          ) : (
            <>
              <button
                type="button"
                className={ITEM_CLASS}
                onClick={() => setPanel('root')}
                aria-label="Back to the menu"
              >
                <span aria-hidden>◂</span>
                <span className="flex-1">Move to grouping</span>
              </button>
              <div className="my-1 border-t border-line" />

              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => {
                  onMoveToGrouping?.(null);
                  controls.close();
                }}
                disabled={currentGroupingId === null}
              >
                No grouping
              </button>

              {(groupings ?? []).map((grouping) => (
                <button
                  key={grouping.id}
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  onClick={() => {
                    onMoveToGrouping?.(grouping.id);
                    controls.close();
                  }}
                  disabled={currentGroupingId === grouping.id}
                >
                  {grouping.name}
                </button>
              ))}

              {(groupings ?? []).length === 0 && (
                <p className="px-2 py-1.5 text-quiet text-muted">
                  No groupings yet. Add one above the table.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {overlay}
    </div>
  );
}
