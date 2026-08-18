import { formatCents, formatCentsForInput, isBalanceStale, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { accountsApi, type AccountDto } from '../../api/accounts.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, SelectField, TextField, Toggle } from '../../components/ui.jsx';
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
 */

function AddAccountForm({ onDone }: { readonly onDone: () => void }): ReactNode {
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
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3 rounded-lg bg-surface p-3">
      <TextField
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Physical Cash"
        autoComplete="off"
      />

      <div className="flex gap-3">
        <div className="flex-1">
          <SelectField
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

      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={name.trim() === '' || balance.trim() === '' || create.isPending}
        >
          {create.isPending ? 'Adding…' : 'Add account'}
        </Button>
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AccountRow({ account }: { readonly account: AccountDto }): ReactNode {
  const queryClient = useQueryClient();
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState('');
  // Null means "not being edited", so the stored value shows until it is.
  const [nickname, setNickname] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Could not update this account.');

  const update = useMutation({
    mutationFn: (input: Parameters<typeof accountsApi.update>[1]) =>
      accountsApi.update(account.id, input),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const rename = useMutation({
    mutationFn: (next: string | null) => accountsApi.update(account.id, { nickname: next }),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const archive = useMutation({
    mutationFn: () => accountsApi.archive(account.id),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError,
  });

  const stale = isBalanceStale(
    account.balanceAsOf === null ? null : new Date(account.balanceAsOf),
    account.stalenessIntervalDays,
  );

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

  /*
   * A Bitcoin holding and a property are still accounts, and belong on this
   * list — leaving them off would make the list a lie about what the budget is
   * made of. They are not editable here, though: their own tab owns their
   * lifecycle, and it is where a quantity or a dated valuation is understood.
   * The API refuses the edit too, so this is the courtesy rather than the guard.
   */
  if (account.managedAs !== 'none') {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
        <div className="min-w-48 flex-1">
          <span className="text-ink">{account.name}</span>
          <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
            {account.managedAs}
          </span>
        </div>
        <span className="money text-ink">{formatCents(BigInt(account.balanceCents))}</span>
        <Link
          to={account.managedAs === 'bitcoin' ? '/settings/bitcoin' : '/settings/properties'}
          className="rounded border border-line px-2 py-0.5 text-quiet font-semibold text-accent"
        >
          {account.managedAs === 'bitcoin' ? 'Manage in Bitcoin' : 'Manage in Properties'}
        </Link>
      </div>
    );
  }

  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <span className="text-ink">{account.name}</span>
          <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
            {account.source}
          </span>
          {account.needsReview && (
            <span className="ml-2 text-label font-semibold text-warning">needs review</span>
          )}
          {/* Stale means the confirmed balance has aged past its own interval —
              said in words, not by colour alone. */}
          {stale && <span className="ml-2 text-label font-semibold text-warning">stale</span>}

          {/* The full name stays here, where identifying which account this is
              happens to be the point. The nickname is what the budget and the
              register show instead. */}
          <input
            value={nickname ?? account.nickname ?? ''}
            onChange={(event) => setNickname(event.target.value)}
            onBlur={() => {
              const next = (nickname ?? '').trim();
              if (nickname !== null && next !== (account.nickname ?? '')) {
                rename.mutate(next === '' ? null : next);
              }
              setNickname(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setNickname(null);
            }}
            placeholder="Short name (optional)"
            maxLength={40}
            aria-label={`Short name for ${account.name}`}
            className="mt-1 block w-full rounded border border-transparent bg-transparent px-2 py-0.5 text-quiet text-muted hover:border-line focus:border-accent focus:bg-canvas focus:text-ink"
          />
        </div>

        {/* A discovered account's type is a guess, and a wrong one moves the
            budget identity by twice the balance — §6.1 makes it the owner's to
            override. */}
        <div className="w-28">
          <label className="sr-only" htmlFor={`type-${account.id}`}>
            Type of {account.name}
          </label>
          <select
            id={`type-${account.id}`}
            value={account.type}
            onChange={(event) => update.mutate({ type: event.target.value as 'asset' | 'debt' })}
            className="w-full rounded-lg border border-line bg-canvas px-2 py-1 text-quiet text-ink"
          >
            <option value="asset">Asset</option>
            <option value="debt">Debt</option>
          </select>
        </div>

        <div className="w-40 text-right">
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
              className="money w-full rounded border border-accent bg-canvas px-2 py-1"
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
              className={`money w-full rounded px-2 py-1 text-ink ${
                account.source === 'manual' ? 'hover:bg-accent-soft' : 'cursor-default'
              }`}
            >
              {formatCents(BigInt(account.balanceCents))}
            </button>
          )}
        </div>

        <label className="flex items-center gap-2 text-quiet text-muted">
          <Toggle
            checked={account.inBudget}
            onChange={(next) => update.mutate({ inBudget: next })}
            label={`${account.name} in budget`}
          />
          In budget
        </label>

        <label className="flex items-center gap-2 text-quiet text-muted">
          <Toggle
            checked={account.inNetWorth}
            onChange={(next) => update.mutate({ inNetWorth: next })}
            label={`${account.name} in net worth`}
          />
          In net worth
        </label>

        {account.needsReview && (
          <Button
            onClick={() => update.mutate({ needsReview: false })}
            aria-label={`Mark ${account.name} reviewed`}
          >
            Reviewed
          </Button>
        )}

        <Button
          variant="danger"
          onClick={() => archive.mutate()}
          disabled={archive.isPending}
          aria-label={`Archive ${account.name}`}
        >
          Archive
        </Button>
      </div>

      {problem && (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      )}
    </div>
  );
}

export function AccountsSection(): ReactNode {
  const [adding, setAdding] = useState(false);
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  return (
    <SettingsCard
      title="Accounts"
      description="What each account is, whether it counts towards the budget, and whether it counts towards net worth."
    >
      {accounts.isLoading ? (
        <p className="text-quiet text-muted">Loading accounts…</p>
      ) : accounts.data?.accounts.length === 0 ? (
        <p className="text-quiet text-muted">
          No accounts yet. Connect SimpleFIN, or add one you keep by hand.
        </p>
      ) : (
        <div>
          {accounts.data?.accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </div>
      )}

      {adding ? (
        <AddAccountForm onDone={() => setAdding(false)} />
      ) : (
        <div className="mt-4">
          <Button onClick={() => setAdding(true)}>+ Add a manual account</Button>
        </div>
      )}
    </SettingsCard>
  );
}
