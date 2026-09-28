import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { checksApi, type OutstandingCheckDto } from '../api/checks.js';
import { ApiError } from '../api/client.js';
import type { TransactionDto } from '../api/transactions.js';
import { Alert, Button, Modal } from './ui.jsx';

/**
 * Matching a transaction to an outstanding check by hand.
 *
 * The automatic match needs the exact amount *and* the check number as a whole
 * token in the description, which most banks provide and some do not. This is
 * the way through when they do not — and the way to correct a check whose
 * number was mistyped when it was recorded.
 *
 * Amounts that do not agree are shown rather than hidden. The bank is the record
 * of what was paid, so a mismatch is settled in the bank's favour and the
 * difference lands on the delegation the check was drawn on; saying so before
 * the click is the difference between a correction and a surprise.
 */

function difference(check: OutstandingCheckDto, transaction: TransactionDto): bigint {
  return BigInt(check.balanceCents) + BigInt(transaction.amountCents);
}

export function MatchCheckDialog({
  transaction,
  onClose,
}: {
  readonly transaction: TransactionDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const checks = useQuery({ queryKey: ['checks'], queryFn: checksApi.list });

  const match = useMutation({
    mutationFn: (checkId: string) => checksApi.match(checkId, transaction.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['checks'] });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof ApiError ? error.message : 'That check could not be matched.');
    },
  });

  const open = checks.data?.checks ?? [];

  return (
    <Modal
      label={`Match ${transaction.description} to an outstanding check`}
      title="Match to an outstanding check"
      description={`${transaction.description} — ${formatCents(BigInt(transaction.amountCents))}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        {problem && <Alert>{problem}</Alert>}

        {checks.isLoading && <p className="text-quiet text-muted">Loading…</p>}

        {!checks.isLoading && open.length === 0 && (
          <p className="text-quiet text-muted">
            No checks are outstanding. Record one from the Budget page first.
          </p>
        )}

        {open.map((check) => {
          const gap = difference(check, transaction);

          return (
            <div
              key={check.id}
              className="flex items-center gap-2 rounded-lg border border-line p-3"
            >
              <div className="flex-1">
                <p className="text-ink">
                  Check {check.checkNumber}
                  {check.memo ? ` — ${check.memo}` : ''}
                </p>
                <p className="text-quiet text-muted">
                  {formatCents(BigInt(check.balanceCents))}
                  {check.sourceName ? ` from ${check.sourceName}` : ''}, written{' '}
                  {new Date(check.issuedAt).toLocaleDateString()}
                </p>
                {gap !== 0n && (
                  <p className="text-quiet font-semibold text-warning">
                    {gap < 0n
                      ? `The bank took ${formatCents(-gap)} more than this check was written for.`
                      : `The bank took ${formatCents(gap)} less than this check was written for.`}{' '}
                    The difference will be left on {check.sourceName ?? 'the delegation'}.
                  </p>
                )}
              </div>

              <Button
                variant="primary"
                onClick={() => match.mutate(check.id)}
                disabled={match.isPending}
              >
                Match
              </Button>
            </div>
          );
        })}

        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
