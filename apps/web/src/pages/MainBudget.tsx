import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  budgetApi,
  type BudgetRowDto,
  type BudgetSectionDto,
  type BudgetViewDto,
} from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { AccountRowMenu } from '../components/AccountRowMenu.jsx';
import { BalanceBanner } from '../components/BalanceBanner.jsx';
import { BudgetSection } from '../components/BudgetSection.jsx';
import { CheckRowMenu } from '../components/CheckRowMenu.jsx';
import { DelegationRowMenu } from '../components/DelegationRowMenu.jsx';
import { NewCheckDialog } from '../components/NewCheckDialog.jsx';
import { NewTransactionDialog } from '../components/NewTransactionDialog.jsx';
import { Alert, Button } from '../components/ui.jsx';

/**
 * The Budget page — the page that replaces the spreadsheet.
 *
 * Every mutation invalidates the whole view rather than patching a row locally.
 * The identity at the top depends on all three sections at once, so a partial
 * update would leave the headline figure disagreeing with the rows beneath it,
 * which is the one thing this page cannot do.
 */

/**
 * The options, grouped exactly as the page beneath is grouped.
 *
 * A flat alphabetical list meant finding "Fuel" in the dialog was a different
 * act from finding it on the page — and this dialog is always opened while
 * looking at that page. Groupings first, then the ungrouped lines, which is the
 * order `buildBudgetView` returns and the order the sections render in.
 *
 * The balance is in the label rather than reported under the select once a
 * choice is made. Deciding where to move money from means comparing what the
 * candidates hold, and that comparison has to be possible *while* the list is
 * open.
 */
function TransferOptions({
  section,
  exclude,
}: {
  readonly section: BudgetSectionDto;
  /** The other side of the transfer, which cannot also be this side. */
  readonly exclude: string;
}): ReactNode {
  const label = (row: { name: string; balanceCents: string }): string =>
    `${row.name} — ${formatCents(BigInt(row.balanceCents))}`;

  return (
    <>
      {section.groupings.map((grouping) => {
        const rows = grouping.rows.filter((row) => row.id !== exclude);
        if (rows.length === 0) return null;

        return (
          <optgroup key={grouping.id} label={grouping.name}>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {label(row)}
              </option>
            ))}
          </optgroup>
        );
      })}

      {/* Ungrouped lines sit after the groupings, as they do on the page. */}
      {section.ungrouped
        .filter((row) => row.id !== exclude)
        .map((row) => (
          <option key={row.id} value={row.id}>
            {label(row)}
          </option>
        ))}
    </>
  );
}

