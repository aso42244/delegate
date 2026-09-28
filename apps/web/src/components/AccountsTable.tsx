import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  budgetApi,
  type BudgetRowDto,
  type BudgetSectionDto,
  type BudgetViewDto,
} from '../api/budget.js';
import { accountsApi } from '../api/accounts.js';
import { ApiError } from '../api/client.js';
import { AccountRowMenu } from './AccountRowMenu.jsx';
import { BudgetSection } from './BudgetSection.jsx';
import { restoreHidden } from './account-order.js';
import { Alert } from './ui.jsx';

/**
 * Assets and Debts, in their groupings, and everything that can be done to a row
 * in them.
 *
 * The sibling of `DelegationsTable` and for the same reason it gives: there are
 * two places a household works on its accounts — the Budget page and the band at
 * the top of Overview — and two renderings of one arrangement is exactly how two
 * screens come to disagree about a budget.
 *
 * Until ADR 068 the band drew its own flat list of name and balance: no
 * grouping, no row menu, no handle. That was the whole of what the Budget page
 * still had over Overview, and it was the reason ADR 067's trial could not end
 * in deleting the page. It is this component on both screens now, and the two
 * differ in the props below and nothing else.
 *
 * It reads and writes `['budget']` — the same cache entry both surfaces already
 * use — so two of these on one screen would be two views of one answer.
 */
