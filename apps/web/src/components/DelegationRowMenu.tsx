import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../api/budget.js';
import { ApiError } from '../api/client.js';
import { DelegationHistory } from './DelegationHistory.jsx';
import { Alert, Button, Modal, TextArea, TextField, Toggle } from './ui.jsx';

/**
 * The per-row menu on the Main Budget.
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

export interface GroupingOption {
  readonly id: string;
  readonly name: string;
}

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
  const containerRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'root' | 'grouping'>('root');
  const [dialog, setDialog] = useState<Dialog>('none');
  const [blocked, setBlocked] = useState<string | null>(null);

  const balance = BigInt(row.balanceCents);

  function close(): void {
    setOpen(false);
    setPanel('root');
    setBlocked(null);
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const setUtility = useMutation({
    mutationFn: (isUtility: boolean) => budgetApi.updateDelegation(row.id, { isUtility }),
    onSuccess: refresh,
  });

  const moveToGrouping = useMutation({
    mutationFn: (groupingId: string | null) => budgetApi.updateDelegation(row.id, { groupingId }),
    onSuccess: async () => {
      await refresh();
      close();
    },
  });

  const archive = useMutation({
    mutationFn: () => budgetApi.archiveDelegation(row.id),
    onSuccess: async () => {
      await refresh();
      close();
    },
    onError: (error: unknown) => {
      // Archiving is blocked unless the balance is exactly zero, because
      // archiving money would break the identity by that amount with nothing on
      // screen to explain it. The block is shown here with the two ways out.
      setBlocked(error instanceof ApiError ? error.message : 'This line could not be archived.');
    },
  });

  const itemClass =
    'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-quiet text-ink hover:bg-surface-2';

  return (
    <div ref={containerRef} className="relative flex justify-end">
      {/* Revealed on hover, and always reachable by keyboard: a control that
          exists only under a mouse pointer is a control some people never get. */}
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={`Options for ${row.name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded px-2 py-0.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        ⋯
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Options for ${row.name}`}
          className="absolute top-full right-0 z-20 w-[250px] rounded-[10px] border border-line bg-canvas p-2 shadow-[0_4px_16px_rgba(0,0,0,.10)]"
        >
          {panel === 'root' ? (
            <>
              <p className="px-2 py-1 text-quiet font-semibold text-ink">{row.name}</p>

              {row.notes && (
                <p className="mx-1 my-1 rounded-md bg-surface px-2 py-1.5 text-quiet text-muted italic">
                  {row.notes}
                </p>
              )}

              {blocked ? (
                <div className="flex flex-col gap-2 p-1">
                  <Alert>{blocked}</Alert>
                  {/* Both ways to zero it, offered here rather than sending the
                      owner off to find them. */}
                  <Button
                    onClick={() => {
                      setDialog('adjust');
                      setOpen(false);
                    }}
                  >
                    Adjust to zero
                  </Button>
                  <Button
                    onClick={() => {
                      onTransferFrom(row.id);
                      close();
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
                    className={itemClass}
                    onClick={() => {
                      setDialog('rename');
                      setOpen(false);
                    }}
                  >
                    Rename
                  </button>

                  <div className={itemClass}>
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
                    className={itemClass}
                    onClick={() => {
                      setDialog('note');
                      setOpen(false);
                    }}
                  >
                    {row.notes ? 'Edit note' : 'Add a note'}
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      setDialog('adjust');
                      setOpen(false);
                    }}
                  >
                    Manually adjust this line
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      setDialog('history');
                      setOpen(false);
                    }}
                  >
                    History for this line
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => setPanel('grouping')}
                  >
                    <span>Move to grouping</span>
                    <span aria-hidden>▸</span>
                  </button>

                  <div className="my-1 border-t border-line" />

                  <button
                    type="button"
                    role="menuitem"
                    className={`${itemClass} text-danger`}
                    onClick={() => archive.mutate()}
                    disabled={archive.isPending}
                  >
                    Archive
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className={itemClass}
                onClick={() => setPanel('root')}
                aria-label="Back to the menu"
              >
                <span aria-hidden>◂</span>
                <span className="flex-1">Move to grouping</span>
              </button>
              <div className="my-1 border-t border-line" />

              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => moveToGrouping.mutate(null)}
                disabled={row.groupingId === null}
              >
                No grouping
              </button>

              {groupings.map((grouping) => (
                <button
                  key={grouping.id}
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={() => moveToGrouping.mutate(grouping.id)}
                  disabled={row.groupingId === grouping.id}
                >
                  {grouping.name}
                </button>
              ))}

              {groupings.length === 0 && (
                <p className="px-2 py-1.5 text-quiet text-muted">
                  No groupings yet. Add one above the Delegations table.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {dialog === 'rename' && <RenameDialog row={row} onClose={() => setDialog('none')} />}
      {dialog === 'note' && <NoteDialog row={row} onClose={() => setDialog('none')} />}
      {dialog === 'adjust' && (
        <AdjustDialog
          row={row}
          // Offered from a blocked archive, the movement that zeroes the line is
          // the one the owner wants; anywhere else it starts empty.
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
    </div>
  );
}
