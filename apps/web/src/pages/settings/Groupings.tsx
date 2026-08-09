import { GROUPING_COLORS } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetGroupingDto, type BudgetViewDto } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Groupings.
 *
 * Groupings are organizational only: a name and a section. They hold no balance
 * and no amount to delegate of their own — collapsed, a grouping row shows the
 * sum of its children, and that sum is computed rather than stored.
 *
 * Colour is chosen from a curated palette rather than a colour picker. §11 asks
 * that it "must not be in your face", and an arbitrary picker is how a dense
 * financial table ends up with a magenta row. Every delegation inside a grouping
 * inherits it; there is no per-delegation colour.
 */

type Section = 'assets' | 'debts' | 'delegations';

const SECTION_LABELS: Record<Section, string> = {
  assets: 'Assets',
  debts: 'Debts',
  delegations: 'Delegations',
};

function GroupingRow({
  grouping,
  section,
}: {
  readonly grouping: BudgetGroupingDto;
  readonly section: Section;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState(grouping.name);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['archived'] });
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Could not update this grouping.');

  const rename = useMutation({
    mutationFn: () => budgetApi.updateGrouping(grouping.id, { name: name.trim() }),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const recolour = useMutation({
    mutationFn: (color: string | null) => budgetApi.updateGrouping(grouping.id, { color }),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const archive = useMutation({
    mutationFn: () => budgetApi.archiveGrouping(grouping.id),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    // Blocked unless it holds nothing live, so archiving cannot orphan a row.
    onError,
  });

  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name.trim() !== '' && name.trim() !== grouping.name) rename.mutate();
            }}
            aria-label={`Name of ${grouping.name}`}
            className="w-full rounded border border-transparent bg-transparent px-2 py-1 text-base text-ink hover:border-line focus:border-accent focus:bg-canvas"
          />
        </div>

        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
          {SECTION_LABELS[section]}
        </span>

        {/* Each swatch names its colour, so the choice is not carried by colour
            alone for anyone who cannot see the difference. */}
        <div className="flex items-center gap-1">
          {GROUPING_COLORS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => recolour.mutate(option.value)}
              aria-label={`${option.name} for ${grouping.name}`}
              aria-pressed={grouping.color === option.value}
              className={`h-5 w-5 rounded-[4px] border ${
                grouping.color === option.value ? 'border-ink' : 'border-line'
              }`}
              style={{ background: option.value }}
            />
          ))}
          <button
            type="button"
            onClick={() => recolour.mutate(null)}
            aria-label={`No colour for ${grouping.name}`}
            aria-pressed={grouping.color === null}
            className={`h-5 rounded-[4px] border px-1 text-label ${
              grouping.color === null ? 'border-ink text-ink' : 'border-line text-muted'
            }`}
          >
            None
          </button>
        </div>

        <span className="text-quiet text-muted">
          {grouping.rows.length} {grouping.rows.length === 1 ? 'line' : 'lines'}
        </span>

        <Button
          variant="danger"
          onClick={() => archive.mutate()}
          disabled={archive.isPending}
          aria-label={`Archive ${grouping.name}`}
        >
          Archive
        </Button>
      </div>

      {problem && (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      )}
    </div>
  );
}

function AddGroupingForm(): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [section, setSection] = useState<Section>('delegations');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => budgetApi.createGrouping(name.trim(), section),
    onSuccess: async () => {
      setName('');
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the grouping.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3 rounded-lg bg-surface p-3">
      <TextField
        label="New grouping"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Essentials"
        autoComplete="off"
      />

      <SelectField
        label="Section"
        value={section}
        onChange={(value) => setSection(value as Section)}
      >
        {Object.entries(SECTION_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      {problem && <Alert>{problem}</Alert>}

      <div>
        <Button type="submit" variant="primary" disabled={name.trim() === '' || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add grouping'}
        </Button>
      </div>
    </form>
  );
}

function sectionsOf(
  view: BudgetViewDto,
): { section: Section; groupings: readonly BudgetGroupingDto[] }[] {
  return [
    { section: 'assets', groupings: view.assets.groupings },
    { section: 'debts', groupings: view.debts.groupings },
    { section: 'delegations', groupings: view.delegations.groupings },
  ];
}

export function GroupingsSection(): ReactNode {
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const sections = view.data ? sectionsOf(view.data) : [];
  const total = sections.reduce((sum, entry) => sum + entry.groupings.length, 0);

  return (
    <SettingsCard
      title="Groupings"
      description="Organizational only. A grouping has no balance of its own; collapsed, it shows the sum of its lines."
    >
      {view.isLoading ? (
        <p className="text-quiet text-muted">Loading groupings…</p>
      ) : total === 0 ? (
        <p className="text-quiet text-muted">No groupings yet.</p>
      ) : (
        <div>
          {sections.flatMap((entry) =>
            entry.groupings.map((grouping) => (
              <GroupingRow key={grouping.id} grouping={grouping} section={entry.section} />
            )),
          )}
        </div>
      )}

      <AddGroupingForm />
    </SettingsCard>
  );
}
