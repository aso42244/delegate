import { formatCents, groupingTint, isBalanceStale } from '@budget/shared';
import {
  Fragment,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type TouchEvent,
} from 'react';
import type { BudgetRowDto, BudgetSectionDto } from '../api/budget.js';
import { NARROW, useMediaQuery } from '../useMediaQuery.js';
import { Chips } from './Chip.jsx';
import type { ChipKind } from './chips.js';
import { MoneyCell } from './MoneyCell.jsx';

/**
 * One section of the Budget page: Assets, Debts or Delegations.
 *
 * Borderless spreadsheet style per the design — a 2px rule across the top, then
 * 1px row dividers, no card. Assets and Debts show balances only; the amount to
 * delegate belongs to delegations alone.
 */

export interface BudgetSectionProps {
  readonly title: string;
  readonly section: BudgetSectionDto;
  readonly showAmountToDelegate: boolean;
  /** Only delegation balances render negatives in red. Debts never do. */
  readonly redNegatives: boolean;
  readonly onToggleGrouping?: (groupingId: string, collapsed: boolean) => void;
  readonly onEditAmount?: (rowId: string, cents: bigint) => void;
  readonly onEditBalance?: (rowId: string, cents: bigint) => void;
  readonly onCreate?: (name: string) => void;
  /**
   * The per-row menu, supplied by the page. Kept as a render prop so this
   * component stays presentational and knows nothing about delegations.
   */
  readonly rowMenu?: (row: BudgetRowDto) => ReactNode;
  /**
   * Dragging a row into a grouping, dropped on the grouping itself: it goes to
   * the end. An enhancement, never the only route — the row menu's "Move to
   * grouping" and "Move up"/"Move down" stay the keyboard path, because drag and
   * drop is not one.
   */
  readonly onMoveToGrouping?: (rowId: string, groupingId: string | null) => void;
  /**
   * Dropping a row onto another row: it takes that row's place, in that row's
   * grouping. The component works out the resulting order and hands over the
   * whole of it, because a list is the only description of an ordering that
   * cannot be interpreted two ways.
   */
  readonly onPlace?: (rowId: string, groupingId: string | null, orderedIds: string[]) => void;
  /**
   * Offers to close the budget's reading against this line.
   *
   * Supplied only by the Delegations section, and only while there is a reading
   * to close — a button that would open a dialog with nothing to do is worse
   * than no button. Revealed on hover like the row menu, because it is an
   * occasional act and the row is mostly numbers.
   */
  readonly onAbsorb?: (row: BudgetRowDto) => void;
  /** What the button says: which direction the money is going. */
  readonly absorbLabel?: string;
  /**
   * A control hung beside a row's Remaining figure, in the same place as the
   * absorb button but **always visible** rather than revealed on hover.
   *
   * The absorb button is an offer; this is a standing state — a check the bank
   * appears to have cashed. A state nobody can see until they happen to hover
   * the right row is one nobody acts on, and the banner at the top of the page
   * would be pointing at something invisible.
   */
  readonly rowAffordance?: (row: BudgetRowDto) => ReactNode;
}

