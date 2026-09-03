import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import {
  transactionsApi,
  type SuggestionDto,
  type TransactionDto,
  type TransactionFilters,
} from '../api/transactions.js';
import { Chips } from '../components/Chip.jsx';
import type { ChipKind } from '../components/chips.js';
import { DelegationPicker } from '../components/DelegationPicker.jsx';
import { NewTransactionDialog } from '../components/NewTransactionDialog.jsx';
import { DuplicateSuggestions } from '../components/DuplicateSuggestions.jsx';
import { PairSuggestions } from '../components/PairSuggestions.jsx';
import { ConfirmSuggestionDialog } from '../components/ConfirmSuggestionDialog.jsx';
import { RuleFromTransactionDialog } from '../components/RuleFromTransactionDialog.jsx';
import { MatchCheckDialog } from '../components/MatchCheckDialog.jsx';
import { TransactionRowMenu } from '../components/TransactionRowMenu.jsx';
import { SplitDialog } from '../components/SplitDialog.jsx';
import { TransactionCard } from '../components/TransactionCard.jsx';
import { Alert, Button, Modal } from '../components/ui.jsx';
import { NARROW, useMediaQuery } from '../useMediaQuery.js';
import { useRowKeyboard } from '../useRowKeyboard.js';
import { PageHeader } from '../components/layout.jsx';

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

  /*
   * The names only. "Split across 2:" used to lead this, and the `sp` mark now
   * says exactly that in two characters a few pixels to the left — printing both
   * is the same fact twice on the one row where width is scarcest. The
   * description truncates to make room for whatever follows it, so those three
   * words were being paid for out of the merchant name.
   */
  return (
    <span className="text-quiet text-muted">
      {transaction.allocations.map((allocation) => allocation.delegation.name).join(', ')}
    </span>
  );
}

/**
 * The suggestion, and the way to act on it.
 *
 * The picker carries the same suggestion as its first entry, which is the
 * keyboard path; this is the one for an eye running down the queue, so that
 * "these nine are routine" is visible without focusing nine rows in turn.
 *
 * Two or three words on the face and the whole sentence on hover or focus —
 * the same division a header pill makes, for the same reason: the column is
 * 256px wide and the count is what a reader wants only once they doubt it.
 *
 * **It asks rather than files.** Pressing it used to categorize immediately,
 * which is right for somebody who trusts the queue and wrong for the moment they
 * do not — and the evidence behind the guess lived on a `title`, invisible to
 * anybody not hovering. The press now opens a dialog that shows the charge and
 * the count, and offers the three answers a person actually means, including
 * writing the rule that stops the question being asked again.
 */
