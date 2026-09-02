import { GROUPING_COLORS, isGroupingColor, isHexColor, normalizeHexColor } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetGroupingDto, type BudgetViewDto } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, Modal, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';
import { EmptyState } from '../../components/layout.jsx';

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
 *
 * The palette used to sit open on every row — seven swatches, a None button, a
 * colour well and a hex field, on each of a dozen rows, for a choice made once
 * and then left alone for months. It is one swatch now, and the rest is behind
 * it.
 */

type Section = 'assets' | 'debts' | 'delegations';

const SECTION_LABELS: Record<Section, string> = {
  assets: 'Assets',
  debts: 'Debts',
  delegations: 'Delegations',
};

/**
 * The current colour, and the whole palette one click away.
 *
 * Closes on Escape and on a click elsewhere, like the row menus — a popover that
 * only closes by choosing something is one that has to be answered.
 */
function ColourPicker({
  grouping,
  onPick,
}: {
  readonly grouping: BudgetGroupingDto;
  readonly onPick: (color: string | null) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const isPreset = grouping.color !== null && isGroupingColor(grouping.color);
  const current = grouping.color ?? '#2783DE';

  function commitHex(value: string): void {
    const hex = normalizeHexColor(value);
    if (isHexColor(hex)) onPick(hex);
    setTyped(null);
  }

  const named =
    GROUPING_COLORS.find((option) => option.value === grouping.color)?.name ??
    (grouping.color === null ? 'No colour' : grouping.color);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Colour for ${grouping.name}: ${named}`}
        className="flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5 hover:bg-surface"
      >
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-[3px] border border-line"
          style={{ background: grouping.color ?? 'transparent' }}
        />
        {/* Named as well as shown, so the choice is never carried by colour
            alone for anyone who cannot see the difference. */}
        <span className="text-label text-muted">{named}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-line bg-canvas p-2 shadow-lg">
          <div className="flex flex-wrap gap-1">
            {GROUPING_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onPick(option.value);
                  setOpen(false);
                }}
                aria-label={`${option.name} for ${grouping.name}`}
                aria-pressed={grouping.color === option.value}
                className={`h-6 w-6 rounded-[4px] border ${
                  grouping.color === option.value ? 'border-ink' : 'border-line'
                }`}
                style={{ background: option.value }}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              aria-label={`No colour for ${grouping.name}`}
              aria-pressed={grouping.color === null}
              className={`h-6 rounded-[4px] border px-1.5 text-label ${
                grouping.color === null ? 'border-ink text-ink' : 'border-line text-muted'
              }`}
            >
              None
            </button>
          </div>

          {/* The presets are a shortcut, not the whole vocabulary. Anyone
              matching a grouping to a colour they already think in should not
              have to settle for the nearest of five. */}
          <div className="mt-2 flex items-center gap-1 border-t border-line pt-2">
            <input
              type="color"
              value={current}
              onChange={(event) => onPick(normalizeHexColor(event.target.value))}
              aria-label={`Custom colour for ${grouping.name}`}
              className={`h-6 w-6 shrink-0 cursor-pointer rounded-[4px] border bg-transparent ${
                grouping.color !== null && !isPreset ? 'border-ink' : 'border-line'
              }`}
            />
            <input
              value={typed ?? grouping.color ?? ''}
              onChange={(event) => setTyped(event.target.value)}
              onBlur={(event) => commitHex(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitHex(event.currentTarget.value);
                if (event.key === 'Escape') setTyped(null);
              }}
              placeholder="#2783DE"
              aria-label={`Colour hex for ${grouping.name}`}
              spellCheck={false}
              className="w-full rounded border border-line bg-canvas px-1 py-0.5 font-mono text-label text-ink"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GroupingRow({
  grouping,
  section,
  first,
  last,
  onMove,
}: {
  readonly grouping: BudgetGroupingDto;
  readonly section: Section;
  /** Whether the arrows have anywhere to go. */
  readonly first: boolean;
  readonly last: boolean;
  readonly onMove: (direction: -1 | 1) => void;
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
    <>
      <tr className="group border-b border-line last:border-0 hover:bg-surface">
        <td className="row-cell pl-1">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              if (name.trim() !== '' && name.trim() !== grouping.name) rename.mutate();
            }}
            aria-label={`Name of ${grouping.name}`}
            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-ink hover:border-line focus:border-accent focus:bg-canvas"
          />
        </td>

        <td className="row-cell w-28 text-quiet text-muted">{SECTION_LABELS[section]}</td>

        <td className="row-cell w-40">
          <ColourPicker grouping={grouping} onPick={(color) => recolour.mutate(color)} />
        </td>

        <td className="row-cell w-20 pr-2 text-right text-quiet text-muted">
          {grouping.rows.length}
        </td>

        <td className="row-cell w-32 pr-1">
          {/*
            The keyboard route to the order that dragging a heading on the
            Budget page also gives. Dragging is the fast way and it is not an
            accessible one, so this is not a lesser alternative — it is the one
            that always works.
          */}
          <div className="row-menu-trigger flex items-center justify-end gap-0.5">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={first}
              aria-label={`Move ${grouping.name} up`}
              className="rounded px-1.5 py-0.5 text-quiet text-muted hover:bg-surface-2 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={last}
              aria-label={`Move ${grouping.name} down`}
              className="rounded px-1.5 py-0.5 text-quiet text-muted hover:bg-surface-2 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
              aria-label={`Archive ${grouping.name}`}
              className="rounded px-1.5 py-0.5 text-label font-semibold text-danger hover:bg-danger-soft"
            >
              Archive
            </button>
          </div>
        </td>
      </tr>

      {problem && (
        <tr>
          <td colSpan={5} className="pb-2">
            <Alert>{problem}</Alert>
          </td>
        </tr>
      )}
    </>
  );
}

function AddGroupingDialog({ onDone }: { readonly onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [section, setSection] = useState<Section>('delegations');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => budgetApi.createGrouping(name.trim(), section),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onDone();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the grouping.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Modal
      label="Create a grouping"
      title="New grouping"
      description="Organizational only. A grouping holds no balance of its own."
      onClose={onDone}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <TextField
          width="full"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Essentials"
          autoComplete="off"
          autoFocus
        />

        <SelectField
          width="full"
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

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
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
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const [adding, setAdding] = useState(false);

  const reorder = useMutation({
    mutationFn: ({ section, groupingIds }: { section: Section; groupingIds: string[] }) =>
      budgetApi.reorderGroupings(section, groupingIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budget'] }),
  });

  const sections = view.data ? sectionsOf(view.data) : [];
  const total = sections.reduce((sum, entry) => sum + entry.groupings.length, 0);

  return (
    <SettingsCard
      title="Groupings"
      description="Organizational only — a grouping has no balance of its own."
      action={<Button onClick={() => setAdding(true)}>New grouping</Button>}
    >
      {view.isLoading ? (
        <p className="text-quiet text-muted">Loading groupings…</p>
      ) : total === 0 ? (
        <EmptyState>No groupings yet.</EmptyState>
      ) : (
        <table className="w-full table-fixed border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
              <th className="row-cell pl-1 text-left font-normal">Grouping</th>
              <th className="row-cell w-28 text-left font-normal">Section</th>
              <th className="row-cell w-40 text-left font-normal">Colour</th>
              <th className="row-cell w-20 pr-2 text-right font-normal">Lines</th>
              <th className="row-cell w-32 pr-1" />
            </tr>
          </thead>
          <tbody>
            {sections.flatMap((entry) => {
              // The application's own groupings are not moved: an
              // outstanding-checks heading sorts last by rule rather than by
              // where anybody put it, so it is not part of the order sent.
              const movable = entry.groupings.filter((grouping) => grouping.systemKey === null);

              return entry.groupings.map((grouping) => {
                const at = movable.findIndex((candidate) => candidate.id === grouping.id);
                return (
                  <GroupingRow
                    key={grouping.id}
                    grouping={grouping}
                    section={entry.section}
                    first={at <= 0}
                    last={at === -1 || at === movable.length - 1}
                    onMove={(direction) => {
                      const to = at + direction;
                      if (at === -1 || to < 0 || to >= movable.length) return;
                      const ids = movable.map((candidate) => candidate.id);
                      ids.splice(to, 0, ...ids.splice(at, 1));
                      reorder.mutate({ section: entry.section, groupingIds: ids });
                    }}
                  />
                );
              });
            })}
          </tbody>
        </table>
      )}

      {adding && <AddGroupingDialog onDone={() => setAdding(false)} />}
    </SettingsCard>
  );
}
