import { formatCents, formatCentsForInput, splitEvenly, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { transactionsApi, type TransactionDto } from '../api/transactions.js';
import { DelegationPicker, type DelegationOption } from './DelegationPicker.jsx';
import { Alert, Button, Modal } from './ui.jsx';

/**
 * Splitting one transaction across several delegations.
 *
 * Splits are rare, which is exactly why this is a deliberate screen rather than
 * something reachable by accident from the categorization queue. The rule that
 * matters is that the parts sum to the whole: the server rejects a set that does
 * not, so the work here is showing the owner the remainder as he types instead
 * of letting him discover it at the point of saving.
 *
 * Amounts are typed as **magnitudes**. Spending is stored negative, and asking
 * for four negative numbers that add up to a fifth negative number is a way to
 * get a sign wrong; the transaction's own sign is applied on save. A split whose
 * parts point in opposite directions is not expressible here, which is
 * deliberate — that is two transactions, not one.
 */

interface SplitRow {
  readonly key: number;
  readonly delegationId: string | null;
  readonly delegationName: string | null;
  readonly amountText: string;
}

/** Parses a row's magnitude. Null when it is empty or not a number. */
function rowMagnitude(row: SplitRow): bigint | null {
  const trimmed = row.amountText.trim();
  if (trimmed === '') return null;
  const parsed = tryParseMoney(trimmed);
  if (!parsed.ok) return null;
  return parsed.value < 0n ? -parsed.value : parsed.value;
}

export function SplitDialog({
  transaction,
  delegations,
  onClose,
}: {
  readonly transaction: TransactionDto;
  readonly delegations: readonly DelegationOption[];
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const nextKey = useRef(0);

  const total = BigInt(transaction.amountCents);
  const sign = total < 0n ? -1n : 1n;
  const totalMagnitude = total < 0n ? -total : total;

  const [rows, setRows] = useState<readonly SplitRow[]>(() => {
    const existing = transaction.allocations.map((allocation): SplitRow => {
      const amount = BigInt(allocation.amountCents);
      return {
        key: nextKey.current++,
        delegationId: allocation.delegationId,
        delegationName: allocation.delegation.name,
        amountText: formatCentsForInput(amount < 0n ? -amount : amount),
      };
    });

    // An uncategorized transaction opens on two empty lines, because reaching
    // this dialog at all means the intention is to split it.
    if (existing.length >= 2) return existing;
    const blank = (): SplitRow => ({
      key: nextKey.current++,
      delegationId: null,
      delegationName: null,
      amountText: '',
    });
    return existing.length === 1 ? [...existing, blank()] : [blank(), blank()];
  });
  const [problem, setProblem] = useState<string | null>(null);

  const allocated = rows.reduce<bigint>((sum, row) => sum + (rowMagnitude(row) ?? 0n), 0n);
  const remainder = totalMagnitude - allocated;
  const everyRowComplete = rows.every(
    (row) => row.delegationId !== null && rowMagnitude(row) !== null && rowMagnitude(row) !== 0n,
  );
  // Only lines that have been filled in count: two blank lines are the starting
  // state, not a mistake to warn about.
  const chosen = rows.map((row) => row.delegationId).filter((id): id is string => id !== null);
  const duplicated = new Set(chosen).size !== chosen.length;
  const canSave = everyRowComplete && !duplicated && remainder === 0n;

  function patchRow(key: number, patch: Partial<SplitRow>): void {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow(): void {
    setRows((previous) => [
      ...previous,
      { key: nextKey.current++, delegationId: null, delegationName: null, amountText: '' },
    ]);
  }

  function removeRow(key: number): void {
    setRows((previous) => previous.filter((row) => row.key !== key));
  }

  /** Fills the amounts evenly, handing the remainder cent to the first line. */
  function fillEvenly(): void {
    const shares = splitEvenly(totalMagnitude, rows.length);
    setRows((previous) =>
      previous.map((row, index) => ({
        ...row,
        amountText: formatCentsForInput(shares[index] ?? 0n),
      })),
    );
  }

  const save = useMutation({
    mutationFn: () => {
      // Save is disabled until every line is complete; this narrows the types
      // for the same reason rather than asserting them away.
      const allocations = rows.flatMap((row) => {
        const magnitude = rowMagnitude(row);
        if (row.delegationId === null || magnitude === null) return [];
        return [{ delegationId: row.delegationId, amountCents: (magnitude * sign).toString() }];
      });
      return transactionsApi.setAllocations(transaction.id, allocations);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save the split.'),
  });

  const clear = useMutation({
    mutationFn: () => transactionsApi.uncategorize(transaction.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not clear the categorization.'),
  });

  /*
   * The verdict, the errors and the buttons, kept out of the scrolling body.
   *
   * The remainder is the one number that decides whether this can save, and an
   * error raised by pressing Save has to be visible from where Save was
   * pressed. On a phone with the keyboard up the body scrolls, so anything left
   * inside it can be the part that is not on screen.
   */
  const footer = (
    <div className="flex flex-col gap-2">
      {/* Stated in words as well as colour. */}
      <p
        className={`text-quiet ${remainder === 0n ? 'text-positive' : 'text-warning'}`}
        role="status"
      >
        {remainder === 0n
          ? 'Balanced — the parts add up to the whole.'
          : remainder > 0n
            ? `${formatCents(remainder)} left to allocate.`
            : `${formatCents(-remainder)} over-allocated.`}
      </p>

      {duplicated && (
        <Alert>Two lines use the same delegation. Combine them into one amount.</Alert>
      )}
      {problem && <Alert>{problem}</Alert>}

      <div className="flex justify-between gap-2">
        {transaction.allocations.length > 0 ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
          >
            {clear.isPending ? 'Clearing…' : 'Clear categorization'}
          </Button>
        ) : (
          <span />
        )}

        <div className="flex gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save split'}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      label={`Split ${transaction.description}`}
      title="Split"
      description={`${transaction.description} — ${formatCents(total)}. The parts must add up to the whole.`}
      onClose={onClose}
      width="lg"
      footer={footer}
    >
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={row.key} className="flex items-end gap-2">
            <div className="flex-1">
              <span className="mb-1 block text-quiet font-medium text-ink">
                Delegation {index + 1}
              </span>
              <DelegationPicker
                options={delegations}
                {...(row.delegationName ? { currentName: row.delegationName } : {})}
                label={`Delegation for split line ${index + 1}`}
                onChoose={(chosenId) =>
                  patchRow(row.key, {
                    delegationId: chosenId,
                    delegationName:
                      delegations.find((option) => option.id === chosenId)?.name ?? null,
                  })
                }
              />
            </div>

            <div className="w-32">
              <span className="mb-1 block text-quiet font-medium text-ink">Amount</span>
              {/* The accessible name carries the line number, since "Amount"
                  alone appears once per line and names none of them. */}
              <input
                value={row.amountText}
                onChange={(event) => patchRow(row.key, { amountText: event.target.value })}
                aria-label={`Amount for split line ${index + 1}`}
                inputMode="decimal"
                placeholder="0.00"
                className="field money money-input rounded-lg border border-line bg-canvas px-2 text-base"
              />
            </div>

            <Button
              type="button"
              variant="ghost"
              onClick={() => removeRow(row.key)}
              disabled={rows.length <= 1}
              aria-label={`Remove split line ${index + 1}`}
            >
              Remove
            </Button>
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Button type="button" onClick={addRow}>
            Add line
          </Button>
          <Button type="button" onClick={fillEvenly}>
            Split evenly
          </Button>
        </div>
      </div>
    </Modal>
  );
}
