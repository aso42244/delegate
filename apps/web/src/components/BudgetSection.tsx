import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react';
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
}: BudgetSectionProps): ReactNode {
  const [newName, setNewName] = useState('');

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

  function renderRow(row: BudgetRowDto, inGrouping: boolean): ReactNode {
    return (
      <tr key={row.id} className="border-b border-line last:border-0">
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
      </tr>
    );
  }

  const columnCount = showAmountToDelegate ? 3 : 2;

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
          </tr>
        </thead>

        <tbody>
          {section.groupings.map((grouping) => (
            // The Fragment is the array element, so the key belongs on it rather
            // than on the row inside.
            <Fragment key={grouping.id}>
              <tr className="border-b border-line bg-surface">
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
              </tr>

              {!grouping.collapsed && grouping.rows.map((row) => renderRow(row, true))}
            </Fragment>
          ))}

          {section.ungrouped.map((row) => renderRow(row, false))}

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
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
