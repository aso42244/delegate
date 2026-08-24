import { formatCentsForInput, tryParseMoney } from '@budget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../api/accounts.js';
import { ApiError } from '../api/client.js';
import {
  DANGER_ITEM_CLASS,
  ITEM_CLASS,
  RowMenuShell,
  type GroupingOption,
} from './RowMenuShell.jsx';
import { Alert, Button, Modal, TextField, Toggle } from './ui.jsx';

/**
 * The per-row menu on an asset or debt row, on the Budget page and in
 * Settings → Accounts alike.
 *
 * It mirrors Settings → Accounts for that one line, which is what §9.5 asks for:
 * anything configurable elsewhere is configurable there too, and the reverse.
 * Since Settings became a one-line-per-account table, that parity is what the
 * menu *is* rather than a courtesy: Type, Archive and the short name have no
 * other home there.
 *
 * The balance is offered only on a manual account. A SimpleFIN balance belongs
 * to the institution, and the next sync would overwrite anything set here.
 */

/**
 * What the menu needs of a row, which is less than either caller has.
 *
 * `BudgetRowDto` and `AccountDto` both satisfy this without a cast. The one
 * asymmetry is deliberate: `nickname` is **absent** on the budget row rather
 * than null, because the budget read model substitutes the nickname into `name`
 * and so has no raw pair to edit. Absent hides the Short name item; null means
 * an account that simply has not been given one.
 */
export interface AccountMenuRow {
  readonly id: string;
  readonly name: string;
  readonly balanceCents: string;
  readonly source: string | null;
  readonly type: 'asset' | 'debt' | null;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly needsReview: boolean;
  readonly groupingId?: string | null;
  readonly nickname?: string | null;
}

