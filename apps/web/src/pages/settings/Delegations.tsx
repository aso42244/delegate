import { formatCents, formatCentsForInput, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto, type BudgetViewDto } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { Chip } from '../../components/Chip.jsx';
import { Alert, Button, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Delegations.
 *
 * Every per-delegation setting, mirroring the row menu on the Budget page —
 * §9.5 requires that anything configurable elsewhere is configurable here too.
 * The difference is shape rather than capability: the row menu is for one line
 * in passing, this is for working down all sixty.
 *
 * Which is why the closed list reads like the Budget page's own table — the
 * same row height, the same three columns, alphabetical — and why the open one
 * is a single line of controls rather than a stack of labelled fields. Sixty
 * rows at 32px is a page somebody can work down; sixty at 76px, each opening
 * into a 300px form, is a page that has to be scrolled to be counted.
 */

function DelegationRow({
  row,
  groupings,
}: {
  readonly row: BudgetRowDto;
  readonly groupings: readonly { id: string; name: string }[];
}): ReactNode {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(row.name);
  const [amount, setAmount] = useState(
    row.amountToDelegateCents === null
      ? ''
      : formatCentsForInput(BigInt(row.amountToDelegateCents)),
  );
  const [notes, setNotes] = useState(row.notes ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Could not save this delegation.');

  const update = useMutation({
    mutationFn: (input: Parameters<typeof budgetApi.updateDelegation>[1]) =>
      budgetApi.updateDelegation(row.id, input),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const archive = useMutation({
    mutationFn: () => budgetApi.archiveDelegation(row.id),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    // Blocked unless the balance is exactly zero; the message names what is left.
    onError,
  });

  function save(): void {
    const trimmed = amount.trim();
    // An emptied cell means ad hoc — add nothing at Delegate time — which is not
    // the same as a deliberate zero, and the two must stay distinguishable.
    let amountToDelegateCents: string | null = null;
    if (trimmed !== '') {
      const parsed = tryParseMoney(trimmed);
      if (!parsed.ok) {
        setProblem('Enter an amount like 250.00, or leave it empty for an ad-hoc line.');
        return;
      }
      amountToDelegateCents = parsed.value.toString();
    }

    update.mutate({
      name: name.trim(),
      amountToDelegateCents,
      notes: notes.trim() === '' ? null : notes.trim(),
    });
    setExpanded(false);
  }

  const balance = BigInt(row.balanceCents);

  return (
    <>
      <tr className="border-b border-line last:border-0 hover:bg-surface">
        <td className="row-cell pl-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 text-left text-ink"
          >
            <span aria-hidden className="w-3 shrink-0 text-muted">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="truncate">{row.name}</span>
            {row.isUtility && <Chip kind="utility" />}
            {row.notes !== null && row.notes.trim() !== '' && <Chip kind="note" />}
          </button>
        </td>

        <td className="row-cell w-36 pr-2">
          <span
            className={`money block ${
              balance < 0n ? 'font-semibold text-negative' : 'text-hero font-bold text-ink'
            }`}
          >
            {formatCents(balance)}
          </span>
        </td>

        <td className="row-cell w-32 pr-1">
          <span className="money block text-quiet text-faint">
            {row.amountToDelegateCents === null
              ? '—'
              : formatCents(BigInt(row.amountToDelegateCents))}
          </span>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-line last:border-0">
          <td colSpan={3} className="bg-surface px-1 py-2">
            {/*
              One line, in the order the Budget page reads: what it is called,
              where it sits, whether it is a utility, and what it gets. The note
              is the only thing that needs its own line, and one line is enough
              for "$2,200, Dec 27".
            */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label={`Name of ${row.name}`}
                className="min-w-40 flex-1 rounded border border-line bg-canvas px-2 py-1 text-quiet text-ink"
              />

              <select
                value={row.groupingId ?? ''}
                onChange={(event) =>
                  update.mutate({
                    groupingId: event.target.value === '' ? null : event.target.value,
                  })
                }
                aria-label={`Grouping for ${row.name}`}
                className="w-40 rounded border border-line bg-canvas px-2 py-1 text-quiet text-ink"
              >
                <option value="">No grouping</option>
                {groupings.map((grouping) => (
                  <option key={grouping.id} value={grouping.id}>
                    {grouping.name}
                  </option>
                ))}
              </select>

              <label className="flex shrink-0 items-center gap-2 text-quiet text-ink">
                <Toggle
                  checked={row.isUtility}
                  onChange={(next) => update.mutate({ isUtility: next })}
                  label={`${row.name} is a utility`}
                />
                Utility
              </label>

              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="Ad hoc"
                aria-label={`Amount to delegate for ${row.name}`}
                title="Leave empty for an ad-hoc line, which receives nothing when Delegate is pressed. That is not the same as zero."
                className="money w-28 rounded border border-line bg-canvas px-2 py-1 text-quiet text-ink"
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
                placeholder="Note — $2,200, Dec 27"
                aria-label={`Note for ${row.name}`}
                className="min-w-40 flex-1 rounded border border-line bg-canvas px-2 py-1 text-quiet text-ink"
              />

              <Button variant="primary" onClick={save} disabled={update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="danger"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
                aria-label={`Archive ${row.name}`}
              >
                Archive
              </Button>
            </div>

            {problem && (
              <div className="mt-2">
                <Alert>{problem}</Alert>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function allDelegations(view: BudgetViewDto): readonly BudgetRowDto[] {
  return [
    ...view.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...view.delegations.ungrouped,
  ];
}

export function DelegationsSection(): ReactNode {
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const rows = view.data ? allDelegations(view.data) : [];
  const groupings =
    view.data?.delegations.groupings.map((grouping) => ({
      id: grouping.id,
      name: grouping.name,
    })) ?? [];

  return (
    <SettingsCard
      title="Delegations"
      description="Every envelope and everything about it. The same settings as the row menu on the Budget page."
    >
      {view.isLoading ? (
        <p className="text-quiet text-muted">Loading delegations…</p>
      ) : rows.length === 0 ? (
        <p className="text-quiet text-muted">
          No delegations yet. Add them inline on the Budget page — it is much faster for sixty of
          them.
        </p>
      ) : (
        <table className="w-full table-fixed border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
              <th className="row-cell pl-1 text-left font-normal">Delegation</th>
              <th className="row-cell w-36 pr-2 text-right font-normal">Remaining</th>
              <th className="row-cell w-32 pr-1 text-right font-normal text-faint">To delegate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <DelegationRow row={row} groupings={groupings} />
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </SettingsCard>
  );
}
