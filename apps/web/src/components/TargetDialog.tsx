import {
  formatCents,
  formatCentsForInput,
  targetProgress,
  tryParseMoney,
  type PayCadence,
} from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal, TextField, Toggle } from './ui.jsx';

/**
 * Setting what a line is saving towards.
 *
 * The thing this dialog has to make unmistakable is what a target **does not**
 * do. It never changes the amount to delegate. That figure is the household's
 * decision, typed by hand every payday, and an application that quietly rewrote
 * it would be moving real money on the next Delegate press for a reason nobody
 * asked for.
 *
 * So the arithmetic is shown rather than applied: what each remaining paycheck
 * would have to carry, beside what this line is actually set to. Taking the
 * figure is one press and one explicit switch, and afterwards it is an ordinary
 * amount to delegate — typed over, cleared, or left alone like any other.
 *
 * The reading is computed here from `@budget/shared`, the same function the
 * server uses for the row. Two copies of it would be two answers, one in the
 * box where somebody is deciding and one on the row they are deciding about.
 */

/** `2026-12-27` from a date input, as the date key the API expects. */
function dayValue(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

export function TargetDialog({
  row,
  cadence,
  onClose,
}: {
  readonly row: BudgetRowDto;
  /** How often money lands, which is what turns a shortfall into a per-paycheck figure. */
  readonly cadence: PayCadence;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState(() =>
    row.target === null ? '' : formatCentsForInput(BigInt(row.target.targetCents)),
  );
  const [date, setDate] = useState(() => dayValue(row.target?.targetDate ?? null));
  const [alsoSetAmount, setAlsoSetAmount] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const parsedAmount = tryParseMoney(amount);
  const targetCents = parsedAmount.ok && parsedAmount.value > 0n ? parsedAmount.value : null;

  /*
   * The live reading, against what is typed rather than what is stored — which
   * is the whole point of showing it here: somebody trying a date sees the
   * per-paycheck figure move before they commit to it.
   */
  const preview =
    targetCents === null
      ? null
      : targetProgress(
          {
            balanceCents: BigInt(row.balanceCents),
            amountToDelegateCents:
              row.amountToDelegateCents === null ? null : BigInt(row.amountToDelegateCents),
            targetCents,
            targetDate: date === '' ? null : new Date(`${date}T00:00:00.000Z`),
          },
          cadence,
          // Midnight today, in the reader's own day. The server recomputes this
          // in the household's zone when it answers; a preview a day out at the
          // very edge is a smaller cost than a preview that does not move.
          new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'),
        );

  const needed = preview?.neededPerCycleCents ?? null;
  const delegating = row.amountToDelegateCents === null ? null : BigInt(row.amountToDelegateCents);

  const save = useMutation({
    mutationFn: () => {
      if (targetCents === null) {
        throw new ApiError(400, 'invalid_target', 'Enter a target amount like 2200.00.');
      }
      return budgetApi.updateDelegation(row.id, {
        targetCents: targetCents.toString(),
        targetDate: date === '' ? null : date,
        // Only when asked for, and only when there is a figure to apply. This is
        // the one thing in this dialog that moves money on the next Delegate
        // press, so it happens because somebody turned it on.
        ...(alsoSetAmount && needed !== null ? { amountToDelegateCents: needed.toString() } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that target.'),
  });

  const clear = useMutation({
    // Null clears the amount, and the server clears the date with it: a date
    // with no amount is a deadline for nothing.
    mutationFn: () => budgetApi.updateDelegation(row.id, { targetCents: null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not clear that target.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Set a target for ${row.name}`}
      title="Target"
      description={`${row.name} holds ${formatCents(BigInt(row.balanceCents))}.`}
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <TextField
            label="Target amount"
            width="sm"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            className="money"
          />

          <TextField
            label="By"
            width="sm"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            hint="Optional."
          />
        </div>

        {/*
          The reading, and the sentence that says what it is for.

          Not a hint under a field: this is the answer somebody opened the dialog
          to get, and it moves as they type. The comparison is stated in both
          directions — what is needed, and what the line is actually set to —
          because either figure alone leaves the reader to remember the other.
        */}
        {preview !== null && (
          <div className="rounded-lg border border-line bg-surface p-4">
            {preview.status === 'met' ? (
              <p className="text-quiet text-ink">
                Already there. {row.name} holds {formatCents(BigInt(row.balanceCents))}.
              </p>
            ) : preview.status === 'standing' ? (
              <p className="text-quiet text-ink">
                {formatCents(preview.shortfallCents)} short. With no date there is no schedule to
                work out — add one to see what each paycheck needs to carry.
              </p>
            ) : (
              <>
                <p className="text-quiet text-ink">
                  Needs <strong className="text-ink">{formatCents(needed ?? 0n)}</strong> a paycheck
                  {preview.cyclesRemaining === 0
                    ? ', and the date has passed.'
                    : ` over ${preview.cyclesRemaining} more.`}
                </p>
                <p className="mt-1 text-quiet text-muted">
                  This line is set to delegate{' '}
                  {delegating === null ? 'nothing' : formatCents(delegating)}.
                </p>
              </>
            )}

            {/* The one control here that changes what gets delegated, and it is
                off unless somebody turns it on. */}
            {needed !== null && (
              <label className="mt-4 flex items-center gap-2 text-quiet text-ink">
                <Toggle
                  checked={alsoSetAmount}
                  onChange={setAlsoSetAmount}
                  label={`Also set the amount to delegate to ${formatCents(needed)}`}
                />
                Also set the amount to delegate to {formatCents(needed)}
              </label>
            )}
          </div>
        )}

        <p className="text-quiet text-muted">
          A target changes nothing on its own. It works out what each paycheck needs to carry and
          marks the amount when it is not enough.
        </p>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          {row.target !== null && (
            <Button
              type="button"
              variant="danger"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
            >
              Remove
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={targetCents === null || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
