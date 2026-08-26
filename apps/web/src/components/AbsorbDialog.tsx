import { formatCents, formatCentsForInput, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * Closing the reading at the top of the Budget page against one line.
 *
 * Positive means money has landed and not been handed to an envelope; negative
 * means the envelopes hold more than exists. Either way the fix was the same
 * chore: read the figure, open the row menu, choose Manually adjust, and type
 * in a number the page had already worked out.
 *
 * The three choices are the three things anybody actually does with it, and an
 * option that would be refused is offered disabled with the reason rather than
 * hidden — hiding it makes the interface look arbitrary, and the reason is
 * usually the thing worth knowing.
 *
 * `all` and `zero_line` send no amount. The server recomputes the difference
 * when the request lands, so "all of it" means all of it *then* rather than
 * whatever was on screen when the dialog opened.
 */

type Mode = 'all' | 'zero_line' | 'custom';

interface Choice {
  readonly mode: Mode;
  readonly label: string;
  readonly hint: string;
  /** Null when it can be chosen; otherwise why it cannot. */
  readonly blocked: string | null;
}

/** The three choices, and why each is or is not available. */
function choicesFor(differenceCents: bigint, balanceCents: bigint): Choice[] {
  const surplus = differenceCents > 0n;
  const magnitude = surplus ? differenceCents : -differenceCents;

  if (surplus) {
    const overSpent = balanceCents < 0n;
    const shortfall = -balanceCents;

    return [
      {
        mode: 'all',
        label: `Move all ${formatCents(magnitude)} here`,
        hint: 'Leaves the budget balanced.',
        blocked: null,
      },
      {
        mode: 'zero_line',
        label: `Bring this line back to zero`,
        hint: overSpent
          ? `Adds ${formatCents(shortfall)}, which is what it is over-spent by.`
          : 'For a line that is over-spent.',
        blocked: !overSpent
          ? 'This line is not over-spent.'
          : magnitude < shortfall
            ? `There is only ${formatCents(magnitude)} to delegate, and this line is ${formatCents(shortfall)} down.`
            : null,
      },
      { mode: 'custom', label: 'Some of it', hint: '', blocked: null },
    ];
  }

  return [
    {
      mode: 'all',
      label: `Cover the whole ${formatCents(magnitude)} from here`,
      hint: 'Leaves the budget balanced.',
      blocked:
        balanceCents < magnitude
          ? `This line holds ${formatCents(balanceCents)}, which is not enough.`
          : null,
    },
    {
      mode: 'zero_line',
      label: 'Empty this line into it',
      hint:
        balanceCents > 0n
          ? `Puts all ${formatCents(balanceCents)} against it.`
          : 'For a line that cannot cover the whole thing.',
      blocked:
        balanceCents <= 0n
          ? 'This line holds nothing to put against it.'
          : balanceCents >= magnitude
            ? 'This line can cover the whole thing, so emptying it would overshoot.'
            : null,
    },
    { mode: 'custom', label: 'Some of it', hint: '', blocked: null },
  ];
}

export function AbsorbDialog({
  row,
  differenceCents,
  onClose,
  onProblem,
}: {
  readonly row: BudgetRowDto;
  /** The identity reading: positive is surplus, negative is over-delegated. */
  readonly differenceCents: bigint;
  readonly onClose: () => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const surplus = differenceCents > 0n;
  const magnitude = surplus ? differenceCents : -differenceCents;
  const balance = BigInt(row.balanceCents);

  const choices = choicesFor(differenceCents, balance);
  /*
   * Opens on the first choice that can actually be taken.
   *
   * Defaulting to the whole amount put a disabled option under the cursor and a
   * disabled Apply beside it whenever the line could not cover the difference —
   * which is exactly the case somebody opens this dialog to deal with.
   */
  const [mode, setMode] = useState<Mode>(
    choices.find((choice) => choice.blocked === null)?.mode ?? 'custom',
  );
  // Pre-filled with the whole of it, since that is the commonest custom amount
  // to start editing from.
  const [amount, setAmount] = useState(formatCentsForInput(magnitude));
  const [problem, setProblem] = useState<string | null>(null);

  const parsed = tryParseMoney(amount);

  const absorb = useMutation({
    mutationFn: () => {
      if (mode !== 'custom') return budgetApi.absorb(row.id, mode);
      if (!parsed.ok || parsed.value <= 0n) {
        throw new ApiError(400, 'invalid_amount', 'Enter an amount like 12.22.');
      }
      return budgetApi.absorb(row.id, 'custom', parsed.value.toString());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof ApiError ? error.message : 'That could not be applied. Please try again.';
      setProblem(message);
      onProblem(message);
    },
  });

  const chosen = choices.find((choice) => choice.mode === mode);
  const unavailable = chosen?.blocked ?? null;

  return (
    <Modal
      label={surplus ? `Move surplus into ${row.name}` : `Fix the shortfall from ${row.name}`}
      title={surplus ? 'Move surplus here' : 'Fix deficit from here'}
      description={
        surplus
          ? `${formatCents(magnitude)} has landed and is not in an envelope yet. ${row.name} holds ${formatCents(balance)}.`
          : `The envelopes hold ${formatCents(magnitude)} more than exists. ${row.name} holds ${formatCents(balance)}.`
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          absorb.mutate();
        }}
        className="flex flex-col gap-2"
      >
        <div role="radiogroup" aria-label="How much" className="flex flex-col gap-2">
          {choices.map((choice) => (
            <label
              key={choice.mode}
              className={`flex items-start gap-2 rounded-lg border p-2 ${
                mode === choice.mode ? 'border-accent bg-accent-soft' : 'border-line'
              } ${choice.blocked ? 'opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="absorb-mode"
                className="mt-1"
                checked={mode === choice.mode}
                disabled={choice.blocked !== null}
                onChange={() => {
                  setMode(choice.mode);
                  setProblem(null);
                }}
              />
              <span className="block">
                <span className="block text-quiet text-ink">{choice.label}</span>
                {/* The reason it cannot be chosen, where the hint would be:
                    hiding the option would make the dialog look arbitrary. */}
                <span className="block text-label text-muted">{choice.blocked ?? choice.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === 'custom' && (
          <TextField
            width="full"
            label={surplus ? 'Amount to move here' : 'Amount to take from this line'}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            className="money"
            autoFocus
            hint={`At most ${formatCents(magnitude)}.`}
          />
        )}

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={absorb.isPending || unavailable !== null}
          >
            {absorb.isPending ? 'Working…' : 'Apply'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
