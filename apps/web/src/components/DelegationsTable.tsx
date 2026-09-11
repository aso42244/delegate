import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  budgetApi,
  type BudgetRowDto,
  type BudgetSectionDto,
  type BudgetViewDto,
} from '../api/budget.js';
import { checksApi, type CheckMatchDto } from '../api/checks.js';
import { settingsApi } from '../api/settings.js';
import { ApiError } from '../api/client.js';
import { AbsorbDialog } from './AbsorbDialog.jsx';
import { BudgetSection } from './BudgetSection.jsx';
import { CheckRowMenu } from './CheckRowMenu.jsx';
import { ConfirmCheckMatchDialog } from './ConfirmCheckMatchDialog.jsx';
import { DelegationRowMenu } from './DelegationRowMenu.jsx';
import { TransferDialog } from './TransferDialog.jsx';
import { Alert } from './ui.jsx';

/**
 * The delegations table, and everything that can be done to a line in it.
 *
 * It is one component because there are now two places a household works on its
 * envelopes — the Budget page, and the band at the top of Overview — and two
 * renderings of one table is exactly how two screens come to disagree about a
 * budget. Everything that decides what a row *is* lives here: the editable
 * figures, the row menu, dragging, folding a grouping, closing the reading
 * against a line, confirming a cheque the bank appears to have cashed.
 *
 * What the two surfaces differ in is stated as props and nothing else:
 *
 * - **`pace`** draws a bar between the name and the figures. The band passes one
 *   because it knows this cycle's spending; the Budget page passes nothing and
 *   gets the table it has always had.
 * - **`only`** narrows the table to the lines somebody chose to watch. The band
 *   in "Show selected" passes them; everything else passes nothing and gets the
 *   whole budget, grouped and foldable.
 *
 * It reads `['budget']` — the same cache entry the Budget page has always used —
 * so two of these on one screen would be two views of one answer rather than two
 * answers.
 */
