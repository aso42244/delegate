import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type { TransactionDto } from '../api/transactions.js';
import { Chips } from './Chip.jsx';
import type { ChipKind } from './chips.js';

/**
 * One transaction, on a phone.
 *
 * A separate layout rather than the register's table taught to reflow. Six
 * columns do not become two lines by wrapping — the decision is which facts
 * share a line and which are dropped, and that is easier to read as its own
 * component than as eight breakpoints threaded through a `<tr>`.
 *
 * Two lines, and the split is what the row is *for*. The first says what the
 * charge is and what it cost: the two facts that identify it, with the amount
 * keeping its tabular alignment down the column. The second leads with what to
 * do about it — a chip that opens the picker, which is the only reason this page
 * is open on a phone at all — and the date and account follow it, quiet.
 */
export function TransactionCard({
  transaction,
  chips,
  categorizedAs,
  onCategorize,
  menu,
}: {
  readonly transaction: TransactionDto;
  readonly chips: readonly ChipKind[];
  /** The delegation it is filed under, or null while it waits for a decision. */
  readonly categorizedAs: string | null;
  readonly onCategorize: () => void;
  /** The row's own `⋯` menu, rendered by the caller so the card stays dumb. */
  readonly menu: ReactNode;
}): ReactNode {
  const amount = BigInt(transaction.amountCents);
  const split = transaction.allocations.length > 1;
  // Income and confirmed transfers allocate to nothing by definition, so there
  // is nothing to pick and no control that would imply otherwise.
  const decidable = transaction.kind === 'normal';

  return (
    <li className="border-b border-line py-2.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-ink" title={transaction.description}>
          {transaction.description}
        </span>
        <Chips kinds={chips} />
        <span className="flex-1" />
        <span
          className={`money text-hero ${amount > 0n ? 'font-semibold text-positive' : 'text-ink'}`}
        >
          {formatCents(amount, { explicitPlus: true })}
        </span>
      </div>

      {/*
        The control leads the second line, the facts follow it.
        
        It used to sit on the right, where a variable-width pill under a column
        of right-aligned amounts made a ragged edge down the page — and the one
        thing on the row you are meant to tap moved sideways with every row. On
        the left it starts in the same place every time.
      */}
      <div className="mt-1.5 flex items-center gap-2">
        {decidable ? (
          /*
           * A chip, not a field.
           *
           * A full-width text box on every row reads as sixty things waiting to
           * be typed into, and on a phone nobody types into it — they tap it and
           * pick. So it is sized like what it is: a small control that opens the
           * picker, showing the answer once there is one.
           */
          <button
            type="button"
            onClick={onCategorize}
            aria-label={`Categorize ${transaction.description}`}
            className={`touch-target max-w-[60%] shrink-0 truncate rounded-full border px-3 py-1 text-quiet font-semibold ${
              categorizedAs
                ? 'border-line bg-surface-2 text-ink'
                : 'border-accent bg-accent-soft text-accent'
            }`}
          >
            {split
              ? `Split across ${transaction.allocations.length}`
              : (categorizedAs ?? 'Categorize')}
          </button>
        ) : (
          <span className="shrink-0 text-quiet text-muted">—</span>
        )}

        <span className="min-w-0 flex-1 truncate text-label text-faint">
          {new Date(transaction.postedAt).toLocaleDateString(undefined, {
            month: 'numeric',
            day: 'numeric',
          })}{' '}
          · {transaction.account.name}
        </span>

        {/* The real row menu — split, match a check, archive, say what the row
            is. Its trigger is always drawn here, because the rule that hides it
            is a hover a touchscreen cannot perform. */}
        <span className="-mr-1 shrink-0">{menu}</span>
      </div>
    </li>
  );
}
