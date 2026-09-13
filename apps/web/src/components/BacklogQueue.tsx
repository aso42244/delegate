import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { budgetApi } from '../api/budget.js';
import { transactionsApi } from '../api/transactions.js';
import { DelegationPicker } from './DelegationPicker.jsx';
import { EmptyState } from './layout.jsx';

/**
 * The categorization queue, worked from Overview rather than linked to.
 *
 * The tile was a figure and a link: a count, "Waiting, oldest 1d", and "Open the
 * queue →". Which is a notification, not a surface — the owner reads it on the
 * screen he opens every morning, and then goes somewhere else to spend forty
 * seconds filing three charges. Categorizing is the single highest-traffic act
 * in this application (`DelegationPicker`'s own note says several hundred in a
 * sitting at go-live), and three of them were a page away.
 *
 * It is the register's own row, minus the register: date, payee, amount, and the
 * same type-ahead with the same suggestion leading it. Choosing files the charge
 * and the row leaves, because the list is "what is still waiting" and a filed
 * charge is not.
 *
 * **Only on a laptop.** Overview's tiles are hidden below `sm` (ADR 062), and a
 * phone already has the better version of this: the register's own sheet, with
 * the field at the top and the matches at a size a thumb can hit.
 *
 * **The full queue is still one press away.** This shows the first few and says
 * how many more there are; sixty charges is a session at the register, not a
 * tile on a dashboard.
 */

/** How many rows the tile works before it stops being a tile. */
const SHOWN = 5;

export function BacklogQueue(): ReactNode {
  const queryClient = useQueryClient();

  /*
   * Its own query rather than a field on the overview payload.
   *
   * The payload carries a count and the oldest date, which is all a figure
   * needed. Rows are a different thing with a different lifetime: they change
   * as they are filed, and they have to be refetched without pulling the whole
   * dashboard through again. The band's balances list does the same.
   */
  const waiting = useQuery({
    // A page more than is shown, so "and 3 more" is right rather than a guess.
    queryKey: ['transactions', { uncategorized: true, forOverview: true }],
    queryFn: () => transactionsApi.list({ uncategorized: true, limit: SHOWN + 1 }),
  });

  /*
   * Advice, fetched apart from the rows it annotates — the register's own
   * reasoning: a slow tally cannot hold up the rows, and a failure to answer
   * leaves a list that works with nothing suggested on it. Absent, never wrong.
   */
  const suggestions = useQuery({
    queryKey: ['transaction-suggestions'],
    queryFn: transactionsApi.suggestions,
  });
  const suggestionFor = new Map(
    (suggestions.data?.suggestions ?? []).map((entry) => [entry.transactionId, entry]),
  );

  // The picker needs every delegation, which the budget view already provides.
  const budget = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const delegations = [
    ...(budget.data?.delegations.groupings.flatMap((grouping) => grouping.rows) ?? []),
    ...(budget.data?.delegations.ungrouped ?? []),
  ]
    // Outstanding checks are delegations, but they are not a category anything
    // is spent on. They are settled by matching, which is a different action.
    .filter((row) => row.kind !== 'check')
    .map((row) => ({ id: row.id, name: row.name }));

  const categorize = useMutation({
    mutationFn: ({ id, delegationId }: { id: string; delegationId: string }) =>
      transactionsApi.categorize(id, delegationId),
    onSuccess: async () => {
      /*
       * Money moved, so more than this list is stale: the budget's figures, the
       * identity reading in the corner, and the overview payload that carries
       * the count this tile used to be. Invalidating the three by key rather
       * than everything leaves the charts alone, which did not change.
       */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['transaction-suggestions'] }),
        queryClient.invalidateQueries({ queryKey: ['budget'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
      ]);
    },
  });

  if (waiting.isPending) return <EmptyState>Loading what is waiting…</EmptyState>;

  const rows = waiting.data?.transactions ?? [];
  if (rows.length === 0) return <EmptyState>Nothing waiting.</EmptyState>;

  const shown = rows.slice(0, SHOWN);
  const more = (waiting.data?.total ?? rows.length) - shown.length;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex list-none flex-col p-0">
        {shown.map((transaction) => {
          const suggestion = suggestionFor.get(transaction.id);
          const amount = BigInt(transaction.amountCents);

          return (
            <li
              key={transaction.id}
              className="row-cell flex items-center gap-3 border-b border-line last:border-b-0"
            >
              {/* The day, not the date: everything here is recent by
                  construction, and the year is four characters of nothing. */}
              <span className="w-12 shrink-0 text-quiet whitespace-nowrap text-muted">
                {new Date(transaction.postedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>

              {/* `min-w-0` and `truncate`: a payee's name has no upper bound,
                  and without these it sizes the row rather than the row sizing
                  it. */}
              <span className="min-w-0 flex-1 truncate text-base text-ink">
                {transaction.description}
              </span>

              <span
                className={`money w-24 shrink-0 text-right text-base ${
                  amount < 0n ? 'text-negative' : 'text-ink'
                }`}
              >
                {formatCents(amount)}
              </span>

              {/* The same field the register carries, stating its own width
                  (`ui-system.md` §2) rather than taking whatever is left: a
                  type-ahead that changes width per row has no column. */}
              <div className="w-64 min-w-0 shrink-0">
                <DelegationPicker
                  options={delegations}
                  {...(suggestion
                    ? {
                        suggestion: {
                          delegationId: suggestion.delegationId,
                          name: suggestion.delegationName,
                          matchCount: suggestion.matchCount,
                          totalCount: suggestion.totalCount,
                        },
                      }
                    : {})}
                  label={`Categorize ${transaction.description}`}
                  onChoose={(delegationId) =>
                    categorize.mutate({ id: transaction.id, delegationId })
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        The rest of them, named rather than hidden.

        A tile that quietly shows five of sixty is a tile that says the work is
        nearly done. The link is the register with the same filter on it.
      */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-quiet text-muted">
          {more > 0 ? `${more} more waiting.` : 'That is all of them.'}
        </span>
        <Link to="/transactions?uncategorized=true" className="linkish">
          Open the queue →
        </Link>
      </div>
    </div>
  );
}