function TransferDialog({
  section,
  initialFrom,
  onClose,
}: {
  /** The delegations section of the budget, in the order the page shows it. */
  readonly section: BudgetSectionDto;
  /** Preset when Transfer was reached from a blocked archive. */
  initialFrom?: string | undefined;
  onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(initialFrom ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: () => {
      const parsed = /^-?\d+(\.\d{1,2})?$/.exec(amount.trim());
      if (!parsed) throw new ApiError(400, 'invalid_amount', 'Enter an amount like 25.00.');

      const [whole, fraction = ''] = amount.trim().replace('$', '').split('.');
      const cents = BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
      return budgetApi.transfer(from, to, cents.toString());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not transfer.'),
  });

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/20 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transfer between delegations"
        className="w-full max-w-md rounded-lg border border-line bg-canvas p-4"
      >
        <h2 className="mb-1 text-section font-bold text-ink">Transfer</h2>
        <p className="mb-4 text-quiet text-muted">
          Moves money between envelopes. The total across delegations does not change, so the bottom
          line stays where it is. The source may go negative.
        </p>

        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-quiet font-medium">From</span>
            <select
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2"
            >
              <option value="">Choose a delegation</option>
              <TransferOptions section={section} exclude={to} />
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-quiet font-medium">To</span>
            <select
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2"
            >
              <option value="">Choose a delegation</option>
              <TransferOptions section={section} exclude={from} />
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-quiet font-medium">Amount</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="25.00"
              className="money w-full rounded-lg border border-line bg-canvas px-3 py-2"
            />
          </label>

          {problem && <Alert>{problem}</Alert>}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => transfer.mutate()}
              disabled={from === '' || to === '' || amount.trim() === '' || transfer.isPending}
            >
              {transfer.isPending ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DelegateDialog({ onClose }: { onClose: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const preview = useQuery({ queryKey: ['delegate-preview'], queryFn: budgetApi.delegatePreview });

  const run = useMutation({
    mutationFn: budgetApi.delegate,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not delegate.'),
  });

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/20 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delegate"
        className="w-full max-w-md rounded-lg border border-line bg-canvas p-4"
      >
        <h2 className="mb-1 text-section font-bold text-ink">Delegate</h2>

        {preview.isLoading ? (
          <p className="text-quiet text-muted">Working out what would be distributed…</p>
        ) : preview.data ? (
          <p className="mb-4 text-base text-ink">
            Distribute <strong>{formatCents(BigInt(preview.data.totalCents))}</strong> across{' '}
            <strong>{preview.data.lineCount}</strong>{' '}
            {preview.data.lineCount === 1 ? 'line' : 'lines'}.
            <span className="mt-2 block text-quiet text-muted">
              Lines with no amount receive nothing. This can be undone for a while afterwards.
            </span>
          </p>
        ) : null}

        {problem && <Alert>{problem}</Alert>}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => run.mutate()}
            disabled={run.isPending || preview.data?.lineCount === 0}
          >
            {run.isPending ? 'Delegating…' : 'Delegate'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The undo offer, shown only while the window is open. */
function UndoBar(): ReactNode {
  const queryClient = useQueryClient();
  const undo = useQuery({ queryKey: ['undo-preview'], queryFn: budgetApi.undoPreview });

  const run = useMutation({
    mutationFn: (runId: string) => budgetApi.undoDelegate(runId),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });

  if (!undo.data?.available || !undo.data.runId) return null;

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-2">
      <p className="text-quiet text-muted">
        Delegated {formatCents(BigInt(undo.data.totalCents ?? '0'))} across {undo.data.lineCount}{' '}
        lines.
        {/* Undoing moves the cycle boundary back too, so it is said here rather
            than discovered afterwards. */}
        <span className="ml-1">Undoing also rolls the budget cycle back.</span>
      </p>
      <Button onClick={() => run.mutate(undo.data.runId!)} disabled={run.isPending} variant="ghost">
        {run.isPending ? 'Undoing…' : 'Undo'}
      </Button>
    </div>
  );
}

export function MainBudget(): ReactNode {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'none' | 'delegate' | 'transfer' | 'check' | 'transaction'>(
    'none',
  );
  const [problem, setProblem] = useState<string | null>(null);
  // Set when Transfer was opened from a line whose archive was blocked.
  const [transferFrom, setTransferFrom] = useState<string | null>(null);
  const [newGrouping, setNewGrouping] = useState(false);

  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
  };

  /** The same view with one grouping folded or unfolded, and nothing else touched. */
  const withGroupingCollapsed = (
    view: BudgetViewDto,
    groupingId: string,
    collapsed: boolean,
  ): BudgetViewDto => {
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
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Something went wrong.');

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

  const createDelegation = useMutation({
    mutationFn: (name: string) => budgetApi.createDelegation(name, null),
    onSuccess: refresh,
    onError,
  });

  const createGrouping = useMutation({
    mutationFn: (name: string) => budgetApi.createGrouping(name, 'delegations'),
    onSuccess: async () => {
      setNewGrouping(false);
      await refresh();
    },
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

  /**
   * Moves a line one place, for anybody not using a mouse.
   *
   * Drag and drop is the fast route and it is not a keyboard one, so this is
   * the same operation reached from the row menu. It works out the neighbour
   * list here rather than asking the server to interpret "up".
   */
  function nudge(row: BudgetRowDto, direction: -1 | 1): void {
    const siblings =
      row.groupingId === null
        ? view.data!.delegations.ungrouped
        : (view.data!.delegations.groupings.find((grouping) => grouping.id === row.groupingId)
            ?.rows ?? []);

    const from = siblings.findIndex((sibling) => sibling.id === row.id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= siblings.length) return;

    const orderedIds = siblings.map((sibling) => sibling.id);
    orderedIds.splice(to, 0, ...orderedIds.splice(from, 1));

    placeDelegation.mutate({ id: row.id, groupingId: row.groupingId, orderedIds });
  }

  /**
   * Collapsing a grouping moves rows, not money.
   *
   * It used to wait for the round trip and then refetch the whole budget before
   * anything on screen changed, which put one to two seconds between the click
   * and the rows moving — for a preference the browser already knows the answer
   * to. The cache is updated first and the request follows; a failure puts it
   * back and says so.
   *
   * Settled rather than left alone. Nothing on this page *changes* because a
   * grouping is folded, so the refetch is not for correctness of the figures —
   * it is because another mutation's invalidation can land on top of an
   * optimistic value and quietly undo it. Re-reading once the write has settled
   * makes the server the last word without costing the instant response, which
   * has already happened by then.
   */
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

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the budget…</p>;
  if (view.error || !view.data) {
    return <Alert>Could not load the budget. {String(view.error ?? '')}</Alert>;
  }

  /**
   * Every line spending can be filed against.
   *
   * Outstanding checks are excluded. A check is a delegation, but it is not
   * somewhere spending goes — it is settled by matching the payment that cashes
   * it, which is a different act — so the picker in the new-transaction dialog
   * must not offer one. This is the same filter the Transactions page applies,
   * for the same reason.
   *
   * Transfer does not use this list. It takes the whole section, checks
   * included, because moving money onto or off a check is legitimate — and
   * because its dropdowns mirror the page's own grouping.
   */
  const spendable = [
    ...view.data.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...view.data.delegations.ungrouped,
  ]
    .filter((row) => row.kind !== 'check')
    .map((row) => ({ id: row.id, name: row.name }));

  const groupingOptionsFor = (section: {
    groupings: readonly { id: string; name: string }[];
  }): { id: string; name: string }[] =>
    section.groupings.map((grouping) => ({ id: grouping.id, name: grouping.name }));
  const groupingOptions = groupingOptionsFor(view.data.delegations);

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-page font-bold text-ink">Budget</h1>
          <p className="mt-1 text-quiet text-muted">
            {view.data.cycleStartedAt
              ? `This cycle began ${new Date(view.data.cycleStartedAt).toLocaleDateString()}.`
              : 'No delegate run yet — press Delegate on payday to start a cycle.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {newGrouping ? (
            <input
              autoFocus
              placeholder="Grouping name, then Enter"
              aria-label="Add a grouping"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setNewGrouping(false);
                if (event.key !== 'Enter') return;
                const name = event.currentTarget.value.trim();
                if (name !== '') createGrouping.mutate(name);
              }}
              className="rounded-lg border border-line bg-canvas px-2 py-1 text-quiet"
            />
          ) : (
            <Button onClick={() => setNewGrouping(true)}>Add grouping</Button>
          )}
          {/* Same wording as the button on the Transactions page: two controls
              that open the same dialog should read the same. */}
          <Button onClick={() => setDialog('transaction')}>Add transaction</Button>
          <Button onClick={() => setDialog('check')}>New check</Button>
          {/* Transfer sits to the left of Delegate, per the design. */}
          <Button onClick={() => setDialog('transfer')}>Transfer</Button>
          <Button variant="primary" onClick={() => setDialog('delegate')}>
            Delegate
          </Button>
        </div>
      </header>

      <BalanceBanner view={view.data} />
      <UndoBar />

      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      <BudgetSection
        title="Assets"
        section={view.data.assets}
        showAmountToDelegate={false}
        redNegatives={false}
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
        rowMenu={(row) => (
          <AccountRowMenu row={row} groupings={groupingOptionsFor(view.data.assets)} />
        )}
      />

      {/* Debts render in normal text, never red, despite being liabilities. */}
      <BudgetSection
        title="Debts"
        section={view.data.debts}
        showAmountToDelegate={false}
        redNegatives={false}
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
        rowMenu={(row) => (
          <AccountRowMenu row={row} groupings={groupingOptionsFor(view.data.debts)} />
        )}
      />

      <BudgetSection
        title="Delegations"
        section={view.data.delegations}
        showAmountToDelegate
        redNegatives
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
        onEditAmount={(id, cents) => editAmount.mutate({ id, cents })}
        onEditBalance={(id, cents) => editBalance.mutate({ id, cents })}
        onCreate={(name) => createDelegation.mutate(name)}
        onMoveToGrouping={(rowId, groupingId) => moveDelegation.mutate({ id: rowId, groupingId })}
        onPlace={(rowId, groupingId, orderedIds) =>
          placeDelegation.mutate({ id: rowId, groupingId, orderedIds })
        }
        rowMenu={(row) =>
          // A check is not a delegation to rename, re-file or adjust; its menu
          // offers only what the bank can decide.
          row.kind === 'check' ? (
            <CheckRowMenu row={row} />
          ) : (
            <DelegationRowMenu
              row={row}
              groupings={groupingOptions}
              onNudge={nudge}
              onTransferFrom={(delegationId) => {
                setTransferFrom(delegationId);
                setDialog('transfer');
              }}
            />
          )
        }
      />

      {dialog === 'transaction' && (
        <NewTransactionDialog delegations={spendable} onClose={() => setDialog('none')} />
      )}
      {dialog === 'check' && <NewCheckDialog view={view.data} onClose={() => setDialog('none')} />}
      {dialog === 'delegate' && <DelegateDialog onClose={() => setDialog('none')} />}
      {dialog === 'transfer' && (
        <TransferDialog
          section={view.data.delegations}
          {...(transferFrom === null ? {} : { initialFrom: transferFrom })}
          onClose={() => {
            setDialog('none');
            setTransferFrom(null);
          }}
        />
      )}
    </div>
  );
}
