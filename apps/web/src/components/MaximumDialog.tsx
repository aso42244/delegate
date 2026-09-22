import { formatCents, formatCentsForInput, maximumProgress, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * Setting the most a line may hold.
 *
 * The companion to `TargetDialog`, and the opposite half of the same sentence. A
 * target says what a line is saving towards and never moves a penny (ADR 047);
 * a maximum is the one that writes — it caps what the next Delegate press puts
 * in. So where that dialog spends its space saying what it does *not* do, this
 * one spends its space saying exactly what it **will** do, with the household's
 * own figures in it.
 *
 * The reading is computed here from `@budget/shared`, the same function the
 * server uses for the row and the run itself uses for the ledger. Two copies of
 * it would be two answers — one in the box where somebody is deciding, and one
 * in the press they are deciding about.
 *
 * **Where the money goes is the sentence that matters**, and it is not "into the
 * next line". Nothing is redistributed: what a maximum holds back simply stays
 * undelegated, which is the figure at the top of the page, and is therefore
 * offered back for whatever that payday actually needs.
 */
export function MaximumDialog({
  row,
  onClose,
}: {
  readonly row: BudgetRowDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState(() =>
    row.max === null ? '' : formatCentsForInput(BigInt(row.max.maxBalanceCents)),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const parsed = tryParseMoney(amount);
  const maxBalanceCents = parsed.ok && parsed.value > 0n ? parsed.value : null;

  const balance = BigInt(row.balanceCents);
  const delegating = row.amountToDelegateCents === null ? null : BigInt(row.amountToDelegateCents);

  /*
   * What the next press would do under the maximum being typed, rather than the
   * one that is stored. That is the point of showing it here: somebody trying a
   * figure sees what it costs this payday before committing to it.
   */
  const preview =
    maxBalanceCents === null
      ? null
      : maximumProgress({
          balanceCents: balance,
          amountToDelegateCents: delegating,
          maxBalanceCents,
        });

  /*
   * A target above the maximum is not refused, and is worth saying out loud.
   *
   * It is a coherent thing to want — fund a line to $400 a payday and top the
   * rest up by transfer — but it is far more often a figure typed into the wrong
   * box, and a line that can never reach its target by delegating is exactly the
   * sort of quiet miss the target reading exists to surface rather than create.
   */
  const targetAbove =
    maxBalanceCents !== null &&
    row.target !== null &&
    BigInt(row.target.targetCents) > maxBalanceCents
      ? formatCents(BigInt(row.target.targetCents))
      : null;

  const save = useMutation({
    mutationFn: () => {
      if (maxBalanceCents === null) {
        throw new ApiError(400, 'invalid_maximum', 'Enter a maximum like 400.00.');
      }
      return budgetApi.updateDelegation(row.id, { maxBalanceCents: maxBalanceCents.toString() });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that maximum.'),
  });

  const clear = useMutation({
    // Null clears it, and nothing else goes with it: a maximum stands on its own
    // in a way a target's date and interval do not.
    mutationFn: () => budgetApi.updateDelegation(row.id, { maxBalanceCents: null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not clear that maximum.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Set a maximum for ${row.name}`}
      title="Maximum"
      description={`${row.name} holds ${formatCents(balance)}.`}
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Maximum"
          width="sm"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className="money"
          hint="Leave empty for no maximum."
          autoFocus
        />

        {/*
          What the next press does, stated in this line's own figures.

          Not a hint under the field: this is the answer somebody opened the
          dialog to get, and it moves as they type — the same shape the target's
          reading takes, for the same reason.
        */}
        {preview !== null && (
          <div className="rounded-lg border border-line bg-surface p-4">
            {delegating === null ? (
              <p className="text-quiet text-ink">
                This line is ad hoc — it receives nothing when Delegate is pressed — so the maximum
                has nothing to hold back yet. Set an amount to delegate and it will stop there.
              </p>
            ) : preview.status === 'room' ? (
              <p className="text-quiet text-ink">
                {formatCents(preview.roomCents)} of room left, so the next Delegate puts the whole{' '}
                <strong className="text-ink">{formatCents(delegating)}</strong> in.
              </p>
            ) : preview.status === 'partial' ? (
              <p className="text-quiet text-ink">
                The next Delegate puts{' '}
                <strong className="text-ink">{formatCents(preview.delegatingCents)}</strong> in
                rather than {formatCents(delegating)}. The other{' '}
                {formatCents(preview.withheldCents)} stays available to delegate.
              </p>
            ) : (
              <p className="text-quiet text-ink">
                This line is already at its maximum, so the next Delegate adds{' '}
                <strong className="text-ink">nothing</strong> and all{' '}
                {formatCents(preview.withheldCents)} stays available to delegate.
              </p>
            )}
          </div>
        )}

        {targetAbove !== null && (
          <p className="text-quiet text-muted">
            This line has a target of {targetAbove}, which is above the maximum — delegating alone
            will never reach it. A transfer still can.
          </p>
        )}

        <p className="text-quiet text-muted">
          A maximum caps Delegate and nothing else. A transfer, a refund or a manual adjustment may
          still take this line past it, and what Delegate holds back is not moved anywhere — it
          stays available at the top of the page.
        </p>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          {row.max !== null && (
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
          <Button
            type="submit"
            variant="primary"
            disabled={maxBalanceCents === null || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
