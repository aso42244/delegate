import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { DelegationHistory } from './DelegationHistory.jsx';
import { ITEM_CLASS, RowMenuShell, type GroupingOption } from './RowMenuShell.jsx';
import { Alert, Button, Modal, TextArea, TextField, Toggle } from './ui.jsx';

/**
 * The per-row menu on the Budget page.
 *
 * Everything a delegation needs that is not a number in a cell: its name, the
 * utility flag, a manual adjustment, its history, which grouping it sits in, and
 * archiving.
 *
 * It says **Archive**, never Delete. Nothing in this system is hard-deleted —
 * archived rows keep resolving so an eight-month-old transaction still renders
 * "Grocery (archived)" — and a menu item labelled Delete would name behaviour
 * that does not exist.
 */

type Dialog = 'none' | 'rename' | 'note' | 'adjust' | 'history';

/** Rename. Its own dialog, because a name is worth seeing while it is typed. */
function RenameDialog({
  row,
  onClose,
}: {
  readonly row: BudgetRowDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState(row.name);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => budgetApi.updateDelegation(row.id, { name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not rename this line.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal label={`Rename ${row.name}`} title="Rename" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <TextField
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={name.trim() === '' || name.trim() === row.name || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The note.
 *
 * Freeform text with no structure, deliberately: the owner writes "$2200,
 * Dec 27" and does the per-cycle arithmetic himself. Structured target fields
 * were declined, and a text column keeps them a purely additive migration later.
 */
function NoteDialog({
  row,
  onClose,
}: {
  readonly row: BudgetRowDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(row.notes ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    // An emptied box clears the note rather than storing a blank string, so the
    // panel disappears instead of rendering an empty quotation.
    mutationFn: () =>
      budgetApi.updateDelegation(row.id, { notes: notes.trim() === '' ? null : notes.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save the note.'),
  });

  return (
    <Modal
      label={`Note for ${row.name}`}
      title="Note to self"
      description="Anything you want beside this line. Plain text — nothing here is parsed."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <TextArea
          label="Note"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="$2,200, Dec 27"
          autoFocus
        />
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save note'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Manual adjustment.
 *
 * The field is the movement, not the destination: the ledger records a delta, so
 * asking for a target and subtracting behind the owner's back would put a number
 * in the history he never typed. The resulting balance is previewed instead.
 */
function AdjustDialog({
  row,
  suggestedDeltaCents,
  onClose,
}: {
  readonly row: BudgetRowDto;
  /** Prefilled when the adjustment is being offered to clear an archive block. */
  readonly suggestedDeltaCents?: bigint | undefined;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const balance = BigInt(row.balanceCents);
  const [amount, setAmount] = useState(
    suggestedDeltaCents === undefined
      ? ''
      : formatCents(suggestedDeltaCents, { currencySymbol: false, grouping: false }),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const parsed = tryParseMoney(amount.trim());
  const delta = parsed.ok ? parsed.value : null;

  const save = useMutation({
    mutationFn: () => {
      if (delta === null) {
        throw new ApiError(400, 'invalid_amount', 'Enter a movement like 25.00 or -25.00.');
      }
      return budgetApi.adjustDelegationByDelta(row.id, delta.toString());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['delegation-history', row.id] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not adjust this line.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Manually adjust ${row.name}`}
      title="Manually adjust"
      description="Records a movement, not a new total. It appears in this line's history and nowhere else."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <p className="text-quiet text-muted">
          {row.name} currently reads <strong className="text-ink">{formatCents(balance)}</strong>.
        </p>

        <TextField
          label="Add or remove"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="25.00, or -25.00 to take money out"
          className="money"
          autoFocus
        />

        {delta !== null && delta !== 0n && (
          <p className="text-quiet text-muted">
            It will read <strong className="text-ink">{formatCents(balance + delta)}</strong>{' '}
            afterwards.
          </p>
        )}

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={delta === null || delta === 0n || save.isPending}
          >
            {save.isPending ? 'Adjusting…' : 'Adjust'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DelegationRowMenu({
  row,
  groupings,
  onTransferFrom,
}: {
  readonly row: BudgetRowDto;
  readonly groupings: readonly GroupingOption[];
  /** Opens the page's Transfer dialog with this line as the source. */
  readonly onTransferFrom: (delegationId: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>('none');
  const [blocked, setBlocked] = useState<string | null>(null);

  const balance = BigInt(row.balanceCents);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const setUtility = useMutation({
    mutationFn: (isUtility: boolean) => budgetApi.updateDelegation(row.id, { isUtility }),
    onSuccess: refresh,
  });

  const moveToGrouping = useMutation({
    mutationFn: (groupingId: string | null) => budgetApi.updateDelegation(row.id, { groupingId }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () => budgetApi.archiveDelegation(row.id),
    onSuccess: refresh,
    onError: (error: unknown) => {
      // Archiving is blocked unless the balance is exactly zero, because
      // archiving money would break the identity by that amount with nothing on
      // screen to explain it. The block is shown here with the two ways out.
      setBlocked(error instanceof ApiError ? error.message : 'This line could not be archived.');
    },
  });

  return (
    <RowMenuShell
      name={row.name}
      groupings={groupings}
      currentGroupingId={row.groupingId}
      onMoveToGrouping={(groupingId) => moveToGrouping.mutate(groupingId)}
      header={
        row.notes ? (
          <p className="mx-1 my-1 rounded-md bg-surface px-2 py-1.5 text-quiet text-muted italic">
            {row.notes}
          </p>
        ) : null
      }
      overlay={
        <>
          {dialog === 'rename' && <RenameDialog row={row} onClose={() => setDialog('none')} />}
          {dialog === 'note' && <NoteDialog row={row} onClose={() => setDialog('none')} />}
          {dialog === 'adjust' && (
            <AdjustDialog
              row={row}
              // Offered from a blocked archive, the movement that zeroes the line
              // is the one the owner wants; anywhere else it starts empty.
              {...(blocked !== null && balance !== 0n ? { suggestedDeltaCents: -balance } : {})}
              onClose={() => {
                setDialog('none');
                setBlocked(null);
              }}
            />
          )}
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
      {(controls) =>
        blocked ? (
          <div className="flex flex-col gap-2 p-1">
            <Alert>{blocked}</Alert>
            {/* Both ways to zero it, offered here rather than sending the owner
                off to find them. */}
            <Button
              onClick={() => {
                setDialog('adjust');
                controls.close();
              }}
            >
              Adjust to zero
            </Button>
            <Button
              onClick={() => {
                onTransferFrom(row.id);
                setBlocked(null);
                controls.close();
              }}
            >
              Transfer it out
            </Button>
            <Button variant="ghost" onClick={() => setBlocked(null)}>
              Back
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={() => {
                setDialog('rename');
                controls.close();
              }}
            >
              Rename
            </button>

            <div className={ITEM_CLASS}>
              <span>Utility</span>
              <Toggle
                checked={row.isUtility}
                onChange={(next) => setUtility.mutate(next)}
                label={`${row.name} is a utility`}
              />
            </div>

            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={() => {
                setDialog('note');
                controls.close();
              }}
            >
              {row.notes ? 'Edit note' : 'Add a note'}
            </button>

            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={() => {
                setDialog('adjust');
                controls.close();
              }}
            >
              Manually adjust this line
            </button>

            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={() => {
                setDialog('history');
                controls.close();
              }}
            >
              History for this line
            </button>

            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={controls.openGroupingPanel}
            >
              <span>Move to grouping</span>
              <span aria-hidden>▸</span>
            </button>

            <div className="my-1 border-t border-line" />

            <button
              type="button"
              role="menuitem"
              className={`${ITEM_CLASS} text-danger`}
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
            >
              Archive
            </button>
          </>
        )
      }
    </RowMenuShell>
  );
}