export function DelegationsTable({
  view,
  pace,
  only,
  onProblem,
}: {
  readonly view: BudgetViewDto;
  readonly pace?: (row: BudgetRowDto) => ReactNode;
  /**
   * The chosen lines, flattened out of their groupings.
   *
   * `null` is the whole budget. An empty array is a deliberate choice of
   * nothing, which is not the same thing and must not fall back to everything.
   */
  readonly only?: readonly string[] | null;
  /** Where a failed write is reported. The caller owns the space it takes. */
  readonly onProblem?: (message: string | null) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setLocalProblem] = useState<string | null>(null);
  /** The line the budget's reading is being closed against, if any. */
  const [absorbing, setAbsorbing] = useState<BudgetRowDto | null>(null);
  /** The proposed check match being confirmed, if any. */
  const [confirmingCheck, setConfirmingCheck] = useState<CheckMatchDto | null>(null);
  /** Set when Transfer was opened from a line whose archive was blocked. */
  const [transferFrom, setTransferFrom] = useState<string | null>(null);

  /*
   * The pay cadence, for a target's per-paycheck figure. The same cache key
   * Settings uses, so this is a read of what is already there rather than a
   * second request.
   */
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const cadence = settings.data?.payCadence ?? 'biweekly';

  /*
   * Checks the bank appears to have cashed. A sync proposes these and never
   * settles them — ADR 030 — so the row has to offer the confirmation.
   */
  const checkMatches = useQuery({ queryKey: ['checkMatches'], queryFn: checksApi.matches });
  const matchByCheckId = new Map(
    (checkMatches.data?.matches ?? []).map((match) => [match.checkId, match]),
  );

  const report = (message: string | null): void => {
    setLocalProblem(message);
    onProblem?.(message);
  };

  const onError = (error: unknown): void =>
    report(error instanceof ApiError ? error.message : 'Something went wrong.');

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  const editAmount = useMutation({
    mutationFn: ({ id, cents }: { id: string; cents: bigint }) =>
      budgetApi.updateDelegation(id, { amountToDelegateCents: cents.toString() }),
    onSuccess: refresh,
    onError,
  });

  const editBalance = useMutation({
    // The server records the difference as an adjust event; the UI never sends a
    // delta it worked out itself.
    mutationFn: ({ id, cents }: { id: string; cents: bigint }) =>
      budgetApi.adjustDelegation(id, cents.toString()),
    onSuccess: refresh,
    onError,
  });

  const moveDelegation = useMutation({
    mutationFn: ({ id, groupingId }: { id: string; groupingId: string | null }) =>
      budgetApi.updateDelegation(id, { groupingId }),
    onSuccess: refresh,
    onError,
  });

  const placeDelegation = useMutation({
    mutationFn: ({
      id,
      groupingId,
      orderedIds,
    }: {
      id: string;
      groupingId: string | null;
      orderedIds: string[];
    }) => budgetApi.place(id, groupingId, orderedIds),
    onSuccess: refresh,
    onError,
  });

  const createDelegation = useMutation({
    mutationFn: (name: string) => budgetApi.createDelegation(name, null),
    onSuccess: refresh,
    onError,
  });

  const reorderGroupings = useMutation({
    mutationFn: (groupingIds: string[]) => budgetApi.reorderGroupings('delegations', groupingIds),
    onSuccess: refresh,
    onError,
  });

  const toggleGrouping = useMutation({
    mutationFn: ({ id, collapsed }: { id: string; collapsed: boolean }) =>
      budgetApi.setGroupingCollapsed(id, collapsed),
    onMutate: async ({ id, collapsed }: { id: string; collapsed: boolean }) => {
      // An in-flight refetch would land on top of this and undo it.
      await queryClient.cancelQueries({ queryKey: ['budget'] });
      const previous = queryClient.getQueryData<BudgetViewDto>(['budget']);
      queryClient.setQueryData<BudgetViewDto>(['budget'], (current) =>
        current ? withGroupingCollapsed(current, id, collapsed) : current,
      );
      return { previous };
    },
    onError: (error: unknown, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['budget'], context.previous);
      onError(error);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
  });

  /**
   * Moves a line one place, for anybody not using a mouse.
   *
   * Drag and drop is the fast route and it is not a keyboard one, so this is the
   * same operation reached from the row menu. The neighbour list is worked out
   * from the **whole** budget rather than from whatever the band is showing:
   * moving a line up inside a filtered list has to mean the same thing it means
   * on the Budget page, or the two surfaces would order one budget differently.
   */
  function nudge(row: BudgetRowDto, direction: -1 | 1): void {
    const siblings =
      row.groupingId === null
        ? view.delegations.ungrouped
        : (view.delegations.groupings.find((grouping) => grouping.id === row.groupingId)?.rows ??
          []);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeDelegation.mutate({ id: row.id, groupingId: row.groupingId, orderedIds });
  }

  const groupingOptions = view.delegations.groupings.map((grouping) => ({
    id: grouping.id,
    name: grouping.name,
  }));

  /*
   * The reading at the top of the page, which decides whether the per-row button
   * appears at all and which direction it offers. Exactly zero is the one case
   * with nothing to do — and it is a real case, because closing the difference
   * against a line is what produces it.
   */
  const difference = BigInt(view.identity.differenceCents);
  const absorbOffer =
    difference === 0n
      ? {}
      : {
          onAbsorb: setAbsorbing,
          absorbLabel: difference > 0n ? 'Move surplus here' : 'Fix deficit from here',
        };

  const section = only == null ? view.delegations : chosenOnly(view.delegations, only);

  /*
   * Which colour each flattened line came from.
   *
   * Built from the grouping it was filed under, because the row itself does not
   * carry one — `BudgetRowDto` has never needed it while every coloured row was
   * drawn inside the grouping that gave it the colour.
   */
  const tintById = new Map<string, string | null>();
  for (const grouping of view.delegations.groupings) {
    for (const row of grouping.rows) tintById.set(row.id, grouping.color);
  }

  return (
    <>
      {problem !== null && onProblem === undefined && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      <BudgetSection
        title="Delegations"
        section={section}
        showAmountToDelegate
        redNegatives
        {...(only == null
          ? // The inline "name, then Enter" row: offered on the whole table and
            // withheld from the filtered one, because a line created under a
            // list narrowed to the chosen few would be made and then immediately
            // invisible — which reads as the create having failed.
            { onCreate: (name: string) => createDelegation.mutate(name) }
          : {})}
        {...(pace ? { pace } : {})}
        {...(only == null ? {} : { tintFor: (row: BudgetRowDto) => tintById.get(row.id) ?? null })}
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
        onEditAmount={(id, cents) => editAmount.mutate({ id, cents })}
        onEditBalance={(id, cents) => editBalance.mutate({ id, cents })}
        onMoveToGrouping={(rowId, groupingId) => moveDelegation.mutate({ id: rowId, groupingId })}
        onPlace={(rowId, groupingId, orderedIds) =>
          placeDelegation.mutate({ id: rowId, groupingId, orderedIds })
        }
        onReorderGroupings={(groupingIds) => reorderGroupings.mutate(groupingIds)}
        {...absorbOffer}
        rowAffordance={(row) => {
          const match = matchByCheckId.get(row.id);
          if (row.kind !== 'check' || !match) return null;
          return (
            <button
              type="button"
              onClick={() => setConfirmingCheck(match)}
              className="rounded border border-confirm-line bg-confirm-soft px-1.5 py-0.5 text-label font-semibold whitespace-nowrap text-confirm hover:brightness-95"
            >
              Confirm it cleared
            </button>
          );
        }}
        rowMenu={(row) =>
          // A check is not a delegation to rename, re-file or adjust; its menu
          // offers only what the bank can decide.
          row.kind === 'check' ? (
            <CheckRowMenu row={row} />
          ) : (
            <DelegationRowMenu
              row={row}
              groupings={groupingOptions}
              cadence={cadence}
              onNudge={nudge}
              {...absorbOffer}
              onTransferFrom={(delegationId) => setTransferFrom(delegationId)}
            />
          )
        }
      />

      {absorbing && (
        <AbsorbDialog
          row={absorbing}
          differenceCents={difference}
          onClose={() => setAbsorbing(null)}
          onProblem={report}
        />
      )}

      {confirmingCheck && (
        <ConfirmCheckMatchDialog match={confirmingCheck} onClose={() => setConfirmingCheck(null)} />
      )}

      {transferFrom !== null && (
        <TransferDialog
          section={view.delegations}
          initialFrom={transferFrom}
          onClose={() => setTransferFrom(null)}
        />
      )}
    </>
  );
}

/** The same view with one grouping folded or unfolded, and nothing else touched. */
function withGroupingCollapsed(
  view: BudgetViewDto,
  groupingId: string,
  collapsed: boolean,
): BudgetViewDto {
  const inSection = (section: BudgetSectionDto): BudgetSectionDto => ({
    ...section,
    groupings: section.groupings.map((grouping) =>
      grouping.id === groupingId ? { ...grouping, collapsed } : grouping,
    ),
  });

  return {
    ...view,
    assets: inSection(view.assets),
    debts: inSection(view.debts),
    delegations: inSection(view.delegations),
  };
}

/**
 * The chosen lines, as one flat list in the budget's own order.
 *
 * **Flattened rather than filtered in place.** Eight watched lines spread over
 * six groupings is six headings and eight rows, which spends more of the band on
 * saying where a line lives than on what is in it — and the reader already knows
 * where these live, because they chose them one at a time. Each row keeps its
 * grouping's colour, which is how a line is found in a column anyway.
 *
 * The order is the budget's: grouping position, then the line's. Not the order
 * they were picked in, which is nobody's reading of a budget.
 *
 * The totals are recomputed over what is shown. A band that totalled the whole
 * budget under a list of eight lines would be stating a figure none of the rows
 * above it add up to.
 */
function chosenOnly(section: BudgetSectionDto, chosen: readonly string[]): BudgetSectionDto {
  const wanted = new Set(chosen);
  const rows = [
    ...section.groupings.flatMap((grouping) => grouping.rows),
    ...section.ungrouped,
  ].filter((row) => wanted.has(row.id));

  const sum = (pick: (row: BudgetRowDto) => string | null): bigint =>
    rows.reduce((total, row) => {
      const value = pick(row);
      return value === null ? total : total + BigInt(value);
    }, 0n);

  return {
    ...section,
    groupings: [],
    ungrouped: rows,
    totalBalanceCents: sum((row) => row.balanceCents).toString(),
    totalAmountToDelegateCents: sum((row) => row.amountToDelegateCents).toString(),
  };
}
