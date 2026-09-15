import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { useBudgetLayout } from '../budget-layout.js';
import { PageHeader } from '../components/layout.jsx';
import { AccountsTable } from '../components/AccountsTable.jsx';
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
  const [problem, setProblem] = useState<string | null>(null);

  // Chosen on Settings → Display and remembered per device. Read here rather
  // than passed down: it decides only where the three sections sit, and no
  // section needs to know which arrangement it is in.
  const [budgetLayout] = useBudgetLayout();

  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the budget…</p>;
  if (view.error || !view.data) {
    return <Alert>Could not load the budget. {String(view.error ?? '')}</Alert>;
  }

  /**
   * Both tables, built once and placed by the layout.
   *
   * Everything either one draws — the row menus, the editable figures, the
   * groupings, dragging, and every dialog behind them — belongs to
   * `DelegationsTable` and `AccountsTable`, which are the same two components
   * the Overview band draws. Two renderings of one budget is how two screens
   * come to disagree about it, so there is one of each.
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

        <AccountsTable view={view.data} onProblem={setProblem} />

        {budgetLayout === 'stacked' && delegationsSection}
      </div>
    </div>
  );
}
