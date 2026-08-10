import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import {
  transactionsApi,
  type TransactionDto,
  type TransactionFilters,
} from '../api/transactions.js';
import { DelegationPicker } from '../components/DelegationPicker.jsx';
import { NewTransactionDialog } from '../components/NewTransactionDialog.jsx';
import { PairSuggestions } from '../components/PairSuggestions.jsx';
import { SplitDialog } from '../components/SplitDialog.jsx';
import { Alert, Button, Tag } from '../components/ui.jsx';
import { useRowKeyboard } from '../useRowKeyboard.js';

/**
 * The Transactions page.
 *
 * Its job at go-live is a queue: filter to uncategorized, assign, move on,
 * several hundred times. Everything else is secondary to that loop staying
 * keyboard-only.
 */

const PAGE_SIZE = 50;

function AllocationSummary({ transaction }: { transaction: TransactionDto }): ReactNode {
  if (transaction.kind !== 'normal') {
    // Income and confirmed transfers allocate to nothing by definition, so there
    // is nothing to pick and no empty control to imply otherwise.
    return <span className="text-quiet text-muted">—</span>;
  }
  if (transaction.allocations.length <= 1) return null;

  return (
    <span className="text-quiet text-muted">
      Split across {transaction.allocations.length}:{' '}
      {transaction.allocations.map((allocation) => allocation.delegation.name).join(', ')}
    </span>
  );
}

