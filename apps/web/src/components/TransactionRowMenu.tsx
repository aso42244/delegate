import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { transactionsApi, type TransactionDto } from '../api/transactions.js';
import { ITEM_CLASS, RowMenuShell } from './RowMenuShell.jsx';

/**
 * The per-row menu on the Transactions page.
 *
 * Splitting, matching a check, and saying what a row *is* are all uncommon —
 * the ordinary act on this page is categorizing, which stays a field in the
 * row. Two permanent buttons beside every one of sixty rows made the rare thing
 * as loud as the frequent one, and pushed the delegation picker into a narrower
 * column than it wants.
 */

/** What each label means, said from the reader's side rather than the schema's. */
const KIND_ITEMS = [
  {
    kind: 'income' as const,
    label: 'Mark as income',
    hint: 'Money arriving. Delegate distributes it; it belongs to no envelope on its own.',
  },
  {
    kind: 'transfer' as const,
    label: 'Mark as a transfer between my accounts',
    hint: 'A card or loan payment. Not spending — the spending was budgeted when the card was used.',
  },
  {
    kind: 'normal' as const,
    label: 'Mark as ordinary spending',
    hint: 'Put it back in the queue to be categorized.',
  },
];

export function TransactionRowMenu({
  transaction,
  onSplit,
  onMatchCheck,
  onProblem,
}: {
  readonly transaction: TransactionDto;
  readonly onSplit: () => void;
  readonly onMatchCheck: () => void;
  /** Surfaced on the page, because the menu closes before the request answers. */
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();

  const setKind = useMutation({
    mutationFn: (kind: 'normal' | 'income' | 'transfer') =>
      transactionsApi.setKind(transaction.id, kind),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) => {
      onProblem(
        error instanceof ApiError ? error.message : 'That transaction could not be re-labelled.',
      );
    },
  });

  return (
    <RowMenuShell name={transaction.description}>
      {(controls) => (
        <>
          {transaction.kind === 'normal' && (
            <>
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => {
                  onSplit();
                  controls.close();
                }}
              >
                Split between delegations
              </button>
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => {
                  onMatchCheck();
                  controls.close();
                }}
              >
                Match to an outstanding check
              </button>
              <div className="my-1 border-t border-line" />
            </>
          )}

          {KIND_ITEMS.filter((item) => item.kind !== transaction.kind).map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className={`${ITEM_CLASS} flex-col items-start gap-0`}
              onClick={() => {
                setKind.mutate(item.kind);
                controls.close();
              }}
            >
              <span>{item.label}</span>
              <span className="text-label text-muted">{item.hint}</span>
            </button>
          ))}
        </>
      )}
    </RowMenuShell>
  );
}
