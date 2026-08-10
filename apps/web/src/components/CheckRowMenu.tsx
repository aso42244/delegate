import { formatCents } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { BudgetRowDto } from '../api/budget.js';
import { checksApi } from '../api/checks.js';
import { ApiError } from '../api/client.js';
import { DelegationHistory } from './DelegationHistory.jsx';
import { ITEM_CLASS, RowMenuShell } from './RowMenuShell.jsx';
import { Alert, Button, Modal } from './ui.jsx';

/**
 * The per-row menu for an outstanding check.
 *
 * Deliberately much shorter than a delegation's. A check is not something to
 * rename, re-file or adjust — it is a record of a piece of paper that exists.
 * The only two things that can happen to it are the two the bank decides: it
 * gets cashed, or it never does.
 */

function VoidDialog({
  row,
  onClose,
}: {
  readonly row: BudgetRowDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const discard = useMutation({
    mutationFn: () => checksApi.void(row.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['checks'] });
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof ApiError ? error.message : 'That check could not be voided.');
    },
  });

  return (
    <Modal
      label={`Void check ${row.checkNumber ?? ''}`}
      title={`Void check ${row.checkNumber ?? ''}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-quiet text-muted">
          For a check that will never be cashed — lost, spoiled, or torn up.{' '}
          {formatCents(BigInt(row.balanceCents))} goes back to the delegation it came from, and this
          line is archived rather than deleted.
        </p>

        <p className="text-quiet text-muted">
          If the check <em>was</em> cashed, match it to the payment on the Transactions page
          instead.
        </p>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => discard.mutate()} disabled={discard.isPending}>
            {discard.isPending ? 'Voiding…' : 'Void check'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CheckRowMenu({ row }: { readonly row: BudgetRowDto }): ReactNode {
  const [dialog, setDialog] = useState<'none' | 'void' | 'history'>('none');

  return (
    <RowMenuShell
      name={row.name}
      // A check lives in the grouping the budget owns and is not moved out of it.
      groupings={[]}
      currentGroupingId={row.groupingId}
      onMoveToGrouping={() => undefined}
      header={
        <p className="mx-1 my-1 rounded-md bg-surface px-2 py-1.5 text-quiet text-muted">
          Written{' '}
          {row.checkIssuedAt ? new Date(row.checkIssuedAt).toLocaleDateString() : 'recently'}.
          Waiting to be cashed.
        </p>
      }
      overlay={
        <>
          {dialog === 'void' && <VoidDialog row={row} onClose={() => setDialog('none')} />}
          {dialog === 'history' && (
            <DelegationHistory
              delegationId={row.id}
              delegationName={row.name}
              onClose={() => setDialog('none')}
            />
          )}
        </>
      }
    >
      {(controls) => (
        <>
          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => {
              setDialog('history');
              controls.close();
            }}
          >
            History
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => {
              setDialog('void');
              controls.close();
            }}
          >
            Void check
          </button>
        </>
      )}
    </RowMenuShell>
  );
}