export function AccountsTable({
  view,
  arrangement = 'stacked',
  onlyWithBalance = false,
  onProblem,
}: {
  readonly view: BudgetViewDto;
  /**
   * Whether the two sections sit one above the other or side by side.
   *
   * Stated rather than measured, because the Budget page's own columns/stacked
   * preference already decides how much room these get and a container query
   * here would fight it: in that page's `columns` arrangement these share two
   * fifths of the width, and a grid that split them again would give each a
   * fifth. The band is the full width of the page and has room for both.
   */
  readonly arrangement?: 'stacked' | 'side-by-side';
  /**
   * Hide accounts sitting at exactly zero, and any grouping left empty by that.
   *
   * The band's "With balance" filter. An account at zero is one nothing can be
   * decided about and a closed-but-not-archived card is the commonest of them —
   * but it is a *display* filter only: what gets written back is always the
   * whole order, rebuilt by `fullOrderAfterMove`, because the endpoints take an
   * ordering rather than a diff.
   *
   * No total moves under it. Every figure on screen — the section's and each
   * grouping's — is computed by the server and carried on the DTO, so hiding a
   * row cannot change a sum even by accident. That is worth knowing rather than
   * relying on: hiding a row that changed a total would be a lie.
   */
  readonly onlyWithBalance?: boolean;
  /** Where a failed write is reported. The caller owns the space it takes. */
  readonly onProblem?: (message: string | null) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setLocalProblem] = useState<string | null>(null);

  const report = (message: string | null): void => {
    setLocalProblem(message);
    onProblem?.(message);
  };

  const onError = (error: unknown): void =>
    report(error instanceof ApiError ? error.message : 'Something went wrong.');

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  /**
   * Accounts and groupings, put where somebody dropped them.
   *
   * Assets and Debts are ordered lists. The order the household reads its
   * accounts in is a fact about the household, and alphabetical is nobody's
   * reading of it — the argument that gave delegations a position in the first
   * place, one level across.
   */
  const moveAccount = useMutation({
    mutationFn: ({ id, groupingId }: { id: string; groupingId: string | null }) =>
      accountsApi.update(id, { groupingId }),
    onSuccess: refresh,
    onError,
  });

  const placeAccount = useMutation({
    mutationFn: ({
      id,
      groupingId,
      orderedIds,
    }: {
      id: string;
      groupingId: string | null;
      orderedIds: string[];
    }) => budgetApi.placeAccount(id, groupingId, orderedIds),
    onSuccess: refresh,
    onError,
  });

  const reorderGroupings = useMutation({
    mutationFn: ({
      section,
      groupingIds,
    }: {
      section: 'assets' | 'debts';
      groupingIds: string[];
    }) => budgetApi.reorderGroupings(section, groupingIds),
    onSuccess: refresh,
    onError,
  });

  /**
   * Folding a grouping moves rows, not money, so the cache leads and the request
   * follows. Delegations' own copy of this lives in `DelegationsTable`; this one
   * is for the two account sections, which that component does not draw.
   */
  const toggleGrouping = useMutation({
    mutationFn: ({ id, collapsed }: { id: string; collapsed: boolean }) =>
      budgetApi.setGroupingCollapsed(id, collapsed),
    onMutate: async ({ id, collapsed }: { id: string; collapsed: boolean }) => {
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
   * Moves an account one place, for anybody not using a mouse.
   *
   * Dragging is the fast way and it is not an accessible one, so this is not a
   * lesser alternative — it is the one that always works, including under a
   * thumb. It nudges within the **unfiltered** list for the same reason
   * `fullOrderAfterMove` exists: a nudge that stepped over a hidden row would
   * appear to do nothing.
   */
  function nudgeAccount(
    section: BudgetSectionDto,
    row: { id: string; groupingId?: string | null | undefined },
    direction: -1 | 1,
  ): void {
    const groupingId = row.groupingId ?? null;
    const siblings = siblingsOf(section, groupingId);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeAccount.mutate({ id: row.id, groupingId, orderedIds });
  }

  const groupingOptionsFor = (section: BudgetSectionDto): { id: string; name: string }[] =>
    section.groupings.map((grouping) => ({ id: grouping.id, name: grouping.name }));

  /**
   * One section, wired to the three writes and the filter.
   *
   * `full` is what the server said; `shown` is what this draws. Every handler
   * closes over `full`, so the filter can never narrow what is written.
   */
  const renderSection = (title: string, full: BudgetSectionDto): ReactNode => {
    const shown = onlyWithBalance ? withoutEmptyRows(full) : full;

    return (
      <BudgetSection
        title={title}
        section={shown}
        showAmountToDelegate={false}
        /* Debts render in normal text, never red, despite being liabilities. */
        redNegatives={false}
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
        onMoveToGrouping={(rowId, groupingId) => moveAccount.mutate({ id: rowId, groupingId })}
        onPlace={(rowId, groupingId, orderedIds) =>
          placeAccount.mutate({
            id: rowId,
            groupingId,
            orderedIds: restoreHidden(
              siblingsOf(full, groupingId).map((sibling) => sibling.id),
              orderedIds,
            ),
          })
        }
        onReorderGroupings={(groupingIds) =>
          reorderGroupings.mutate({
            section: full.section === 'debts' ? 'debts' : 'assets',
            groupingIds: restoreHidden(movableGroupingIds(full), groupingIds),
          })
        }
        rowMenu={(row) => (
          <AccountRowMenu
            row={row}
            groupings={groupingOptionsFor(full)}
            onNudge={(target, direction) => nudgeAccount(full, target, direction)}
          />
        )}
      />
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {problem && <Alert>{problem}</Alert>}
      <div
        className={
          arrangement === 'side-by-side'
            ? // A container query, because this asks how wide the band is rather
              // than how wide the window is (`ui-system.md` §2). Two grouped
              // sections need real width; below it they stack.
              'grid grid-cols-1 gap-6 @3xl:grid-cols-2 @3xl:items-start'
            : 'flex flex-col gap-6'
        }
      >
        {renderSection('Assets', view.assets)}
        {renderSection('Debts', view.debts)}
      </div>
    </div>
  );
}

/** Every row of one grouping, or the ungrouped ones, in the order held. */
function siblingsOf(section: BudgetSectionDto, groupingId: string | null): readonly BudgetRowDto[] {
  if (groupingId === null) return section.ungrouped;
  return section.groupings.find((grouping) => grouping.id === groupingId)?.rows ?? [];
}

/**
 * The groupings a person can move, in order.
 *
 * The application's own are excluded, exactly as `BudgetSection` excludes them
 * when it builds an order: an outstanding-checks heading sorts last by rule, and
 * `reorderGroupings` refuses a list that names one.
 */
function movableGroupingIds(section: BudgetSectionDto): string[] {
  return section.groupings
    .filter((grouping) => grouping.systemKey === null)
    .map((grouping) => grouping.id);
}

/**
 * The same section with every zero-balance row dropped, and any grouping the
 * filter emptied dropped with it.
 *
 * An empty grouping under the filter is a heading over nothing — the noise the
 * filter exists to remove. Every total is left exactly as the server sent it,
 * which is safe here for a reason worth stating rather than assuming: a row at
 * zero contributes zero to a balance, and a balance is the only figure these two
 * sections carry.
 */
function withoutEmptyRows(section: BudgetSectionDto): BudgetSectionDto {
  const hasBalance = (row: BudgetRowDto): boolean => BigInt(row.balanceCents ?? '0') !== 0n;

  return {
    ...section,
    groupings: section.groupings
      .map((grouping) => ({ ...grouping, rows: grouping.rows.filter(hasBalance) }))
      .filter((grouping) => grouping.rows.length > 0),
    ungrouped: section.ungrouped.filter(hasBalance),
  };
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