/** Descriptions come from the bank and can contain quotes, which would break the selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export function Transactions(): ReactNode {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<TransactionFilters>({ uncategorized: true });
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The transaction whose split is being edited, if any.
  const [splitting, setSplitting] = useState<TransactionDto | null>(null);

  const query = { ...filters, search, limit: PAGE_SIZE, offset };
  const list = useQuery({
    queryKey: ['transactions', query],
    queryFn: () => transactionsApi.list(query),
  });

  const rows = list.data?.transactions ?? [];

  /**
   * j/k and the arrow keys move between rows; Enter steps into that row's
   * categorize field; Space selects it for a bulk assignment. Keys typed inside
   * the field itself are left alone, so searching for "jam" still types "jam".
   */
  const keyboard = useRowKeyboard(rows.length, {
    onActivate: (index) => {
      const transaction = rows[index];
      if (!transaction) return;
      const field = document.querySelector<HTMLInputElement>(
        `[aria-label="Categorize ${cssEscape(transaction.description)}"]`,
      );
      field?.focus();
    },
    onToggle: (index) => {
      const transaction = rows[index];
      if (transaction) toggleSelected(transaction.id);
    },
  });

  // The picker needs every delegation, which the budget view already provides.
  const budget = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const delegations = [
    ...(budget.data?.delegations.groupings.flatMap((grouping) => grouping.rows) ?? []),
    ...(budget.data?.delegations.ungrouped ?? []),
  ].map((row) => ({ id: row.id, name: row.name }));

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['transactions'] });
    // Balances moved too, so the Main Budget cache is no longer trustworthy.
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Something went wrong.');

  const categorize = useMutation({
    mutationFn: ({ id, delegationId }: { id: string; delegationId: string }) =>
      transactionsApi.categorize(id, delegationId),
    onSuccess: refresh,
    onError,
  });

  const unpair = useMutation({
    mutationFn: (id: string) => transactionsApi.unpair(id),
    onSuccess: async () => {
      await refresh();
      // Both halves are suggestible again the moment they are unpaired, so the
      // suggestion panel has to hear about it.
      await queryClient.invalidateQueries({ queryKey: ['pair-candidates'] });
    },
    onError,
  });

  const bulk = useMutation({
    mutationFn: (delegationId: string) =>
      transactionsApi.bulkCategorize([...selected], delegationId),
    onSuccess: async (result) => {
      setSelected(new Set());
      // Rows that could not be categorized are named rather than swallowed.
      if (result.failures.length > 0) {
        setProblem(
          `${result.categorized} categorized. ${result.failures.length} could not be: ${result.failures[0]?.reason ?? ''}`,
        );
      }
      await refresh();
    },
    onError,
  });

  function toggleSelected(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setFilter(patch: TransactionFilters): void {
    setOffset(0);
    setFilters((previous) => ({ ...previous, ...patch }));
  }

  const total = list.data?.total ?? 0;

  return (
    <div>
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-page font-bold text-ink">Transactions</h1>
          <p className="mt-1 text-quiet text-muted">
            {total} {total === 1 ? 'transaction' : 'transactions'}
            {filters.uncategorized ? ' waiting to be categorized' : ''}.
          </p>
        </div>

        <Button variant="primary" onClick={() => setAdding(true)}>
          Add transaction
        </Button>
      </header>

      <PairSuggestions />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => {
            setOffset(0);
            setSearch(event.target.value);
          }}
          placeholder="Search description, account, delegation or amount"
          aria-label="Search transactions"
          className="min-w-64 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-base"
        />

        <Button
          variant={filters.uncategorized === true ? 'primary' : 'default'}
          onClick={() =>
            setFilter({ uncategorized: filters.uncategorized === true ? undefined : true })
          }
        >
          Uncategorized
        </Button>
        <Button
          variant={filters.pending === true ? 'primary' : 'default'}
          onClick={() => setFilter({ pending: filters.pending === true ? undefined : true })}
        >
          Pending
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="text-quiet text-ink">{selected.size} selected — assign all to</span>
          <div className="w-64">
            <DelegationPicker
              options={delegations}
              label="Bulk categorize selection"
              onChoose={(delegationId) => bulk.mutate(delegationId)}
            />
          </div>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {list.isLoading ? (
        <p className="text-quiet text-muted">Loading transactions…</p>
      ) : (
        <table className="w-full border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-[0.05em] text-muted">
              <th className="w-8 row-cell pl-3" />
              <th className="row-cell text-left font-normal">Date</th>
              <th className="row-cell text-left font-normal">Description</th>
              <th className="row-cell text-left font-normal">Account</th>
              <th className="row-cell pr-3 text-right font-normal">Amount</th>
              <th className="row-cell pr-3 text-left font-normal">Delegation</th>
            </tr>
          </thead>

          <tbody onKeyDown={keyboard.onKeyDown}>
            {list.data?.transactions.map((transaction, index) => {
              const amount = BigInt(transaction.amountCents);
              const current = transaction.allocations[0]?.delegation.name;

              return (
                <tr
                  key={transaction.id}
                  className="border-b border-line focus:bg-accent-soft"
                  {...keyboard.rowProps(index)}
                >
                  <td className="row-cell pl-3">
                    <input
                      type="checkbox"
                      checked={selected.has(transaction.id)}
                      onChange={() => toggleSelected(transaction.id)}
                      aria-label={`Select ${transaction.description}`}
                    />
                  </td>

                  <td className="row-cell pr-3 text-quiet whitespace-nowrap text-muted">
                    {new Date(transaction.postedAt).toLocaleDateString()}
                  </td>

                  <td className="row-cell pr-3">
                    <span className="text-ink">{transaction.description}</span>
                    {/* Pending rows already moved the envelopes, so they are
                        marked rather than hidden. */}
                    {transaction.pending && (
                      <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-label font-semibold text-warning">
                        Pending
                      </span>
                    )}
                    {transaction.kind !== 'normal' && (
                      <span className="ml-2">
                        <Tag>{transaction.kind}</Tag>
                      </span>
                    )}
                    {/* A confirmed pair has to be reversible: the suggestion was
                        a judgement, and judgements are sometimes wrong. */}
                    {transaction.pairedTransactionId && (
                      <button
                        type="button"
                        onClick={() => unpair.mutate(transaction.id)}
                        aria-label={`Unpair ${transaction.description}`}
                        className="ml-2 text-quiet text-muted underline"
                      >
                        unpair
                      </button>
                    )}
                    <div>
                      <AllocationSummary transaction={transaction} />
                    </div>
                  </td>

                  <td className="row-cell pr-3 text-quiet text-muted">
                    {transaction.account.name}
                  </td>

                  <td className="money row-cell pr-3">
                    <span className={amount > 0n ? 'font-semibold text-positive' : 'text-ink'}>
                      {formatCents(amount, { explicitPlus: true })}
                    </span>
                  </td>

                  <td className="w-72 row-cell pr-3">
                    {transaction.kind === 'normal' ? (
                      <div className="flex items-center gap-1">
                        <div className="flex-1">
                          <DelegationPicker
                            options={delegations}
                            {...(current ? { currentName: current } : {})}
                            label={`Categorize ${transaction.description}`}
                            onChoose={(delegationId) =>
                              categorize.mutate({ id: transaction.id, delegationId })
                            }
                          />
                        </div>
                        {/* Splits are rare, so this is a plain affordance beside
                            the picker rather than anything the queue trips over. */}
                        <Button
                          variant="ghost"
                          onClick={() => setSplitting(transaction)}
                          aria-label={`Split ${transaction.description}`}
                        >
                          Split
                        </Button>
                      </div>
                    ) : (
                      <AllocationSummary transaction={transaction} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between">
          <Button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
          >
            Previous
          </Button>
          <span className="text-quiet text-muted">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <Button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
          >
            Next
          </Button>
        </div>
      )}

      {adding && (
        <NewTransactionDialog delegations={delegations} onClose={() => setAdding(false)} />
      )}
      {splitting && (
        <SplitDialog
          transaction={splitting}
          delegations={delegations}
          onClose={() => setSplitting(null)}
        />
      )}
    </div>
  );
}
