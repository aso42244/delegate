import { suggestedMatchValue } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { rulesApi } from '../api/rules.js';
import type { TransactionDto } from '../api/transactions.js';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * "Always categorize like this" — a rule built from a row already filed.
 *
 * This is the on-ramp the rules engine never had. A rule could only be written
 * from Settings, against a merchant name somebody had to remember and type, so
 * the repetitive categorizations that most deserved a rule were exactly the ones
 * nobody stopped to write one for.
 *
 * The match text is a **field, not a fact**. The server's guess at where the
 * merchant name ends is only a guess — it cannot know that `TST*` is a payment
 * processor rather than the restaurant — and the expensive failure here is a
 * needle so broad it files future charges somewhere wrong. So the guess is shown
 * where it can be read and corrected before anything is created.
 */
export function RuleFromTransactionDialog({
  transaction,
  delegation,
  onClose,
}: {
  readonly transaction: TransactionDto;
  /** The delegation the row is already filed under; the rule assigns the same one. */
  readonly delegation: { readonly id: string; readonly name: string };
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [matchValue, setMatchValue] = useState(() =>
    suggestedMatchValue(transaction.descriptionRaw || transaction.description),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      rulesApi.createFromTransaction({
        transactionId: transaction.id,
        delegationId: delegation.id,
        matchValue: matchValue.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the rule.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Modal
      label={`Create a rule from ${transaction.description}`}
      title="New rule"
      description={`Files future matches into ${delegation.name}.`}
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          width="full"
          label="When the description contains"
          value={matchValue}
          onChange={(event) => setMatchValue(event.target.value)}
          autoComplete="off"
          hint={transaction.descriptionRaw || transaction.description}
        />

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={matchValue.trim() === ''}>
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
