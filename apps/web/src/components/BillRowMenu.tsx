import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { recurringApi, type BillDto } from '../api/recurring.js';
import { ApiError } from '../api/client.js';
import { DANGER_ITEM_CLASS, ITEM_CLASS, RowMenuShell } from './RowMenuShell.jsx';
import { Alert, Button, Modal, TextField } from './ui.jsx';

/**
 * The per-row menu on the Bills page.
 *
 * Every bill here was worked out from the register rather than entered, so the
 * detection is sometimes wrong in a way no threshold can fix — a thrift shop
 * visited every fortnight has exactly the shape of a fortnightly bill, and only
 * the household knows it is a shop. This is where they say so.
 *
 * Two corrections, and they are the only two worth having: **this is not a
 * bill**, and **this is not what it is called**. Everything else on the row is
 * arithmetic over transactions and would be a lie if it were editable.
 */

function RenameDialog({
  bill,
  onClose,
}: {
  readonly bill: BillDto;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState(bill.renamed ? bill.name : '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      recurringApi.override({
        key: bill.key,
        label: bill.feedName,
        // Empty means "use what the bank calls it", which is where every row
        // starts. Not the same as a name that happens to be blank.
        displayName: name.trim() === '' ? null : name.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['recurring'] });
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
      label={`Rename ${bill.feedName}`}
      title="Rename"
      description="A name of your own. The bank's stays underneath it."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Name"
          width="full"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={bill.feedName}
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

export function BillRowMenu({
  bill,
  onProblem,
}: {
  readonly bill: BillDto;
  /** Surfaced on the page, because the menu closes before the request answers. */
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);

  const hide = useMutation({
    mutationFn: () => recurringApi.override({ key: bill.key, label: bill.feedName, hidden: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['recurring'] });
      // A hidden merchant raises nothing, so the pill may have gone with it.
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error: unknown) => {
      onProblem(error instanceof ApiError ? error.message : 'That bill could not be hidden.');
    },
  });

  return (
    <RowMenuShell
      name={bill.name}
      overlay={renaming ? <RenameDialog bill={bill} onClose={() => setRenaming(false)} /> : null}
    >
      {(controls) => (
        <>
          {/*
            What the bank actually calls it.
            
            Only where it differs from what is on the row — otherwise it is the
            row repeated. It used to sit under the name in small grey, which put
            a line of feed text on every renamed row and undid most of what
            renaming was for. Here it is one press away for the person
            reconciling against a statement, and invisible to everybody else.
          */}
          {bill.renamed && (
            <p className="px-2 pb-1 text-label break-words text-muted">{bill.feedName}</p>
          )}

          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => {
              setRenaming(true);
              controls.close();
            }}
          >
            {bill.renamed ? 'Change the name' : 'Give it a name'}
          </button>

          <div className="my-1 border-t border-line" />

          {/*
            Danger red, and the word is "Not a bill" rather than Remove or
            Delete. Nothing is deleted: the charges stay in the register, the
            merchant stays on the hidden list, and putting it back is one press.
            What is being said is a judgement about what this merchant *is*.
          */}
          <button
            type="button"
            role="menuitem"
            className={`${DANGER_ITEM_CLASS} flex-col items-start gap-0`}
            onClick={() => {
              hide.mutate();
              controls.close();
            }}
            disabled={hide.isPending}
          >
            <span>Not a bill</span>
            <span className="text-label text-muted">
              Takes it off this list. Nothing else changes, and it can come back.
            </span>
          </button>
        </>
      )}
    </RowMenuShell>
  );
}
