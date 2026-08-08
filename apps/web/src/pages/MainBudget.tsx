import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { budgetApi } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { BalanceBanner } from '../components/BalanceBanner.jsx';
import { BudgetSection } from '../components/BudgetSection.jsx';
import { Alert, Button } from '../components/ui.jsx';

/**
 * The Main Budget — the page that replaces the spreadsheet.
 *
 * Every mutation invalidates the whole view rather than patching a row locally.
 * The identity at the top depends on all three sections at once, so a partial
 * update would leave the headline figure disagreeing with the rows beneath it,
 * which is the one thing this page cannot do.
 */

function TransferDialog({
  delegations,
  onClose,
}: {
  delegations: readonly { id: string; name: string }[];
  onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState('');
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
              {delegations.map((delegation) => (
                <option key={delegation.id} value={delegation.id}>
                  {delegation.name}
                </option>
              ))}
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
              {delegations
                .filter((delegation) => delegation.id !== from)
                .map((delegation) => (
                  <option key={delegation.id} value={delegation.id}>
                    {delegation.name}
                  </option>
                ))}
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
  const [dialog, setDialog] = useState<'none' | 'delegate' | 'transfer'>('none');
  const [problem, setProblem] = useState<string | null>(null);

  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries();
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

  const toggleGrouping = useMutation({
    mutationFn: ({ id, collapsed }: { id: string; collapsed: boolean }) =>
      budgetApi.setGroupingCollapsed(id, collapsed),
    onSuccess: refresh,
    onError,
  });

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the budget…</p>;
  if (view.error || !view.data) {
    return <Alert>Could not load the budget. {String(view.error ?? '')}</Alert>;
  }

  const delegations = [
    ...view.data.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...view.data.delegations.ungrouped,
  ].map((row) => ({ id: row.id, name: row.name }));

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-page font-bold text-ink">Main Budget</h1>
          <p className="mt-1 text-quiet text-muted">
            {view.data.cycleStartedAt
              ? `This cycle began ${new Date(view.data.cycleStartedAt).toLocaleDateString()}.`
              : 'No delegate run yet — press Delegate on payday to start a cycle.'}
          </p>
        </div>

        <div className="flex gap-2">
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
      />

      {/* Debts render in normal text, never red, despite being liabilities. */}
      <BudgetSection
        title="Debts"
        section={view.data.debts}
        showAmountToDelegate={false}
        redNegatives={false}
        onToggleGrouping={(id, collapsed) => toggleGrouping.mutate({ id, collapsed })}
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
      />

      {dialog === 'delegate' && <DelegateDialog onClose={() => setDialog('none')} />}
      {dialog === 'transfer' && (
        <TransferDialog delegations={delegations} onClose={() => setDialog('none')} />
      )}
    </div>
  );
}
