import { formatCents } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { checksApi, type CheckMatchDto } from '../api/checks.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Modal } from './ui.jsx';

/**
 * Confirming that the payment the bank took is the check that was written.
 *
 * A sync used to settle these by itself when the amount and the check number
 * both agreed. The criteria were sound, but settling a check moves money between
 * envelopes and archives a line, and it happened unattended with a log entry as
 * its only trace. Now it is proposed and a person says yes. See ADR 030.
 *
 * The dialog shows both sides in full rather than asserting the match, because
 * the whole point of asking is that the reader can disagree. And it says how to
 * disagree: there is no "no" button, since a proposal is recomputed from the
 * data every time it is asked for and would simply return. What makes it go away
 * is categorizing the payment as whatever it actually was.
 */
export function ConfirmCheckMatchDialog({
  match,
  onClose,
}: {
  readonly match: CheckMatchDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: () => checksApi.match(match.checkId, match.transactionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['budget'] }),
        queryClient.invalidateQueries({ queryKey: ['checks'] }),
        queryClient.invalidateQueries({ queryKey: ['checkMatches'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      ]);
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That check could not be settled.'),
  });

  const amount = formatCents(BigInt(match.checkBalanceCents));
  const source = match.sourceName ?? 'the delegation it was drawn on';

  return (
    <Modal
      label={`Confirm that check ${match.checkNumber} was cashed`}
      title={`Did check ${match.checkNumber} clear?`}
      description="Both sides in full, so you can say no by simply not saying yes."
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        {problem && <Alert>{problem}</Alert>}

        <div className="rounded-lg border border-confirm-line bg-confirm-soft p-3">
          <p className="text-quiet font-semibold text-confirm">You wrote</p>
          <p className="text-ink">
            Check {match.checkNumber}
            {match.memo ? ` — ${match.memo}` : ''}
          </p>
          <p className="text-quiet text-muted">
            <span className="money">{amount}</span> from {source}
          </p>
        </div>

        <div className="rounded-lg border border-line p-3">
          <p className="text-quiet font-semibold text-muted">The bank took</p>
          <p className="text-ink">{match.description}</p>
          <p className="text-quiet text-muted">
            <span className="money">{formatCents(BigInt(match.amountCents))}</span> from{' '}
            {match.accountName} on {new Date(match.postedAt).toLocaleDateString()}
          </p>
        </div>

        {/* The amounts agree exactly or this was never proposed, so there is no
            difference to warn about here — unlike the manual match, which will
            settle an amount that disagrees and says where the gap lands. */}
        <p className="text-quiet text-muted">
          Confirming allocates the payment to {source} and closes the check. If this is not the same
          money, leave it and categorize the payment as whatever it was — the suggestion goes away
          on its own.
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            {confirm.isPending ? 'Settling…' : 'Yes, it cleared'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