function SuggestionButton({
  suggestion,
  onOpen,
}: {
  readonly suggestion: SuggestionDto;
  readonly onOpen: () => void;
}): ReactNode {
  const evidence = `${suggestion.matchCount} of ${suggestion.totalCount} before went to ${suggestion.delegationName}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={evidence}
      aria-label={`Categorize as ${suggestion.delegationName} — ${evidence}`}
      className="max-w-[50%] shrink-0 truncate rounded border border-accent bg-accent-soft px-2 py-0.5 text-quiet font-semibold text-accent"
    >
      {suggestion.delegationName}
    </button>
  );
}

/** Descriptions come from the bank and can contain quotes, which would break the selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Which marks a register row carries.
 *
 * What it *is* comes before what is *pending about it*: a settled check that
 * has not cleared the account yet reads `c p`, which is the order somebody
 * would say it in.
 */
function chipsFor(transaction: TransactionDto): ChipKind[] {
  const kinds: ChipKind[] = [];

  if (transaction.kind === 'income') kinds.push('income');
  if (transaction.kind === 'transfer') kinds.push('transfer');
  // Null on everything that predates the column: which payment settled which
  // check cannot be reconstructed afterwards, so old rows carry no mark.
  if (transaction.settledCheckNumber !== null) kinds.push('check');
  if (transaction.allocations.length > 1) kinds.push('split');
  if (transaction.pending) kinds.push('pending');

  return kinds;
}

export function Transactions(): ReactNode {
  const queryClient = useQueryClient();
  /*
   * Nothing filtered on arrival.
   *
   * This used to open on the uncategorized queue, which is the right default
   * for a session spent clearing a backlog and the wrong one for every other
   * visit — a register that hides most of the register is a register somebody
   * has to un-configure before they can look anything up.
   */
  const [filters, setFilters] = useState<TransactionFilters>({});

  /*
   * Except the queue, which lives in the URL.
   *
   * Both ways of arriving here are right, and they want different things: the
   * sidebar means "the register", and the "N new transactions" pill means "the
   * ones I have not dealt with". A default cannot be both, so the link carries
   * its own — `?uncategorized=true`.
   *
   * The URL rather than initial state, because the two routes are the same
   * component: navigating from the filtered queue to the plain sidebar link
   * does not remount, so an initialiser would run once and then never again,
   * and the filter would stick on a page that never asked for it.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const uncategorized = searchParams.get('uncategorized') === 'true';

  function toggleUncategorized(): void {
    setOffset(0);
    const next = new URLSearchParams(searchParams);
    if (uncategorized) next.delete('uncategorized');
    else next.set('uncategorized', 'true');
    // Replace: Back belongs to wherever he came from, not to the state of a
    // filter he just pressed.
    setSearchParams(next, { replace: true });
  }
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The transaction whose split is being edited, if any.
  const [splitting, setSplitting] = useState<TransactionDto | null>(null);
  // The transaction being matched to an outstanding check, if any.
  const [matching, setMatching] = useState<TransactionDto | null>(null);
  /** The row whose picker is open in a sheet. Phone only. */
  const [picking, setPicking] = useState<TransactionDto | null>(null);
  /** The row a rule is being built from, if any. */
  const [ruling, setRuling] = useState<TransactionDto | null>(null);
  /** The suggestion being confirmed, with the row it is about. */
  const [confirming, setConfirming] = useState<{
    readonly transaction: TransactionDto;
    readonly suggestion: SuggestionDto;
  } | null>(null);

  const query = {
    ...filters,
    ...(uncategorized ? { uncategorized: true } : {}),
    search,
    limit: PAGE_SIZE,
    offset,
  };
  const list = useQuery({
    queryKey: ['transactions', query],
    queryFn: () => transactionsApi.list(query),
  });

  /*
   * Advice, fetched apart from the register it annotates.
   *
   * Its own query rather than a field on the list, so a slow tally cannot hold
   * up the rows themselves and a failure to answer leaves a page that works
   * with nothing suggested on it. That is the right failure for a suggestion:
   * absent, never wrong.
   */
  const suggestions = useQuery({
    queryKey: ['transaction-suggestions'],
    queryFn: transactionsApi.suggestions,
  });
  const suggestionFor = new Map(
    (suggestions.data?.suggestions ?? []).map((entry) => [entry.transactionId, entry]),
  );

  /*
   * Which layout, rather than both with one hidden.
   *
   * Rendering the table and the cards together and hiding one in CSS puts two
   * copies of every transaction in the document — four hundred rows for a page
   * of two hundred — and both are read by a screen reader, which does not care
   * what `display` says about the one it has already reached.
   */
  const narrow = useMediaQuery(NARROW);
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
  ]
    // Outstanding checks are delegations, but they are not a category anything
    // is spent on. They are settled by matching, which is a different action.
    .filter((row) => row.kind !== 'check')
    .map((row) => ({ id: row.id, name: row.name }));

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['transactions'] });
    // Balances moved too, so the Budget page cache is no longer trustworthy.
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    // And the row just categorized is now evidence rather than a question, so
    // the next merchant like it has one more decision behind it.
    await queryClient.invalidateQueries({ queryKey: ['transaction-suggestions'] });
    // Archiving a row, or categorizing one, changes what the duplicate reading
    // is looking at.
    await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
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
      {/*
       * No subtitle. It counted the register — "494 transactions." — which is a
       * fact about how long the household has been running, not something the
       * page it sat on is for. It reads as a status line above a list somebody
       * came here to *work* through, and the pager below already says which of
       * them is on screen.
       *
       * The count now lives on Settings → Sync, beside the connection that
       * produced it.
       */}
      <PageHeader
        title="Transactions"
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            New transaction
          </Button>
        }
      />

      {/*
        Gone.

        This said "touch and hold a transaction for more", which was true when
        the ⋯ was hidden behind a hover a phone cannot perform and the gesture
        was the only way in. The ⋯ is drawn on every row on a touchscreen now,
        so the line explained a gesture nobody needs — and a hint that is no
        longer necessary is one more thing between the reader and the queue.
        Touch and hold still works; it is a shortcut rather than the route.
      */}

      {/* Above the pairs: a duplicate is a row that should not be in the
          register at all, and every figure below it is wrong while it is. */}
      <DuplicateSuggestions />

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
          className="field min-w-64 flex-1 rounded-lg border border-line bg-canvas px-3 text-base"
        />

        <Button variant={uncategorized ? 'primary' : 'default'} onClick={toggleUncategorized}>
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
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
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
      ) : /*
          Two layouts, not one taught to reflow. Six columns do not become two
          lines by wrapping: the decision is which facts share a line and which
          are dropped, and that reads better as its own component than as eight
          breakpoints threaded through a `<tr>`.
        */
      narrow ? (
        <ul className="border-t-2 border-ink">
          {(list.data?.transactions ?? []).map((transaction) => (
            <TransactionCard
              key={transaction.id}
              transaction={transaction}
              chips={chipsFor(transaction)}
              categorizedAs={transaction.allocations[0]?.delegation.name ?? null}
              onCategorize={() => setPicking(transaction)}
              menu={
                <TransactionRowMenu
                  transaction={transaction}
                  onSplit={() => setSplitting(transaction)}
                  onMatchCheck={() => setMatching(transaction)}
                  onCreateRule={
                    transaction.allocations.length === 1 ? () => setRuling(transaction) : null
                  }
                  onProblem={setProblem}
                />
              }
            />
          ))}
        </ul>
      ) : (
        <table className="w-full border-t-2 border-ink md:table-fixed">
          <thead>
            <tr className="text-label uppercase tracking-label text-muted">
              {/*
                From `md` up only. These add to more than a phone screen is
                wide, and a fixed layout that is over-subscribed gives the
                unsized column nothing — the description collapsed to zero and
                vanished. Below `md` the automatic algorithm is left alone,
                which is what a narrow screen wants anyway.

                `table-fixed`, and stated widths, because the
                automatic algorithm sizes every column to its content — and a
                bank description has no upper bound. Measured, it took 728 of
                the 1112 pixels available and left the delegation picker 87,
                which is narrower than the names it has to show.

                So the account and the delegation get what they actually need,
                and the description takes whatever is left over. That is the
                right way round: it is the only one of the three whose content
                is unbounded, and it truncates gracefully with the full text on
                hover.
              */}
              <th className="w-8 row-cell pr-2 pl-3" />
              <th className="row-cell pr-4 text-left font-normal whitespace-nowrap md:w-24">
                Date
              </th>
              {/* No width: under a fixed layout the unsized column takes
                  whatever the others leave, which is the right job for the one
                  whose content has no upper bound. */}
              <th className="row-cell pr-3 text-left font-normal">Description</th>
              <th className="row-cell pr-3 text-left font-normal md:w-36">Account</th>
              <th className="w-32 row-cell pr-3 text-right font-normal">Amount</th>
              <th className="row-cell pr-3 text-left font-normal md:w-64">Delegation</th>
              <th className="hold-to-open-cell row-cell" />
            </tr>
          </thead>

          <tbody onKeyDown={keyboard.onKeyDown}>
            {list.data?.transactions.map((transaction, index) => {
              const amount = BigInt(transaction.amountCents);
              const current = transaction.allocations[0]?.delegation.name;
              const suggestion = suggestionFor.get(transaction.id);

              return (
                <tr
                  key={transaction.id}
                  // `group` so the row's menu appears on hover of the row rather
                  // than only of the trigger itself.
                  className="group border-b border-line focus:bg-accent-soft"
                  {...keyboard.rowProps(index)}
                >
                  <td className="row-cell pr-2 pl-3 align-middle">
                    <input
                      type="checkbox"
                      checked={selected.has(transaction.id)}
                      onChange={() => toggleSelected(transaction.id)}
                      aria-label={`Select ${transaction.description}`}
                    />
                  </td>

                  {/* `pr-4` and the middle alignment: the date was running
                      into the checkbox and sitting a shade above it. */}
                  <td className="row-cell pr-4 align-middle text-quiet whitespace-nowrap text-muted">
                    {new Date(transaction.postedAt).toLocaleDateString()}
                  </td>

                  {/*
                    One line, always. A bank description is as long as the bank
                    feels like making it, and a wrapped row pushes every row
                    below it down — sixty of those is a page that will not sit
                    still. Truncated with the full text on hover and in the
                    title, so nothing is actually lost.
                  */}
                  <td className="row-cell pr-3">
                    <div className="flex items-baseline gap-2 overflow-hidden">
                      {/* Only the description gives way. The badges beside it
                          are short and fixed, and shrinking those to fit a long
                          merchant name would hide the useful half. */}
                      <span className="truncate text-ink" title={transaction.description}>
                        {transaction.description}
                      </span>

                      {/* Marks, not words — see components/chips.ts. A pending
                          row has already moved its envelope while the account
                          balance has not caught up, so it is marked rather than
                          hidden, and it keeps the yellow. */}
                      <Chips kinds={chipsFor(transaction)} />
                      {/* A confirmed pair has to be reversible: the suggestion
                          was a judgement, and judgements are sometimes wrong. */}
                      {transaction.pairedTransactionId && (
                        <button
                          type="button"
                          onClick={() => unpair.mutate(transaction.id)}
                          aria-label={`Unpair ${transaction.description}`}
                          className="shrink-0 text-quiet text-muted underline"
                        >
                          unpair
                        </button>
                      )}
                      <span className="shrink-0 truncate">
                        <AllocationSummary transaction={transaction} />
                      </span>
                    </div>
                  </td>

                  {/* Capped, so it truncates rather than pushing the row
                      wider. The full name is in the title, as with the
                      description. */}
                  <td className="row-cell pr-3 text-quiet text-muted">
                    <span className="block truncate" title={transaction.account.name}>
                      {transaction.account.name}
                    </span>
                  </td>

                  {/* `whitespace-nowrap`: a squeezed column was breaking
                      "+$3,527.63" after the sign, putting the amount on a second
                      line. A figure is one thing and wraps nowhere. */}
                  <td className="money row-cell w-32 pr-3 whitespace-nowrap">
                    <span className={amount > 0n ? 'font-semibold text-positive' : 'text-ink'}>
                      {formatCents(amount, { explicitPlus: true })}
                    </span>
                  </td>

                  <td className="row-cell pr-3">
                    {transaction.kind === 'normal' ? (
                      <div className="flex items-center gap-2">
                        {/* Only while the row is still a question. A row already
                            filed has an answer, and offering a second one beside
                            it would read as a disagreement. */}
                        {suggestion && transaction.allocations.length === 0 && (
                          <SuggestionButton
                            suggestion={suggestion}
                            onOpen={() => setConfirming({ transaction, suggestion })}
                          />
                        )}
                        {/* `min-w-0`: a flex item defaults to its content width,
                            so without it the field would size the column rather
                            than the column sizing the field. */}
                        <div className="min-w-0 flex-1">
                          <DelegationPicker
                            options={delegations}
                            {...(current ? { currentName: current } : {})}
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
                      </div>
                    ) : (
                      <AllocationSummary transaction={transaction} />
                    )}
                  </td>

                  {/* Splitting and matching a check are both uncommon; the
                      frequent act on this page is categorizing, which stays a
                      field in the row. */}
                  <td className="hold-to-open-cell row-cell">
                    {
                      <TransactionRowMenu
                        transaction={transaction}
                        onSplit={() => setSplitting(transaction)}
                        onMatchCheck={() => setMatching(transaction)}
                        onCreateRule={
                          transaction.allocations.length === 1 ? () => setRuling(transaction) : null
                        }
                        onProblem={setProblem}
                      />
                    }
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
      {/*
        The picker, given a sheet.
        
        The same control the desktop row carries, in the frame a thumb wants:
        the field at the top with the keyboard already up, and the matches
        listed beneath it at a size that can be hit. Choosing closes it, because
        on a phone one decision at a time is the whole interaction.

        Cancel and Split are the dialog's footer rather than its last children,
        so the keyboard cannot push them off the bottom of the sheet — which is
        exactly what it was doing: with the keys up, both sat 361px below the
        visible edge of a screen that does not scroll to reach them.
      */}
      {picking && (
        <Modal
          label={`Categorize ${picking.description}`}
          title="Categorize"
          description={`${picking.description} · ${formatCents(BigInt(picking.amountCents), { explicitPlus: true })}`}
          onClose={() => setPicking(null)}
          footer={
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => setPicking(null)}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={() => {
                  const row = picking;
                  setPicking(null);
                  setSplitting(row);
                }}
              >
                Split…
              </Button>
            </div>
          }
        >
          <DelegationPicker
            variant="sheet"
            autoFocus
            options={delegations}
            {...(picking.allocations[0]?.delegation.name
              ? { currentName: picking.allocations[0].delegation.name }
              : {})}
            {...(() => {
              // The same advice the table row shows, in the frame a thumb uses:
              // first in the list, at the size everything else in the sheet is.
              const suggestion = suggestionFor.get(picking.id);
              return suggestion && picking.allocations.length === 0
                ? {
                    suggestion: {
                      delegationId: suggestion.delegationId,
                      name: suggestion.delegationName,
                      matchCount: suggestion.matchCount,
                      totalCount: suggestion.totalCount,
                    },
                  }
                : {};
            })()}
            label={`Categorize ${picking.description}`}
            onChoose={(delegationId) => {
              categorize.mutate({ id: picking.id, delegationId });
              setPicking(null);
            }}
          />
        </Modal>
      )}

      {splitting && (
        <SplitDialog
          transaction={splitting}
          delegations={delegations}
          onClose={() => setSplitting(null)}
        />
      )}
      {matching && <MatchCheckDialog transaction={matching} onClose={() => setMatching(null)} />}

      {confirming && (
        <ConfirmSuggestionDialog
          transaction={confirming.transaction}
          suggestion={confirming.suggestion}
          onConfirm={() => {
            categorize.mutate({
              id: confirming.transaction.id,
              delegationId: confirming.suggestion.delegationId,
            });
            setConfirming(null);
          }}
          /*
           * Files it, then hands the same row to the rule dialog.
           *
           * The row is passed with the allocation written in rather than
           * re-read: `RuleFromTransactionDialog` takes the delegation from
           * `allocations[0]`, and the list this row came from has not been
           * refetched yet — the mutation was fired a line above. Waiting for the
           * refetch to open the second dialog would put a visible gap between
           * one press and the thing it asked for.
           */
          onConfirmAndRule={() => {
            const { transaction, suggestion } = confirming;
            categorize.mutate({ id: transaction.id, delegationId: suggestion.delegationId });
            setRuling({
              ...transaction,
              allocations: [
                {
                  id: 'pending',
                  delegationId: suggestion.delegationId,
                  amountCents: transaction.amountCents,
                  delegation: {
                    id: suggestion.delegationId,
                    name: suggestion.delegationName,
                    archivedAt: null,
                  },
                },
              ],
            });
            setConfirming(null);
          }}
          onClose={() => setConfirming(null)}
        />
      )}

      {/* The delegation comes from the row itself: the rule files future
          matches where this one was filed, which is the whole of what
          "always categorize like this" means. */}
      {ruling?.allocations[0] && (
        <RuleFromTransactionDialog
          transaction={ruling}
          delegation={{
            id: ruling.allocations[0].delegationId,
            name: ruling.allocations[0].delegation.name,
          }}
          onClose={() => setRuling(null)}
        />
      )}
    </div>
  );
}
