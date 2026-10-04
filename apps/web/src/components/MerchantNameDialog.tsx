import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { recurringApi } from '../api/recurring.js';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * A name of the household's own for a merchant (ADR 079).
 *
 * One name per merchant, wherever it is set from — a bill on Recurring or a
 * charge in the register — and shown wherever that merchant's charges are. The
 * bank's description is never changed: it stays on the row, beside the name.
 */
export function MerchantNameDialog({
  merchantKey,
  feedName,
  currentName,
  onClose,
}: {
  readonly merchantKey: string;
  /** What the bank calls it. Placeholder, label and the thing kept underneath. */
  readonly feedName: string;
  /** The name it has now, or null for the bank's. */
  readonly currentName: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      recurringApi.override({
        key: merchantKey,
        label: feedName,
        // Empty means "use what the bank calls it", which is where every
        // merchant starts. Not the same as a name that happens to be blank.
        displayName: name.trim() === '' ? null : name.trim(),
      }),
    onSuccess: async () => {
      // Every list that shows a merchant, because the name is on all of them.
      await queryClient.invalidateQueries({ queryKey: ['recurring'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['month-review'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that name.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Name ${feedName}`}
      title="Name this merchant"
      description="Shown on every charge from it. What the bank sent stays underneath."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Name"
          width="full"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={feedName}
          autoComplete="off"
          autoFocus
        />

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A charge's merchant: the household's name where there is one, with what the
 * bank sent beside it, muted — so a rename never hides what the statement says.
 */
export function MerchantText({
  description,
  merchantName,
}: {
  readonly description: string;
  readonly merchantName: string | null;
}): ReactNode {
  if (merchantName === null) {
    return (
      <span className="truncate text-ink" title={description}>
        {description}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2" title={`${merchantName} · ${description}`}>
      <span className="shrink-0 text-ink">{merchantName}</span>
      <span className="truncate text-quiet text-muted">{description}</span>
    </span>
  );
}
