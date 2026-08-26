import { tryParseMoney, type TransactionKind } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../api/accounts.js';
import { ApiError } from '../api/client.js';
import { transactionsApi } from '../api/transactions.js';
import { DelegationPicker, type DelegationOption } from './DelegationPicker.jsx';
import { SegmentedControl } from './layout.jsx';
import { Alert, Button, Modal, SelectField, TextField } from './ui.jsx';

/**
 * Entering a transaction by hand.
 *
 * Two accounts the household holds are not carried by any feed — SimpleFIN does
 * not support them — so this is not a rare path. It is how those registers stay
 * true, and how cash spending gets into the budget at all.
 *
 * The amount is typed as a **magnitude** with a direction beside it, rather than
 * as a signed number. Internally money out of an account is negative, but nobody
 * types a minus sign in front of the groceries, and a sign mistyped here would
 * move an envelope the wrong way by twice the amount.
 */

/** Today in the local timezone, formatted for `<input type="date">`. */
function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

type Direction = 'out' | 'in';

const KIND_LABELS: Record<TransactionKind, string> = {
  normal: 'Spending or refund',
  income: 'Income',
  transfer: 'Transfer between my accounts',
};

export function NewTransactionDialog({
  delegations,
  onClose,
}: {
  readonly delegations: readonly DelegationOption[];
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [accountId, setAccountId] = useState('');
  const [postedAt, setPostedAt] = useState(todayForInput());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<Direction>('out');
  const [kind, setKind] = useState<TransactionKind>('normal');
  const [delegationId, setDelegationId] = useState<string | null>(null);
  const [delegationName, setDelegationName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const liveAccounts = accounts.data?.accounts ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const parsed = tryParseMoney(amount);
      if (!parsed.ok) {
        throw new ApiError(400, 'invalid_amount', 'Enter an amount like 42.10.');
      }

      // The field is a magnitude; the direction carries the sign. A typed minus
      // is honoured as a magnitude rather than fighting the toggle.
      const magnitude = parsed.value < 0n ? -parsed.value : parsed.value;
      if (magnitude === 0n) {
        throw new ApiError(400, 'zero_amount', 'A transaction cannot be for nothing.');
      }
      const amountCents = direction === 'out' ? -magnitude : magnitude;

      const created = await transactionsApi.create({
        accountId,
        amountCents: amountCents.toString(),
        description: description.trim(),
        // Midday UTC, so the date the owner picked survives being read back in
        // any timezone either side of the line.
        postedAt: `${postedAt}T12:00:00.000Z`,
        kind,
      });

      // Categorizing here saves a trip through the queue for a row whose
      // envelope the owner already knows. Reported separately if it fails: the
      // transaction is saved either way, and saying otherwise would be a lie.
      if (kind === 'normal' && delegationId !== null) {
        try {
          await transactionsApi.categorize(created.transaction.id, delegationId);
        } catch (error) {
          throw new ApiError(
            500,
            'saved_not_categorized',
            `Saved, but it could not be categorized: ${
              error instanceof ApiError ? error.message : 'unknown error'
            }. Categorize it from the list.`,
          );
        }
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      // The account balance and, if it was categorized, an envelope both moved.
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save the transaction.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setProblem(null);
    save.mutate();
  }

  const incomplete = accountId === '' || description.trim() === '' || amount.trim() === '';

  return (
    <Modal
      label="Add a transaction"
      title="Add a transaction"
      description="For cash and for the accounts no feed covers. The balance of the account you choose moves by this amount."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <SelectField label="Account" value={accountId} onChange={setAccountId}>
          <option value="">Choose an account</option>
          {liveAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
              {account.inBudget ? '' : ' (off budget)'}
            </option>
          ))}
        </SelectField>

        <TextField
          width="full"
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Farmers market"
          autoComplete="off"
        />

        <div className="flex gap-2">
          <div className="flex-1">
            <TextField
              width="full"
              label="Date"
              type="date"
              value={postedAt}
              onChange={(event) => setPostedAt(event.target.value)}
            />
          </div>
          <div className="flex-1">
            <TextField
              width="full"
              label="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="42.10"
              className="money"
              autoComplete="off"
            />
          </div>
        </div>

        {/* One control, not two buttons with one of them turned primary — the
            same choice-of-a-few the Insights window and the tile switchers make,
            so it is the same control. */}
        <div>
          <p className="mb-1 text-quiet font-medium text-ink">Direction</p>
          <SegmentedControl
            label="Direction"
            value={direction}
            options={[
              { value: 'out', label: 'Money out' },
              { value: 'in', label: 'Money in' },
            ]}
            onChange={setDirection}
          />
        </div>

        <SelectField
          width="full"
          label="Kind"
          value={kind}
          onChange={(value) => {
            const next = value as TransactionKind;
            setKind(next);
            // Income is money arriving, and a transaction that allocates to
            // nothing cannot carry the delegation chosen a moment ago.
            if (next === 'income') setDirection('in');
            if (next !== 'normal') {
              setDelegationId(null);
              setDelegationName(null);
            }
          }}
        >
          {Object.entries(KIND_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </SelectField>

        {kind === 'normal' && (
          <div>
            <span className="mb-1 block text-quiet font-medium text-ink">
              Delegation (optional)
            </span>
            <DelegationPicker
              options={delegations}
              {...(delegationName ? { currentName: delegationName } : {})}
              label="Delegation for this transaction"
              onChoose={(chosenId) => {
                setDelegationId(chosenId);
                setDelegationName(
                  delegations.find((option) => option.id === chosenId)?.name ?? null,
                );
              }}
            />
            <p className="mt-1 text-quiet text-muted">
              Leave this empty to categorize it later from the queue.
            </p>
          </div>
        )}

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={incomplete || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
