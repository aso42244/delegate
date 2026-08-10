import { tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { BudgetViewDto } from '../api/budget.js';
import { checksApi } from '../api/checks.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal, SelectField, TextField } from './ui.jsx';

/**
 * Recording a check that has been written but not yet cashed.
 *
 * The money leaves the delegation immediately and sits on a line of its own
 * until the bank catches up. That is the whole point: between writing a check
 * and it clearing, the envelope shows money that is already committed, and
 * spending it twice is an easy mistake to make with a chequebook.
 */

/** Today in the local timezone, formatted for `<input type="date">`. */
function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function NewCheckDialog({
  view,
  onClose,
}: {
  readonly view: BudgetViewDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const [checkNumber, setCheckNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [issuedAt, setIssuedAt] = useState(todayForInput());
  const [memo, setMemo] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Only ordinary envelopes. A check cannot be drawn on another check, and
   * offering one would be offering to move money that is already committed.
   */
  const sources = [
    ...view.delegations.groupings.flatMap((grouping) => grouping.rows),
    ...view.delegations.ungrouped,
  ]
    .filter((row) => row.kind === 'envelope')
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const write = useMutation({
    mutationFn: () => {
      const parsed = tryParseMoney(amount);
      if (!parsed.ok || parsed.value <= 0n) {
        throw new ApiError(400, 'invalid_amount', 'Enter the amount of the check, like 120.00.');
      }
      if (!sourceId) {
        throw new ApiError(400, 'no_source', 'Choose where the money is coming from.');
      }

      return checksApi.write({
        checkNumber: checkNumber.trim(),
        amountCents: parsed.value.toString(),
        // Sent as a plain date; the server stores the day it was written.
        issuedAt: new Date(`${issuedAt}T00:00:00`).toISOString(),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        sourceDelegationId: sourceId,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['checks'] });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(
        error instanceof ApiError ? error.message : 'Could not record that check. Try again.',
      );
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    write.mutate();
  }

  return (
    <Modal label="New outstanding check" title="New outstanding check" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <p className="text-quiet text-muted">
          The amount moves out of the delegation now and waits on its own line until the check is
          cashed.
        </p>

        <TextField
          label="Check number"
          value={checkNumber}
          onChange={(event) => setCheckNumber(event.target.value)}
          inputMode="numeric"
          autoFocus
          required
          hint="How the check is identified when several are outstanding."
        />

        <TextField
          label="Amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className="money"
          required
        />

        <TextField
          label="Date written"
          type="date"
          value={issuedAt}
          onChange={(event) => setIssuedAt(event.target.value)}
          required
        />

        <SelectField label="Money comes from" value={sourceId} onChange={setSourceId}>
          <option value="">Choose a delegation…</option>
          {sources.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </SelectField>

        <TextField
          label="Memo"
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          hint="Optional. Shown beside the check number on the budget."
        />

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={write.isPending}>
            {write.isPending ? 'Recording…' : 'Record check'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
