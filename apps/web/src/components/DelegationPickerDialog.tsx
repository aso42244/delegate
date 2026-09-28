import { formatCents } from '@budget/shared';
import { useState, type ReactNode } from 'react';
import type { BudgetViewDto } from '../api/budget.js';
import { EmptyState } from './layout.jsx';
import { Button, Modal, Toggle } from './ui.jsx';

/**
 * Which delegations the Overview band shows.
 *
 * **A 1:1 mirror of the Budget page**, and it is one because it reads the same
 * data rather than a second query shaped to look similar. `GET /api/budget`
 * already returns the delegations section grouped and ordered exactly as that
 * page draws it — grouping position, then delegation position, then name — so
 * mirroring is a property of where the data comes from rather than a claim two
 * orderings have to keep agreeing about.
 *
 * That matters more here than it looks. The owner's groupings are named "3 -
 * Food" and "5 - Home" because ordering was the thing missing before positions
 * existed; a picker that quietly sorted alphabetically would put his budget in
 * an order he has deliberately moved away from.
 *
 * The choice is applied on **Save**, not per toggle. Every toggle writing
 * immediately would be a request per line while somebody works down a list of
 * twenty-four, and the one that failed would leave the tile disagreeing with the
 * dialog still open in front of it.
 */
export function DelegationPickerDialog({
  budget,
  selected,
  onSave,
  onClose,
}: {
  readonly budget: BudgetViewDto | undefined;
  readonly selected: readonly string[];
  readonly onSave: (delegationIds: readonly string[]) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected));

  const section = budget?.delegations;
  /*
   * Groupings first, then the lines in none — the Budget page's own order.
   * Outstanding Checks is skipped: it is a grouping the budget owns rather than
   * one anybody filed under, its rows are pieces of paper rather than envelopes,
   * and it appears only while something is in it.
   */
  const groups = (section?.groupings ?? []).filter(
    (grouping) => grouping.systemKey !== 'outstanding-checks',
  );
  const ungrouped = section?.ungrouped ?? [];

  function toggle(id: string, on: boolean): void {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const total = groups.reduce((sum, group) => sum + group.rows.length, 0) + ungrouped.length;

  return (
    <Modal
      label="Select Delegations"
      title="Select Delegations"
      description="Arranged as they are on the Budget page."
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex items-center gap-2">
          <span className="text-quiet text-muted">
            {chosen.size} of {total} chosen
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => onSave([...chosen])}>
              Save
            </Button>
          </span>
        </div>
      }
    >
      {budget === undefined ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : total === 0 ? (
        <EmptyState>No delegations yet.</EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((grouping) => (
            <section key={grouping.id} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-label uppercase tracking-[0.05em] text-muted">
                {/* The grouping's own colour, the same 10px rounded square the
                    Budget page puts left of the name. */}
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: grouping.color ?? 'var(--color-group-grey)' }}
                />
                {grouping.name}
              </h3>
              <ul className="flex list-none flex-col gap-1 p-0">
                {grouping.rows.map((row) => (
                  <Row
                    key={row.id}
                    id={row.id}
                    name={row.name}
                    balanceCents={row.balanceCents}
                    checked={chosen.has(row.id)}
                    onChange={(on) => toggle(row.id, on)}
                  />
                ))}
              </ul>
            </section>
          ))}

          {ungrouped.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-label uppercase tracking-[0.05em] text-muted">No grouping</h3>
              <ul className="flex list-none flex-col gap-1 p-0">
                {ungrouped.map((row) => (
                  <Row
                    key={row.id}
                    id={row.id}
                    name={row.name}
                    balanceCents={row.balanceCents}
                    checked={chosen.has(row.id)}
                    onChange={(on) => toggle(row.id, on)}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({
  id,
  name,
  balanceCents,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}): ReactNode {
  const balance = BigInt(balanceCents);

  return (
    <li className="flex items-center gap-2" data-delegation={id}>
      <span className="min-w-0 flex-1 truncate text-base text-ink">{name}</span>
      {/* The balance is here so the choice can be made on what the line actually
          holds rather than on its name alone. */}
      <span
        className={`money shrink-0 text-quiet ${balance < 0n ? 'text-negative' : 'text-muted'}`}
      >
        {formatCents(balance)}
      </span>
      <Toggle checked={checked} onChange={onChange} label={`Show ${name}`} />
    </li>
  );
}
