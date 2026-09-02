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
import { INTERVAL_CHOICES, MAX_INTERVAL_MONTHS } from './target-intervals.js';
import { Alert, Button, Modal, SelectField, TextField, Toggle } from './ui.jsx';

/**
 * Setting what a line is saving towards.
 *
 * The thing this dialog has to make unmistakable is what a target **does not**
 * do. It never changes the amount to delegate on its own. That figure is the
 * household's decision, typed by hand every payday, and an application that
 * quietly rewrote it would be moving real money on the next Delegate press for a
 * reason nobody asked for.
 *
 * So the arithmetic is shown rather than applied: what each remaining paycheck
 * would have to carry, beside what this line is actually set to. Taking it is a
 * deliberate switch — and the figure it offers is **editable**, because the
 * calculated amount is the common answer and not the only one. Somebody rounding
 * $274.38 up to $300 should not have to close this and go and type it on the row.
 *
 * The reading is computed here from `@budget/shared`, the same function the
 * server uses for the row. Two copies of it would be two answers, one in the box
 * where somebody is deciding and one on the row they are deciding about.
 */

/** `2026-12-27` from a date input, as the date key the API expects. */
function dayValue(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

/** Midnight UTC for a `YYYY-MM-DD`, which is how every date key here is filed. */
function dayKey(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
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

  /*
   * The interval as text, so the select can hold "once" and "custom" alongside
   * the numbers without a second piece of state to keep in step.
   */
  const storedInterval = row.target?.intervalMonths ?? null;
  const [repeat, setRepeat] = useState<string>(() =>
    storedInterval === null
      ? 'once'
      : INTERVAL_CHOICES.some((choice) => choice.months === storedInterval)
        ? String(storedInterval)
        : 'custom',
  );
  const [customMonths, setCustomMonths] = useState(() =>
    storedInterval === null ? '' : String(storedInterval),
  );

  const [alsoSetAmount, setAlsoSetAmount] = useState(false);
  /** Null until it is touched, so the calculated figure keeps updating underneath. */
  const [delegateAmount, setDelegateAmount] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const parsedAmount = tryParseMoney(amount);
  const targetCents = parsedAmount.ok && parsedAmount.value > 0n ? parsedAmount.value : null;

  const intervalMonths =
    repeat === 'once'
      ? null
      : repeat === 'custom'
        ? Number.parseInt(customMonths, 10) || null
        : Number.parseInt(repeat, 10);

  /*
   * The live reading, against what is typed rather than what is stored — which
   * is the point of showing it here: somebody trying a date or an interval sees
   * the per-paycheck figure move before committing to it.
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
            targetDate: date === '' ? null : dayKey(date),
            targetIntervalMonths: date === '' ? null : intervalMonths,
          },
          cadence,
          // Midnight today, in the reader's own day. The server recomputes this
          // in the household's zone when it answers; a preview a day out at the
          // very edge is a smaller cost than a preview that does not move.
          dayKey(new Date().toISOString().slice(0, 10)),
        );

  const needed = preview?.neededPerCycleCents ?? null;
  const delegating = row.amountToDelegateCents === null ? null : BigInt(row.amountToDelegateCents);

  // What the switch would apply: the calculated figure until somebody types over it.
  const delegateValue = delegateAmount ?? (needed === null ? '' : formatCentsForInput(needed));
  const parsedDelegate = tryParseMoney(delegateValue);

  const save = useMutation({
    mutationFn: () => {
      if (targetCents === null) {
        throw new ApiError(400, 'invalid_target', 'Enter a target amount like 2200.00.');
      }
      if (date !== '' && repeat !== 'once' && intervalMonths === null) {
        throw new ApiError(400, 'invalid_interval', 'Enter how many months, as a whole number.');
      }
      if (alsoSetAmount && !parsedDelegate.ok) {
        throw new ApiError(400, 'invalid_amount', 'Enter an amount to delegate like 275.00.');
      }

      return budgetApi.updateDelegation(row.id, {
        targetCents: targetCents.toString(),
        targetDate: date === '' ? null : date,
        targetIntervalMonths: date === '' ? null : intervalMonths,
        // Only when asked for. This is the one thing in this dialog that moves
        // money on the next Delegate press, so it happens because somebody
        // turned it on — and it sends what is in the box, which may not be the
        // figure that was calculated.
        ...(alsoSetAmount && parsedDelegate.ok
          ? { amountToDelegateCents: parsedDelegate.value.toString() }
          : {}),
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
    // Null clears the amount, and the server clears the date and the interval
    // with it: a date with no amount is a deadline for nothing.
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

  const dueLabel =
    preview?.targetDate == null
      ? null
      : preview.targetDate.toLocaleDateString(undefined, {
          timeZone: 'UTC',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });

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

          {/*
            The date above is one occurrence rather than a deadline once this is
            set — so a bill due on the last day of April and again on the last
            day of October is entered once, and the reading moves to the next one
            by itself instead of going stale.
          */}
          {date !== '' && (
            <SelectField
              label="Repeats"
              width="md"
              value={repeat}
              onChange={setRepeat}
              {...(repeat !== 'once' && dueLabel !== null ? { hint: `Next: ${dueLabel}.` } : {})}
            >
              <option value="once">Once</option>
              {INTERVAL_CHOICES.map((choice) => (
                <option key={choice.months} value={String(choice.months)}>
                  {choice.label}
                </option>
              ))}
              <option value="custom">Every…</option>
            </SelectField>
          )}

          {date !== '' && repeat === 'custom' && (
            <TextField
              label="Months apart"
              width="sm"
              value={customMonths}
              onChange={(event) => setCustomMonths(event.target.value)}
              inputMode="numeric"
              hint={`1 to ${MAX_INTERVAL_MONTHS}.`}
            />
          )}
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
                    : ` over ${preview.cyclesRemaining} more, by ${dueLabel}.`}
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
              <>
                <label className="mt-4 flex items-center gap-2 text-quiet text-ink">
                  <Toggle
                    checked={alsoSetAmount}
                    onChange={setAlsoSetAmount}
                    label="Also set the amount to delegate"
                  />
                  Also set the amount to delegate
                </label>

                {/* Pre-filled with the calculated figure and editable, because
                    that number is the common answer rather than the only one —
                    rounding it up to something memorable is a decision somebody
                    should be able to make here rather than on the row
                    afterwards. */}
                {alsoSetAmount && (
                  <div className="mt-2">
                    <TextField
                      label="Amount to delegate"
                      width="sm"
                      value={delegateValue}
                      onChange={(event) => setDelegateAmount(event.target.value)}
                      inputMode="decimal"
                      className="money"
                      hint={`Calculated: ${formatCents(needed)}.`}
                    />
                  </div>
                )}
              </>
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
