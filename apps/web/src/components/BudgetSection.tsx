import { groupingTint } from '@budget/shared';
import { Fragment, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { BudgetRowDto, BudgetSectionDto } from '../api/budget.js';
import { MoneyCell } from './MoneyCell.jsx';
import { Tag } from './ui.jsx';

/**
 * One section of the Main Budget: Assets, Debts or Delegations.
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
  readonly headerActions?: ReactNode;
  /**
   * The per-row menu, supplied by the page. Kept as a render prop so this
   * component stays presentational and knows nothing about delegations.
   */
  readonly rowMenu?: (row: BudgetRowDto) => ReactNode;
  /**
   * Dragging a row into a grouping. An enhancement, never the only route: the
   * row menu's "Move to grouping" stays the keyboard path, because drag and drop
   * is not one.
   */
  readonly onMoveToGrouping?: (rowId: string, groupingId: string | null) => void;
}

function parseCents(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
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
  headerActions,
  rowMenu,
  onMoveToGrouping,
}: BudgetSectionProps): ReactNode {
  const [newName, setNewName] = useState('');
  // Which grouping the pointer is currently over, so the target is obvious
  // before the drop rather than after it.
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);

  const draggable = onMoveToGrouping !== undefined;

  function onDragStart(event: DragEvent, rowId: string): void {
    event.dataTransfer.setData('text/plain', rowId);
    event.dataTransfer.effectAllowed = 'move';
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
        {...(tint ? { style: { background: tint } } : {})}
        draggable={draggable}
        onDragStart={(event) => onDragStart(event, row.id)}
      >
        <td className={`py-2 pr-3 ${inGrouping ? 'pl-8' : 'pl-3'}`}>
          <span className="text-ink">{row.name}</span>
          {row.source && (
            <span className="ml-2">
              <Tag>{row.source}</Tag>
            </span>
          )}
          {/* A discovered account's type is a guess until the owner confirms it. */}
          {row.needsReview && (
            <span className="ml-2 text-label font-semibold text-warning">needs review</span>
          )}
        </td>

        <td className="w-40 py-2">
          <MoneyCell
            valueCents={parseCents(row.balanceCents)}
            editable={onEditBalance !== undefined}
            redWhenNegative={redNegatives}
            emphasis={showAmountToDelegate ? 'hero' : 'normal'}
            label={`${row.name} balance`}
            onCommit={(cents) => onEditBalance?.(row.id, cents)}
          />
        </td>

        {showAmountToDelegate && (
          <td className="w-36 py-2 pr-3">
            <MoneyCell
              valueCents={parseCents(row.amountToDelegateCents)}
              editable={onEditAmount !== undefined}
              emphasis="quiet"
              label={`${row.name} amount to delegate`}
              onCommit={(cents) => onEditAmount?.(row.id, cents)}
            />
          </td>
        )}

        {rowMenu && <td className="w-10 py-2 pr-3">{rowMenu(row)}</td>}
      </tr>
    );
  }

  const columnCount = (showAmountToDelegate ? 3 : 2) + (rowMenu ? 1 : 0);

  return (
    <section className="mb-8">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-section font-bold text-ink">{title}</h2>
        {headerActions}
      </header>

      <table className="w-full border-t-2 border-ink">
        <thead>
          <tr className="text-label uppercase tracking-[0.05em] text-muted">
            <th className="py-2 pl-3 text-left font-normal">Name</th>
            <th className="py-2 text-right font-normal">
              {showAmountToDelegate ? 'Remaining' : 'Balance'}
            </th>
            {showAmountToDelegate && (
              <th className="py-2 pr-3 text-right font-normal text-faint">To delegate</th>
            )}
            {rowMenu && <th className="w-10 py-2 pr-3" />}
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
                <td className="py-2 pl-3">
                  <button
                    type="button"
                    onClick={() => onToggleGrouping?.(grouping.id, !grouping.collapsed)}
                    aria-expanded={!grouping.collapsed}
                    className="flex items-center gap-2 font-semibold text-ink"
                  >
                    <span aria-hidden>{grouping.collapsed ? '▸' : '▾'}</span>
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 rounded-sm"
                      style={{ background: grouping.color ?? 'var(--color-group-grey)' }}
                    />
                    {grouping.name}
                    {grouping.collapsed && (
                      <span className="text-quiet font-normal text-muted">
                        (collapsed — {grouping.rows.length}{' '}
                        {grouping.rows.length === 1 ? 'line' : 'lines'})
                      </span>
                    )}
                  </button>
                </td>

                {/* Amounts appear on the grouping row only when collapsed. Shown
                    while expanded they would double every figure below them. */}
                <td className="py-2">
                  {grouping.collapsed && (
                    <MoneyCell
                      valueCents={parseCents(grouping.balanceCents)}
                      redWhenNegative={redNegatives}
                      emphasis={showAmountToDelegate ? 'hero' : 'normal'}
                      label={`${grouping.name} total`}
                    />
                  )}
                </td>

                {showAmountToDelegate && (
                  <td className="py-2 pr-3">
                    {grouping.collapsed && (
                      <MoneyCell
                        valueCents={parseCents(grouping.amountToDelegateCents)}
                        emphasis="quiet"
                        label={`${grouping.name} amount to delegate`}
                      />
                    )}
                  </td>
                )}

                {rowMenu && <td className="w-10 py-2 pr-3" />}
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
              <td className="py-2 pl-3 text-quiet text-muted" colSpan={columnCount}>
                Drop here to remove from every grouping
              </td>
            </tr>
          )}

          {onCreate && (
            <tr className="border-b border-line">
              <td className="py-2 pl-3" colSpan={columnCount}>
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

        <tfoot>
          <tr className="border-t-2 border-ink bg-surface font-bold">
            <td className="py-2 pl-3 text-ink">Total</td>
            <td className="py-2">
              <MoneyCell
                valueCents={parseCents(section.totalBalanceCents)}
                redWhenNegative={redNegatives}
                emphasis={showAmountToDelegate ? 'hero' : 'normal'}
                label={`${title} total`}
              />
            </td>
            {showAmountToDelegate && (
              <td className="py-2 pr-3">
                <MoneyCell
                  valueCents={parseCents(section.totalAmountToDelegateCents)}
                  emphasis="quiet"
                  label={`${title} total to delegate`}
                />
              </td>
            )}
            {rowMenu && <td className="w-10 py-2 pr-3" />}
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
