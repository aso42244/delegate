import {
  formatCents,
  formatCentsForInput,
  isBalanceStale,
  isFeedBalanceStale,
  tryParseMoney,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi, type AccountDto } from '../../api/accounts.js';
import { ApiError } from '../../api/client.js';
import { AccountRowMenu } from '../../components/AccountRowMenu.jsx';
import { Chips } from '../../components/Chip.jsx';
import { Alert, Button, Modal, SelectField, TextField, Toggle } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Accounts.
 *
 * The two booleans are the point of this screen. `in_budget` decides whether an
 * account participates in the identity; `in_net_worth` decides whether it shows
 * on the net worth chart. They are independent, and that independence is the
 * only reason a mortgage does not swamp the budget.
 *
 * A balance is editable only on a manual account. A SimpleFIN balance is
 * whatever the institution last reported, and the next sync would overwrite
 * anything typed here.
 *
 * One line per account, in two tables. Assets and debts are separated because
 * the section a row sits in *is* its type, which is a column's worth of
 * repetition removed; everything that is read far more often than it is changed
 * — the type, the short name, Archive — lives in the row menu the Budget page
 * already uses. What stays on the row is the pair of switches the page exists
 * for, and a balance you can click on a manual account.
 */

function AddAccountDialog({ onDone }: { readonly onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'asset' | 'debt'>('asset');
  const [balance, setBalance] = useState('');
  const [inBudget, setInBudget] = useState(true);
  const [inNetWorth, setInNetWorth] = useState(true);
  const [staleness, setStaleness] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const parsed = tryParseMoney(balance);
      if (!parsed.ok) throw new ApiError(400, 'invalid_balance', 'Enter a balance like 200.00.');

      const days = staleness.trim() === '' ? null : Number(staleness);
      if (days !== null && (!Number.isInteger(days) || days < 1)) {
        throw new ApiError(
          400,
          'invalid_staleness',
          'A staleness interval is a whole number of days, at least one.',
        );
      }

      return accountsApi.create({
        name: name.trim(),
        type,
        // Both assets and debts store a positive magnitude; the identity
        // subtracts the debts.
        balanceCents: (parsed.value < 0n ? -parsed.value : parsed.value).toString(),
        inBudget,
        inNetWorth,
        stalenessIntervalDays: days,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onDone();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not create the account.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Modal
      label="Add an account you keep by hand"
      title="New account"
      description="For anything no feed reports: physical cash, a hardware wallet, a loan between people."
      onClose={onDone}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <TextField
          width="full"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Physical Cash"
          autoComplete="off"
        />

        <div className="flex gap-2">
          <div className="flex-1">
            <SelectField
              width="full"
              label="Type"
              value={type}
              onChange={(value) => setType(value as 'asset' | 'debt')}
            >
              <option value="asset">Asset</option>
              <option value="debt">Debt</option>
            </SelectField>
          </div>
          <div className="flex-1">
            <TextField
              width="sm"
              label="Balance"
              value={balance}
              onChange={(event) => setBalance(event.target.value)}
              inputMode="decimal"
              placeholder="200.00"
              className="money"
              {...(type === 'debt' ? { hint: 'What is owed, as a positive amount.' } : {})}
            />
          </div>
        </div>

        <TextField
          width="full"
          label="Goes stale after (days)"
          value={staleness}
          onChange={(event) => setStaleness(event.target.value)}
          inputMode="numeric"
          placeholder="Leave empty for never"
          hint="How long a confirmed balance stays trustworthy. One mechanism for cash, the hardware wallet and the house alike."
        />

        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-quiet text-ink">
            <Toggle checked={inBudget} onChange={setInBudget} label="In budget" />
            In budget
          </label>
          <label className="flex items-center gap-2 text-quiet text-ink">
            <Toggle checked={inNetWorth} onChange={setInNetWorth} label="In net worth" />
            In net worth
          </label>
        </div>

        {problem && <Alert>{problem}</Alert>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={name.trim() === '' || balance.trim() === '' || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** What the row shows in black, and what the list is ordered by. */
function displayName(account: AccountDto): string {
  return account.nickname ?? account.name;
}

function AccountRow({ account }: { readonly account: AccountDto }): ReactNode {
  const queryClient = useQueryClient();
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (input: Parameters<typeof accountsApi.update>[1]) =>
      accountsApi.update(account.id, input),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not update this account.'),
  });

  /*
   * How old this balance is, asked two ways.
   *
   * A manual balance goes stale when nobody has confirmed it inside its own
   * interval. A synced one goes stale when the bridge answers with an old
   * snapshot — which used to be undetectable, because the sync stamped
   * `balanceAsOf` with the time of its own request and an account days behind
   * read as current.
   */
  const feedDate = account.feedBalanceAsOf === null ? null : new Date(account.feedBalanceAsOf);
  const feedStale = isFeedBalanceStale(feedDate);
  const stale =
    isBalanceStale(
      account.balanceAsOf === null ? null : new Date(account.balanceAsOf),
      account.stalenessIntervalDays,
    ) || feedStale;

  function commitBalance(): void {
    const parsed = tryParseMoney(balanceDraft);
    if (!parsed.ok) {
      setProblem('Enter a balance like 200.00.');
      return;
    }
    setEditingBalance(false);
    const magnitude = parsed.value < 0n ? -parsed.value : parsed.value;
    update.mutate({ balanceCents: magnitude.toString() });
  }

  return (
    <>
      {/* `group` so the row's `⋯` can appear on hover of the row rather than of
          the button, which would be a two-pixel target nobody finds. */}
      <tr className="group border-b border-line last:border-0 hover:bg-surface">
        <td className="row-cell overflow-hidden pl-3">
          {/* The name gives way; nothing else does. `whitespace-nowrap` here
              held the name at full width and pushed the chips off the row on a
              phone. */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-ink">{displayName(account)}</span>

            {/* The institution's own wording, kept where identifying which
                account this is happens to be the point — but quiet, and second,
                now that the short name is the one that reads. */}
            {account.nickname !== null && (
              <span
                className="hidden truncate text-quiet text-faint sm:inline"
                title={account.name}
              >
                {account.name}
              </span>
            )}

            {/* The same marks the budget uses — see components/chips.ts. Only
                `manual` is worth carrying: eight identical `simplefin` chips say
                nothing, while a manual account is the one whose balance is yours
                to type and which can go stale. */}
            <Chips
              kinds={[
                ...(account.source === 'manual' ? (['manual'] as const) : []),
                ...(stale ? (['stale'] as const) : []),
                ...(account.needsReview ? (['review'] as const) : []),
              ]}
            />

            {/* The date itself beside the mark, because "stale" on its own sends
                somebody looking in the application for a fault that is not here.
                Naming the day the institution's own answer came from moves the
                question to the bridge, which is where it can be acted on. Shown
                only when it is old — every account carrying a date every day is
                noise, and this page is deliberately quiet. */}
            {feedStale && feedDate !== null && (
              <span className="hidden shrink-0 whitespace-nowrap text-quiet text-faint sm:inline">
                feed from {feedDate.toLocaleDateString()}
              </span>
            )}
          </div>
        </td>

        <td className="w-36 row-cell pr-2">
          {editingBalance ? (
            <input
              autoFocus
              value={balanceDraft}
              onChange={(event) => setBalanceDraft(event.target.value)}
              onBlur={commitBalance}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitBalance();
                if (event.key === 'Escape') setEditingBalance(false);
              }}
              aria-label={`Balance for ${account.name}`}
              inputMode="decimal"
              className="money money-input ml-auto block rounded border border-accent bg-canvas py-0.5 pr-3 pl-2"
            />
          ) : (
            <button
              type="button"
              disabled={account.source !== 'manual'}
              onClick={() => {
                setBalanceDraft(formatCentsForInput(BigInt(account.balanceCents)));
                setEditingBalance(true);
              }}
              aria-label={`Balance for ${account.name}`}
              className={`money w-full rounded py-0.5 pr-3 pl-2 text-ink ${
                account.source === 'manual' ? 'hover:bg-accent-soft' : 'cursor-default'
              }`}
            >
              {formatCents(BigInt(account.balanceCents))}
            </button>
          )}
        </td>

        <td className="hidden w-20 row-cell sm:table-cell">
          <Toggle
            checked={account.inBudget}
            onChange={(next) => update.mutate({ inBudget: next })}
            label={`${account.name} in budget`}
          />
        </td>

        <td className="hidden w-28 row-cell sm:table-cell">
          <Toggle
            checked={account.inNetWorth}
            onChange={(next) => update.mutate({ inNetWorth: next })}
            label={`${account.name} in net worth`}
          />
        </td>

        <td className="hold-to-open-cell row-cell">
          <AccountRowMenu row={account} />
        </td>
      </tr>

      {problem && (
        <tr>
          <td colSpan={5} className="pb-2">
            <Alert>{problem}</Alert>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One section of the list.
 *
 * The section name sits in the first column heading rather than in a title row
 * of its own — the column *is* the list of assets, and saying so there costs a
 * row less than saying it above.
 */
function AccountsTable({
  section,
  accounts,
}: {
  readonly section: string;
  readonly accounts: readonly AccountDto[];
}): ReactNode {
  if (accounts.length === 0) return null;

  return (
    <table className="w-full table-fixed border-t-2 border-ink">
      <thead>
        <tr className="text-label uppercase tracking-label text-muted">
          <th className="row-cell pl-3 text-left font-semibold text-ink">{section}</th>
          <th className="w-36 row-cell pr-2 text-right font-normal">Balance</th>
          <th className="hidden w-20 row-cell text-left font-normal sm:table-cell">In budget</th>
          <th className="hidden w-28 row-cell text-left font-normal sm:table-cell">In net worth</th>
          <th className="hold-to-open-cell row-cell" />
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
      </tbody>
    </table>
  );
}

export function AccountsSection(): ReactNode {
  const [adding, setAdding] = useState(false);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const all = accounts.data?.accounts ?? [];

  /*
   * Ordered by what the row shows, not by what the database sorts on.
   *
   * The API orders by `name`, which used to be the black text on this page — so
   * the list looked sorted. Now the short name reads first, and ordering by the
   * grey text underneath would put "Frontier Checking" above "Frontier Bank
   * Little Pioneer Savings", because its real name begins "Big Deal Cash Back".
   * Alphabetical has to be true to the eye, not only to the column.
   */
  const ordinary = all
    .filter((account) => account.managedAs === 'none')
    .slice()
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));

  return (
    <SettingsCard
      title="Accounts"
      description="What counts, and towards what."
      action={<Button onClick={() => setAdding(true)}>New account</Button>}
    >
      {accounts.isLoading ? (
        <p className="text-quiet text-muted">Loading accounts…</p>
      ) : all.length === 0 ? (
        <p className="text-quiet text-muted">No accounts yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <AccountsTable
            section="Assets"
            accounts={ordinary.filter((account) => account.type === 'asset')}
          />
          <AccountsTable
            section="Debts"
            accounts={ordinary.filter((account) => account.type === 'debt')}
          />
        </div>
      )}

      {adding && <AddAccountDialog onDone={() => setAdding(false)} />}
    </SettingsCard>
  );
}
