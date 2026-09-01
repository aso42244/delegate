import { useCallback, useSyncExternalStore } from 'react';

/**
 * How the Budget page arranges its three sections.
 *
 * `stacked` is what this page has always done: Assets, Debts, then Delegations,
 * each the full width of the page. It reads top to bottom in the order the
 * identity is written, and on a phone it is the only thing that fits.
 *
 * `columns` puts **Delegations on the left and the accounts on the right**,
 * which is the arrangement for a large screen: the envelopes are what somebody
 * came to the page to work through, and on a wide monitor the account balances
 * had scrolled off the top by the time they got there. Below `lg` it collapses
 * to one column and keeps its own order — Delegations, then Assets, then Debts.
 *
 * **Per device, not per household**, like row height and the theme: this is a
 * fact about the screen someone is looking at. Two columns on a 27-inch monitor
 * should not put two columns on the other person's laptop, where it would only
 * squeeze both.
 *
 * `useSyncExternalStore` rather than `useState`, for the same reason density
 * uses it: the control that changes this lives on a different page from the
 * thing it changes, so every reader has to re-render together.
 */

export type BudgetLayout = 'stacked' | 'columns';

const LAYOUTS: readonly BudgetLayout[] = ['stacked', 'columns'];

/** What an unset or unrecognised stored value means. */
const DEFAULT_LAYOUT: BudgetLayout = 'stacked';

const STORAGE_KEY = 'budget.display.budgetLayout';

const listeners = new Set<() => void>();

function read(): BudgetLayout {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;

  // Anything unrecognised falls back rather than being trusted: a value written
  // by an older version, or by hand, must not leave the page with no layout.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return LAYOUTS.includes(stored as BudgetLayout) ? (stored as BudgetLayout) : DEFAULT_LAYOUT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setBudgetLayout(layout: BudgetLayout): void {
  window.localStorage.setItem(STORAGE_KEY, layout);
  for (const listener of listeners) listener();
}

/** Named so the constant is not re-created, and typed without an assertion. */
function serverSnapshot(): BudgetLayout {
  return DEFAULT_LAYOUT;
}

export function useBudgetLayout(): [BudgetLayout, (next: BudgetLayout) => void] {
  const layout = useSyncExternalStore(subscribe, read, serverSnapshot);
  return [layout, useCallback((next: BudgetLayout) => setBudgetLayout(next), [])];
}
