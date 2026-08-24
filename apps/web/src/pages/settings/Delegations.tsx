import { formatCents, formatCentsForInput, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto, type BudgetViewDto } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { Chip } from '../../components/Chip.jsx';
import { Alert, Button, SelectField, TextArea, TextField, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Delegations.
 *
 * Every per-delegation setting, mirroring the row menu on the Budget page —
 * §9.5 requires that anything configurable elsewhere is configurable here too.
 * The difference is shape rather than capability: the row menu is for one line
 * in passing, this is for working down all sixty.
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
  const [saved, setSaved] = useState(false);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const onError = (error: unknown): void => {
    setSaved(false);
    setProblem(error instanceof ApiError ? error.message : 'Could not save this delegation.');
  };

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

    setSaved(true);
    update.mutate({
      name: name.trim(),
      amountToDelegateCents,
      notes: notes.trim() === '' ? null : notes.trim(),
    });
  }

  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="min-w-48 flex-1 text-left text-ink"
        >
          <span aria-hidden className="mr-2 text-muted">
            {expanded ? '▾' : '▸'}
          </span>
          {row.name}
          {row.isUtility && (
            <span className="ml-2 inline-flex align-middle">
              <Chip kind="utility" />
            </span>
          )}
        </button>

        <span
          className={`money w-32 text-right ${
            BigInt(row.balanceCents) < 0n ? 'font-semibold text-negative' : 'text-ink'
          }`}
        >
          {formatCents(BigInt(row.balanceCents))}
        </span>

        <span className="money w-28 text-right text-quiet text-faint">
          {row.amountToDelegateCents === null
            ? '—'
            : formatCents(BigInt(row.amountToDelegateCents))}
        </span>
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 rounded-lg bg-surface p-3">
          <TextField
            label={`Name of ${row.name}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          <TextField
            label={`Amount to delegate for ${row.name}`}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            className="money"
            hint="Leave empty for an ad-hoc line, which receives nothing when Delegate is pressed. That is not the same as zero."
          />

          <TextArea
            label={`Note for ${row.name}`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="$2,200, Dec 27"
          />

          <SelectField
            label={`Grouping for ${row.name}`}
            value={row.groupingId ?? ''}
            onChange={(value) => update.mutate({ groupingId: value === '' ? null : value })}
          >
            <option value="">No grouping</option>
            {groupings.map((grouping) => (
              <option key={grouping.id} value={grouping.id}>
                {grouping.name}
              </option>
            ))}
          </SelectField>

          <label className="flex items-center gap-2 text-quiet text-ink">
            <Toggle
              checked={row.isUtility}
              onChange={(next) => update.mutate({ isUtility: next })}
              label={`${row.name} is a utility`}
            />
            Utility
          </label>

          {problem && <Alert>{problem}</Alert>}
          {saved && !problem && !update.isPending && <Alert tone="positive">Saved.</Alert>}

          <div className="flex gap-2">
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
        </div>
      )}
    </div>
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
        <div>
          {rows.map((row) => (
            <DelegationRow key={row.id} row={row} groupings={groupings} />
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