function SetBalanceDialog({
  row,
  onClose,
}: {
  readonly row: AccountMenuRow;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(formatCentsForInput(BigInt(row.balanceCents)));
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const parsed = tryParseMoney(amount);
      if (!parsed.ok) throw new ApiError(400, 'invalid_balance', 'Enter a balance like 200.00.');
      // Assets and debts both store a positive magnitude.
      const magnitude = parsed.value < 0n ? -parsed.value : parsed.value;
      return accountsApi.update(row.id, { balanceCents: magnitude.toString() });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not set the balance.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Set the balance of ${row.name}`}
      title="Set balance"
      description="Confirming a balance you keep by hand. This also restarts its staleness clock."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <TextField
          label="Balance"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className="money"
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

function RenameDialog({
  row,
  onClose,
}: {
  readonly row: AccountMenuRow;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState(row.name);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => accountsApi.update(row.id, { name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not rename this account.'),
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
 * The nickname — what the budget and the register show in place of whatever the
 * institution calls the account.
 *
 * Empty clears it, which is why the Save button is not disabled on an empty
 * field the way Rename's is: clearing is a real edit, and the only way back to
 * the full name.
 */
function NicknameDialog({
  row,
  onClose,
}: {
  readonly row: AccountMenuRow;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState(row.nickname ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const next = nickname.trim();
      return accountsApi.update(row.id, { nickname: next === '' ? null : next });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not set the short name.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Modal
      label={`Nickname for ${row.name}`}
      title="Nickname"
      description="Shown on the budget and the register in place of the institution's own wording. Leave it empty to use the full name."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <TextField
          label="Nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder={row.name}
          maxLength={40}
          autoComplete="off"
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
            disabled={nickname.trim() === (row.nickname ?? '') || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountRowMenu({
  row,
  groupings,
}: {
  readonly row: AccountMenuRow;
  /**
   * Omitted in Settings → Accounts, which has no grouped view to move a row
   * within. Groupings are a Budget-page arrangement and are chosen there, where
   * they can be seen.
   */
  readonly groupings?: readonly GroupingOption[];
}): ReactNode {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'none' | 'rename' | 'nickname' | 'balance'>('none');
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const update = useMutation({
    mutationFn: (input: Parameters<typeof accountsApi.update>[1]) =>
      accountsApi.update(row.id, input),
    onSuccess: refresh,
  });

  const moveToGrouping = useMutation({
    mutationFn: (groupingId: string | null) => accountsApi.update(row.id, { groupingId }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () => accountsApi.archive(row.id),
    onSuccess: refresh,
    // Refused while an in-budget account still holds money, because the identity
    // subtracts what the accounts hold.
    onError: (error: unknown) =>
      setBlocked(error instanceof ApiError ? error.message : 'This account could not be archived.'),
  });

  return (
    <RowMenuShell
      name={row.name}
      {...(groupings
        ? {
            groupings,
            currentGroupingId: row.groupingId ?? null,
            onMoveToGrouping: (groupingId: string | null) => moveToGrouping.mutate(groupingId),
          }
        : {})}
      overlay={
        <>
          {dialog === 'rename' && <RenameDialog row={row} onClose={() => setDialog('none')} />}
          {dialog === 'nickname' && <NicknameDialog row={row} onClose={() => setDialog('none')} />}
          {dialog === 'balance' && <SetBalanceDialog row={row} onClose={() => setDialog('none')} />}
        </>
      }
    >
      {(controls) =>
        blocked ? (
          <div className="flex flex-col gap-2 p-1">
            <Alert>{blocked}</Alert>
            {/* Taking it out of the budget is the other way out, and it is the
                honest one for an account closing with a balance still on it. */}
            <Button
              onClick={() => {
                update.mutate({ inBudget: false });
                setBlocked(null);
              }}
            >
              Take it out of the budget
            </Button>
            <Button variant="ghost" onClick={() => setBlocked(null)}>
              Back
            </Button>
          </div>
        ) : (
          <>
            {/*
              Rename is for accounts this budget owns the name of.
              
              A SimpleFIN account is called whatever the institution calls it,
              and the next sync would not restore a name typed over it — it
              would simply leave the two disagreeing, with no sign on the page
              that they ever matched. The nickname is the supported way to call
              it something else, and it says so by sitting right underneath.
            */}
            {row.source === 'manual' && (
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
            )}

            {/* Absent rather than null on a budget row, whose `name` is already
                the short one — there is no pair to edit from there. */}
            {row.nickname !== undefined && (
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => {
                  setDialog('nickname');
                  controls.close();
                }}
              >
                Nickname
              </button>
            )}

            {/* Offered only on a manual account: a SimpleFIN balance belongs to
                the institution and the next sync would overwrite it. */}
            {row.source === 'manual' && (
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => {
                  setDialog('balance');
                  controls.close();
                }}
              >
                Set balance
              </button>
            )}

            {/* A sync guesses the type from the institution and account name.
                A wrong guess moves the identity by twice the balance, so it has
                to be correctable from here as well as from Settings. */}
            <div className={ITEM_CLASS}>
              <span>Type</span>
              <select
                value={row.type ?? 'asset'}
                onChange={(event) =>
                  update.mutate({ type: event.target.value as 'asset' | 'debt' })
                }
                aria-label={`Type of ${row.name}`}
                className="rounded border border-line bg-canvas px-1 py-0.5 text-quiet text-ink"
              >
                <option value="asset">Asset</option>
                <option value="debt">Debt</option>
              </select>
            </div>

            <div className={ITEM_CLASS}>
              <span>In budget</span>
              <Toggle
                checked={row.inBudget}
                onChange={(next) => update.mutate({ inBudget: next })}
                label={`${row.name} in budget`}
              />
            </div>

            <div className={ITEM_CLASS}>
              <span>In net worth</span>
              <Toggle
                checked={row.inNetWorth}
                onChange={(next) => update.mutate({ inNetWorth: next })}
                label={`${row.name} in net worth`}
              />
            </div>

            {row.needsReview && (
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={() => update.mutate({ needsReview: false })}
              >
                Mark reviewed
              </button>
            )}

            {groupings && (
              <button
                type="button"
                role="menuitem"
                className={ITEM_CLASS}
                onClick={controls.openGroupingPanel}
              >
                <span>Move to grouping</span>
                <span aria-hidden>▸</span>
              </button>
            )}

            <div className="my-1 border-t border-line" />

            <button
              type="button"
              role="menuitem"
              className={DANGER_ITEM_CLASS}
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
