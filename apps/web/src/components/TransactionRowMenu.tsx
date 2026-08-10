import type { ReactNode } from 'react';
import type { TransactionDto } from '../api/transactions.js';
import { ITEM_CLASS, RowMenuShell } from './RowMenuShell.jsx';

/**
 * The per-row menu on the Transactions page.
 *
 * Splitting and matching a check are both uncommon — the ordinary act on this
 * page is categorizing, which stays a field in the row. Two permanent buttons
 * beside every one of sixty rows made the rare thing as loud as the frequent
 * one, and pushed the delegation picker into a narrower column than it wants.
 */
export function TransactionRowMenu({
  transaction,
  onSplit,
  onMatchCheck,
}: {
  readonly transaction: TransactionDto;
  readonly onSplit: () => void;
  readonly onMatchCheck: () => void;
}): ReactNode {
  return (
    <RowMenuShell name={transaction.description}>
      {(controls) => (
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
        </>
      )}
    </RowMenuShell>
  );
}