function parseCents(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

/**
 * Which marks a budget row carries.
 *
 * Ordered by what it *is* before what is *wrong with it*: a holding is a
 * holding whether or not its price is stale, and reading `btc s` in that order
 * matches how somebody would say it out loud.
 */
function chipsFor(row: BudgetRowDto): ChipKind[] {
  const kinds: ChipKind[] = [];

  if (row.managedAs === 'bitcoin') kinds.push('bitcoin');
  if (row.managedAs === 'property') kinds.push('property');
  // A managed row's balance is not one anybody keeps by hand, whatever `source`
  // happens to say about how the account was created.
  if (row.source === 'manual' && row.managedAs === 'none') kinds.push('manual');
  if (row.isUtility) kinds.push('utility');
  if (row.notes !== null && row.notes.trim() !== '') kinds.push('note');
  if (
    isBalanceStale(
      row.balanceAsOf === null ? null : new Date(row.balanceAsOf),
      row.stalenessIntervalDays,
    )
  ) {
    kinds.push('stale');
  }
  if (row.needsReview) kinds.push('review');

  return kinds;
}

export function BudgetSection({
  title,
  section,
  showAmountToDelegate,
  redNegatives,
  onToggleGrouping,
  onEditAmount,
  onEditBalance,
  onCreate,
  rowMenu,
  onMoveToGrouping,
  onPlace,
  onAbsorb,
  absorbLabel,
  rowAffordance,
}: BudgetSectionProps): ReactNode {
  const [newName, setNewName] = useState('');

  /**
   * On a phone there is not room for a name and two money columns, so one money
   * column shows at a time and swiping horizontally switches between them.
   *
   * Swipe is never the only route — the same rule the row menu follows for
   * drag-and-drop. The buttons below do the same job, and are what a screen
   * reader or a keyboard reaches.
   */
  const narrow = useMediaQuery(NARROW);
  const [mobileColumn, setMobileColumn] = useState<'remaining' | 'toDelegate'>('remaining');
  const splitColumns = narrow && showAmountToDelegate;

  const showRemaining = !splitColumns || mobileColumn === 'remaining';
  const showToDelegate = showAmountToDelegate && (!splitColumns || mobileColumn === 'toDelegate');

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(event: TouchEvent<HTMLTableElement>): void {
    const touch = event.touches[0];
    if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchEnd(event: TouchEvent<HTMLTableElement>): void {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = null;
    if (!start || !touch || !splitColumns) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Horizontal intent only: a diagonal drag during a vertical scroll must not
    // change the column out from under someone's thumb.
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;

    setMobileColumn(dx < 0 ? 'toDelegate' : 'remaining');
  }
  // Which grouping the pointer is currently over, so the target is obvious
  // before the drop rather than after it.
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);

  // Which row the pointer is over, so the insertion point is visible before the
  // drop rather than discovered after it.
  const [rowTarget, setRowTarget] = useState<string | null>(null);

  const draggable = onMoveToGrouping !== undefined;

  function onDragStart(event: DragEvent, rowId: string): void {
    event.dataTransfer.setData('text/plain', rowId);
    event.dataTransfer.effectAllowed = 'move';
  }

  /** Every row of the grouping the target sits in, in the order shown. */
  function membersOf(groupingId: string | null): BudgetRowDto[] {
    return groupingId === null
      ? [...section.ungrouped]
      : [...(section.groupings.find((grouping) => grouping.id === groupingId)?.rows ?? [])];
  }

  /**
   * Drops a row onto another row: it takes that row's place.
   *
   * The dragged row is removed first and then inserted, so moving a row down
   * inside its own grouping lands where the pointer is rather than one short of
   * it — which is the classic off-by-one in every list like this.
   */
  function onDropOnRow(event: DragEvent, target: BudgetRowDto): void {
    event.preventDefault();
    event.stopPropagation();
    setRowTarget(null);
    setDropTarget(undefined);

    const rowId = event.dataTransfer.getData('text/plain');
    if (rowId === '' || rowId === target.id) return;

    const destination = target.groupingId;
    const members = membersOf(destination).filter((row) => row.id !== rowId);
    const at = members.findIndex((row) => row.id === target.id);
    members.splice(at === -1 ? members.length : at, 0, { ...target, id: rowId });

    onPlace?.(
      rowId,
      destination,
      members.map((row) => row.id),
    );
  }

  function onDrop(event: DragEvent, groupingId: string | null): void {
    event.preventDefault();
    setDropTarget(undefined);
    const rowId = event.dataTransfer.getData('text/plain');
    if (rowId !== '') onMoveToGrouping?.(rowId, groupingId);
  }

  function onNewKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const name = newName.trim();
    if (name === '') return;

    // Cleared immediately so the next name can be typed without waiting for the
    // round trip. Typing sixty of these is the go-live path.
    setNewName('');
    onCreate?.(name);
  }

  function renderRow(row: BudgetRowDto, inGrouping: boolean, tint?: string): ReactNode {
    return (
      // `group` so the row's menu button can appear on hover of the row rather
      // than only on hover of the button itself.
      <tr
        key={row.id}
        className="group border-b border-line last:border-0"
        draggable={draggable}
        onDragStart={(event) => onDragStart(event, row.id)}
        onDragOver={(event) => {
          if (!draggable) return;
          // Without preventDefault the drop never fires at all.
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setRowTarget(row.id);
        }}
        onDragLeave={() => setRowTarget((current) => (current === row.id ? null : current))}
        onDrop={(event) => onDropOnRow(event, row)}
        style={{
          ...(tint ? { background: tint } : {}),
          // A line above the row being dropped onto, which is where it will land.
          ...(rowTarget === row.id ? { boxShadow: 'inset 0 2px 0 0 var(--color-accent)' } : {}),
        }}
      >
        <td className={`row-cell pr-3 ${inGrouping ? 'pl-8' : 'pl-3'}`}>
          <span className="text-ink">{row.name}</span>

          {/*
            Marks, never words. Nearly everything on this page comes from the
            feed, so labelling *those* said nothing while taking a row's width;
            what is worth knowing at a glance is the opposite — which balances
            somebody keeps true by hand, which are guesses, and which are not
            bank balances at all. Every mark carries its meaning for a screen
            reader and on hover; see components/chips.ts.
          */}
          {chipsFor(row).length > 0 && (
            <span className="ml-2 inline-flex align-middle">
              <Chips kinds={chipsFor(row)} />
            </span>
          )}
        </td>

        {showRemaining && (
          // `relative`, with the button below hung off the left of the cell: it
          // belongs beside the figure it is about, and that figure lives in a
          // 160px column with no width to share. Out of flow it sits where it
          // reads, over space the name column is not using, and only while the
          // row is hovered.
          <td className="relative w-40 row-cell">
            {onAbsorb && row.kind !== 'check' && (
              <button
                type="button"
                onClick={() => onAbsorb(row)}
                className="row-menu-trigger absolute top-1/2 right-full mr-2 -translate-y-1/2 rounded border border-line bg-canvas px-1.5 py-0.5 text-label font-semibold whitespace-nowrap text-muted hover:bg-surface"
              >
                {absorbLabel}
              </button>
            )}

            {/* The same slot, and never both: the absorb button is not offered
                on a check, which is the only row this returns anything for. */}
            {rowAffordance && (
              <span className="absolute top-1/2 right-full mr-2 -translate-y-1/2">
                {rowAffordance(row)}
              </span>
            )}

            <MoneyCell
              valueCents={parseCents(row.balanceCents)}
              editable={onEditBalance !== undefined}
              redWhenNegative={redNegatives}
              emphasis={showAmountToDelegate ? 'hero' : 'normal'}
              label={`${row.name} balance`}
              onCommit={(cents) => onEditBalance?.(row.id, cents)}
            />
          </td>
        )}

        {showToDelegate && (
          // No right padding, so the figure lands in the same column as the
          // balance on the Assets and Debts tables. Those cells have none, so
          // the 12px here was the whole of the misalignment.
          <td className="w-36 row-cell">
            <MoneyCell
              valueCents={parseCents(row.amountToDelegateCents)}
              editable={onEditAmount !== undefined}
              emphasis="quiet"
              label={`${row.name} amount to delegate`}
              onCommit={(cents) => onEditAmount?.(row.id, cents)}
            />
          </td>
        )}

        {rowMenu && <td className="w-10 row-cell pr-3">{rowMenu(row)}</td>}
      </tr>
    );
  }

  const columnCount = 1 + (showRemaining ? 1 : 0) + (showToDelegate ? 1 : 0) + (rowMenu ? 1 : 0);

  return (
    <section className="mb-8">
      <table className="w-full" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {/*
          The section's total is a row of this table rather than a heading above
          it, so each figure lands in the same column as the figures it totals.
          Laid out any other way the two have to be kept in step by hand, and one
          change to a column width silently pulls them apart.

          A "Total" row at the bottom is what this replaces: it repeated the
          section's name in the left column and put the figure furthest from the
          thing it totalled.
        */}
        <thead>
          <tr className="border-b-2 border-ink">
            <td className="pb-1 pl-3">
              <h2 className="text-section font-bold text-ink">{title}</h2>
            </td>
            {showRemaining && (
              <td className="w-40 pb-1">
                <span className="money block px-2 text-section font-bold text-ink">
                  {formatCents(parseCents(section.totalBalanceCents) ?? 0n)}
                </span>
              </td>
            )}
            {showToDelegate && (
              <td className="w-36 pb-1">
                <span className="money block px-2 text-section font-bold text-faint">
                  {section.totalAmountToDelegateCents === null
                    ? '—'
                    : formatCents(parseCents(section.totalAmountToDelegateCents) ?? 0n)}
                </span>
              </td>
            )}
            {rowMenu && <td className="w-10 pb-1 pr-3" />}
          </tr>

          {splitColumns && (
            <tr>
              <td colSpan={columnCount} className="pt-2 pb-1">
                <div
                  role="radiogroup"
                  aria-label="Which amount to show"
                  className="flex gap-1 rounded-lg bg-surface-2 p-0.5"
                >
                  {(
                    [
                      ['remaining', 'Remaining'],
                      ['toDelegate', 'To delegate'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={mobileColumn === value}
                      onClick={() => setMobileColumn(value)}
                      className={`flex-1 rounded-md px-3 py-1.5 text-quiet font-semibold ${
                        mobileColumn === value ? 'bg-canvas text-ink shadow-sm' : 'text-muted'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </td>
            </tr>
          )}

          {/* Assets and debts have one money column, under a heading that already
              says what it is. Delegations has two, which do need naming. */}
          <tr
            className={`text-label uppercase tracking-[0.05em] text-muted ${
              showAmountToDelegate ? '' : 'sr-only'
            }`}
          >
            <th className="row-cell pl-3 text-left font-normal">Name</th>
            {showRemaining && (
              <th className="row-cell pr-2 text-right font-normal">
                {showAmountToDelegate ? 'Remaining' : 'Balance'}
              </th>
            )}
            {showToDelegate && (
              <th className="row-cell pr-2 text-right font-normal text-faint">To delegate</th>
            )}
            {rowMenu && <th className="w-10 row-cell pr-3" />}
          </tr>
        </thead>

        <tbody>
          {section.groupings.map((grouping) => (
            // The Fragment is the array element, so the key belongs on it rather
            // than on the row inside.
            <Fragment key={grouping.id}>
              <tr
                className={`border-b border-line bg-surface ${
                  dropTarget === grouping.id ? 'outline-2 outline-accent' : ''
                }`}
                style={{ background: groupingTint(grouping.color, 'header') ?? '' }}
                onDragOver={(event) => {
                  if (!draggable) return;
                  event.preventDefault();
                  setDropTarget(grouping.id);
                }}
                onDragLeave={() => setDropTarget(undefined)}
                onDrop={(event) => onDrop(event, grouping.id)}
              >
                <td className="row-cell pl-3">
                  <button
                    type="button"
                    onClick={() => onToggleGrouping?.(grouping.id, !grouping.collapsed)}
                    aria-expanded={!grouping.collapsed}
                    className="group/toggle -ml-1 flex items-center gap-1 rounded font-semibold text-ink"
                  >
                    {/*
                      Drawn rather than typed, and sized to look like the target
                      it is: ▸ at body size was a mark beside the name rather
                      than a control. The box around it is the affordance — it
                      takes a background on hover, so the whole row reads as
                      something to press.

                      The colour dot that sat between this and the name is gone.
                      The row's own tint already says which grouping this is, and
                      saying it twice cost the width without adding the meaning.
                    */}
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted group-hover/toggle:bg-surface-2 group-hover/toggle:text-ink">
                      <svg
                        viewBox="0 0 20 20"
                        className="h-[18px] w-[18px]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d={grouping.collapsed ? 'M8 5l5 5-5 5' : 'M5 8l5 5 5-5'} />
                      </svg>
                    </span>
                    {grouping.name}
                  </button>
                </td>

                {/* Amounts appear on the grouping row only when collapsed. Shown
                    while expanded they would double every figure below them. */}
                {showRemaining && (
                  <td className="row-cell">
                    {grouping.collapsed && (
                      <MoneyCell
                        valueCents={parseCents(grouping.balanceCents)}
                        redWhenNegative={redNegatives}
                        emphasis={showAmountToDelegate ? 'hero' : 'normal'}
                        label={`${grouping.name} total`}
                      />
                    )}
                  </td>
                )}

                {showToDelegate && (
                  <td className="row-cell">
                    {grouping.collapsed && (
                      <MoneyCell
                        valueCents={parseCents(grouping.amountToDelegateCents)}
                        emphasis="quiet"
                        label={`${grouping.name} amount to delegate`}
                      />
                    )}
                  </td>
                )}

                {rowMenu && <td className="w-10 row-cell pr-3" />}
              </tr>

              {!grouping.collapsed &&
                grouping.rows.map((row) =>
                  renderRow(row, true, groupingTint(grouping.color, 'row')),
                )}
            </Fragment>
          ))}

          {section.ungrouped.map((row) => renderRow(row, false))}

          {/* A landing strip for dragging a row back out of every grouping.
              Shown only while something is being dragged. */}
          {draggable && dropTarget !== undefined && (
            <tr
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(null);
              }}
              onDrop={(event) => onDrop(event, null)}
              className={`border-b border-line ${dropTarget === null ? 'bg-accent-soft' : ''}`}
            >
              <td className="row-cell pl-3 text-quiet text-muted" colSpan={columnCount}>
                Drop here to remove from every grouping
              </td>
            </tr>
          )}

          {onCreate && (
            <tr className="border-b border-line">
              <td className="row-cell pl-3" colSpan={columnCount}>
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={onNewKeyDown}
                  placeholder="+ Add a line, then press Enter"
                  aria-label={`Add to ${title}`}
                  className="w-full bg-transparent text-base text-ink placeholder:text-faint focus:outline-none"
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
