import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  budgetApi,
  type BudgetRowDto,
  type BudgetSectionDto,
  type BudgetViewDto,
} from '../api/budget.js';
import { accountsApi } from '../api/accounts.js';
import { ApiError } from '../api/client.js';
import { AccountRowMenu } from '../components/AccountRowMenu.jsx';
import { useBudgetLayout } from '../budget-layout.js';
import { PageHeader } from '../components/layout.jsx';
import { BudgetSection } from '../components/BudgetSection.jsx';
import { DelegationsTable } from '../components/DelegationsTable.jsx';
import { Alert } from '../components/ui.jsx';

/**
 * The Budget page — the page that replaces the spreadsheet.
 *
 * Every mutation invalidates the whole view rather than patching a row locally.
 * The identity at the top depends on all three sections at once, so a partial
 * update would leave the headline figure disagreeing with the rows beneath it,
 * which is the one thing this page cannot do.
 */

export function MainBudget(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  // Chosen on Settings → Display and remembered per device. Read here rather
  // than passed down: it decides only where the three sections sit, and no
  // section needs to know which arrangement it is in.
  const [budgetLayout] = useBudgetLayout();

  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Something went wrong.');

  /**
   * Accounts and groupings, put where somebody dropped them.
   *
   * Assets and Debts are ordered lists too. The order the household reads its
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
   * thumb. The section is passed in because Assets and Debts are separate lists.
   */
  function nudgeAccount(
    section: {
      groupings: readonly { id: string; rows: readonly BudgetRowDto[] }[];
      ungrouped: readonly BudgetRowDto[];
    },
    row: { id: string; groupingId?: string | null | undefined },
    direction: -1 | 1,
  ): void {
    const groupingId = row.groupingId ?? null;
    const siblings =
      groupingId === null
        ? section.ungrouped
        : (section.groupings.find((grouping) => grouping.id === groupingId)?.rows ?? []);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeAccount.mutate({ id: row.id, groupingId, orderedIds });
  }

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the budget…</p>;
  if (view.error || !view.data) {
    return <Alert>Could not load the budget. {String(view.error ?? '')}</Alert>;
  }

  const groupingOptionsFor = (section: {
    groupings: readonly { id: string; name: string }[];
  }): { id: string; name: string }[] =>
    section.groupings.map((grouping) => ({ id: grouping.id, name: grouping.name }));

  /**
   * Delegations, built once and placed by the layout.
   *
   * The table, the row menu, the editable figures and every dialog behind them
   * are `DelegationsTable`'s — the same component the Overview band draws, so
   * the two surfaces cannot come to disagree about a budget.
   */
  const delegationsSection = <DelegationsTable view={view.data} onProblem={setProblem} />;

  return (
    <div>
      {/*
        Title and nothing else.

        Delegate and the undo that replaces it were the only things here, and
        they are in the sidebar now — above Sync, under the reading they act on.
        Neither was a fact about this page: they are acts on the household, which
        is the argument ADR 059 already used to move the alerts out of the header.
      */}
      <PageHeader title="Budget" />

      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {/*
        Two arrangements of the same three sections, chosen on Settings →
        Display and stored per device (`useBudgetLayout`).

        The DOM order is the *column* order — Delegations, then the accounts —
        and the grid is what puts them side by side from `lg`. Below that the
        grid does not apply and the sections stack in the order they are written,
        which is the order this arrangement wants on a phone anyway: the
        envelopes first, because they are what somebody came to work through.
      */}
      <div
        className={
          budgetLayout === 'columns'
            ? 'lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-6'
            : undefined
        }
      >
        {budgetLayout === 'columns' && delegationsSection}

        <div className="flex flex-col gap-6">
          <BudgetSection
            title="Assets"
            section={view.data.assets}
            showAmountToDelegate={false}
            redNegatives={false}
            onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
            onMoveToGrouping={(rowId, groupingId) => moveAccount.mutate({ id: rowId, groupingId })}
            onPlace={(rowId, groupingId, orderedIds) =>
              placeAccount.mutate({ id: rowId, groupingId, orderedIds })
            }
            onReorderGroupings={(groupingIds) =>
              reorderGroupings.mutate({ section: 'assets', groupingIds })
            }
            rowMenu={(row) => (
              <AccountRowMenu
                row={row}
                groupings={groupingOptionsFor(view.data.assets)}
                onNudge={(target, direction) => nudgeAccount(view.data.assets, target, direction)}
              />
            )}
          />

          {/* Debts render in normal text, never red, despite being liabilities. */}
          <BudgetSection
            title="Debts"
            section={view.data.debts}
            showAmountToDelegate={false}
            redNegatives={false}
            onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
            onMoveToGrouping={(rowId, groupingId) => moveAccount.mutate({ id: rowId, groupingId })}
            onPlace={(rowId, groupingId, orderedIds) =>
              placeAccount.mutate({ id: rowId, groupingId, orderedIds })
            }
            onReorderGroupings={(groupingIds) =>
              reorderGroupings.mutate({ section: 'debts', groupingIds })
            }
            rowMenu={(row) => (
              <AccountRowMenu
                row={row}
                groupings={groupingOptionsFor(view.data.debts)}
                onNudge={(target, direction) => nudgeAccount(view.data.debts, target, direction)}
              />
            )}
          />
        </div>

        {budgetLayout === 'stacked' && delegationsSection}
      </div>
    </div>
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
