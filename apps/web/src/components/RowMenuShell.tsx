import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The mechanics shared by every row menu on the Main Budget: the `⋯` trigger,
 * the popover, dismissal, and the "move to grouping" sub-panel.
 *
 * Delegations and accounts need different *items* but identical behaviour, and
 * the behaviour is the part that would be easy to get subtly wrong twice — the
 * trigger has to be reachable by keyboard although it is revealed on hover, and
 * the menu has to close on Escape and on a click elsewhere.
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

export const ITEM_CLASS =
  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-quiet text-ink hover:bg-surface-2';

export interface RowMenuShellProps {
  readonly name: string;
  readonly groupings: readonly GroupingOption[];
  readonly currentGroupingId: string | null;
  readonly onMoveToGrouping: (groupingId: string | null) => void;
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
  currentGroupingId,
  onMoveToGrouping,
  header,
  children,
  overlay,
}: RowMenuShellProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'root' | 'grouping'>('root');

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
    openGroupingPanel: () => setPanel('grouping'),
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
        className="rounded px-2 py-0.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        ⋯
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Options for ${name}`}
          className="absolute top-full right-0 z-20 w-[250px] rounded-[10px] border border-line bg-canvas p-2 shadow-[0_4px_16px_rgba(0,0,0,.10)]"
        >
          {panel === 'root' ? (
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
                  onMoveToGrouping(null);
                  controls.close();
                }}
                disabled={currentGroupingId === null}
              >
                No grouping
              </button>

              {groupings.map((grouping) => (
                <button
                  key={grouping.id}
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  onClick={() => {
                    onMoveToGrouping(grouping.id);
                    controls.close();
                  }}
                  disabled={currentGroupingId === grouping.id}
                >
                  {grouping.name}
                </button>
              ))}

              {groupings.length === 0 && (
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
