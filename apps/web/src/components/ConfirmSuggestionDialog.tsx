import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type { SuggestionDto, TransactionDto } from '../api/transactions.js';
import { Button, Modal } from './ui.jsx';

/**
 * Confirming where a suggested row is filed, and offering to stop being asked.
 *
 * The suggestion chip used to categorize on one press. That is right for a
 * queue somebody is running down and wrong for the moment they are not sure:
 * the evidence — *14 of 15 before went to Groceries* — was on a `title`, which
 * is to say it was invisible to anybody not hovering, and the press was
 * immediate and silent.
 *
 * So the press asks. The evidence is on screen, and the three answers are the
 * three things a person actually means:
 *
 * - **Not that one.** Closes, files nothing, and leaves the row a question. The
 *   picker beside it is the way to say what it really is — which is where they
 *   were going anyway.
 * - **Confirm.** Files it, once.
 * - **Confirm and always.** Files it and opens the rule dialog, so the next one
 *   arrives categorized. This is the route from a decision made by hand to one
 *   that stops being made, and it is offered at the exact moment the decision is
 *   being confirmed rather than buried in a row menu.
 *
 * Nothing here decides anything on its own: the same propose-never-act line as
 * a cleared check, a transfer pair and a possible duplicate.
 */
export function ConfirmSuggestionDialog({
  transaction,
  suggestion,
  onConfirm,
  onConfirmAndRule,
  onClose,
}: {
  readonly transaction: TransactionDto;
  readonly suggestion: SuggestionDto;
  /** Files it. */
  readonly onConfirm: () => void;
  /** Files it, then opens the rule dialog on the same row. */
  readonly onConfirmAndRule: () => void;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Modal
      label={`Categorize ${transaction.description}`}
      title="File this where the last ones went?"
      description={`${suggestion.matchCount} of the last ${suggestion.totalCount} charges from this merchant went to ${suggestion.delegationName}.`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {/* The row itself, so the decision is made against the charge rather
            than against the memory of which row was pressed. */}
        <dl className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-label text-muted">Charge</dt>
            <dd className="min-w-0 truncate text-quiet text-ink">{transaction.description}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-label text-muted">Amount</dt>
            <dd className="money text-quiet text-ink">
              {formatCents(BigInt(transaction.amountCents))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-label text-muted">Delegation</dt>
            <dd className="text-quiet font-semibold text-accent">{suggestion.delegationName}</dd>
          </div>
        </dl>

        {/*
          Three buttons, in the order of how much each one commits to. The
          refusal is named — "Not Groceries" rather than "Cancel" — because
          `Cancel` says what happens to the dialog and this says what happens to
          the charge, which is the thing being decided.
        */}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Not {suggestion.delegationName}
          </Button>
          <Button type="button" onClick={onConfirm}>
            Confirm delegation
          </Button>
          <Button type="button" variant="primary" onClick={onConfirmAndRule}>
            Confirm and always
          </Button>
        </div>

        <p className="text-label text-muted">
          <strong className="font-semibold">Confirm and always</strong> files this one and writes a
          rule, so the next charge from this merchant arrives already categorized. You choose what
          the rule matches on before it is created.
        </p>
      </div>
    </Modal>
  );
}
