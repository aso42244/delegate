import {
  formatBitcoin,
  formatBitcoinForInput,
  formatCents,
  tryParseBitcoin,
  tryParseMoney,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi, type AccountDto } from '../../api/accounts.js';
import { bitcoinApi, valuationsApi } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Bitcoin & Property.
 *
 * Both halves store a **quantity or a dated value**, never a current dollar
 * figure that would go stale silently. Bitcoin is satoshis valued at the price
 * on the day; a property is a value recorded against an as-of date, kept as
 * history so the net worth chart can show what it was worth in March.
 */

function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function BitcoinSection(): ReactNode {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const data = useQuery({ queryKey: ['bitcoin'], queryFn: bitcoinApi.get });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const setHolding = useMutation({
    mutationFn: ({ accountId, sats }: { accountId: string; sats: string | null }) =>
      bitcoinApi.setHolding(accountId, sats),
    onSuccess: async () => {
      setProblem(null);
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save the holding.'),
  });

  const refetchPrice = useMutation({
    mutationFn: bitcoinApi.refresh,
    onSuccess: refresh,
    onError: (error: unknown) =>
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'No price source answered. The last known price is still in use.',
      ),
  });

  const price = data.data?.price ?? null;
  // Only manual accounts can hold Bitcoin — a fed account's balance is the
  // institution's to state.
  const manualAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => account.source === 'manual',
  );

  function save(account: AccountDto): void {
    const draft = drafts[account.id];
    if (draft === undefined) return;

    if (draft.trim() === '') {
      setHolding.mutate({ accountId: account.id, sats: null });
      return;
    }
    const parsed = tryParseBitcoin(draft);
    if (!parsed.ok) {
      setProblem('Enter a quantity like 0.05. Bitcoin divides to eight places.');
      return;
    }
    setHolding.mutate({ accountId: account.id, sats: parsed.value.toString() });
  }

  return (
    <SettingsCard
      title="Bitcoin"
      description="Held as a quantity. What it is worth is the quantity times the price on the day, never a stored figure."
    >
      <div className="mb-4">
        {price === null ? (
          <Alert tone="warning">
            No price has been fetched yet. Holdings show no value until one arrives — never a zero,
            which would look like an answer.
          </Alert>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="money text-hero font-bold text-ink">
              {formatCents(BigInt(price.priceCents))}
            </span>
            <span className="text-quiet text-muted">
              from {price.source} on {new Date(price.priceDate).toLocaleDateString()}
            </span>
            {/* Said in words, not by colour alone. */}
            {price.stale && (
              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-label font-semibold text-warning">
                stale — holdings are valued at this price
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mb-4">
        <Button onClick={() => refetchPrice.mutate()} disabled={refetchPrice.isPending}>
          {refetchPrice.isPending ? 'Fetching…' : 'Fetch the price now'}
        </Button>
      </div>

      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {manualAccounts.length === 0 ? (
        <p className="text-quiet text-muted">
          Add a manual account for the hardware wallet in Settings → Accounts first.
        </p>
      ) : (
        <div>
          {manualAccounts.map((account) => {
            const holding = data.data?.holdings.find((row) => row.id === account.id);
            const draft =
              drafts[account.id] ?? (holding ? formatBitcoinForInput(BigInt(holding.sats)) : '');

            return (
              <div
                key={account.id}
                className="flex flex-wrap items-end gap-3 border-b border-line py-3 last:border-0"
              >
                <div className="min-w-48 flex-1">
                  <TextField
                    label={`Bitcoin held in ${account.name}`}
                    value={draft}
                    onChange={(event) =>
                      setDrafts((previous) => ({ ...previous, [account.id]: event.target.value }))
                    }
                    inputMode="decimal"
                    placeholder="0.00000000"
                    className="money"
                    hint="Leave empty if this account holds none."
                  />
                </div>

                <div className="w-40 text-right">
                  <span className="text-quiet text-muted">
                    {holding && holding.valueCents !== null
                      ? formatCents(BigInt(holding.valueCents))
                      : '—'}
                  </span>
                </div>

                <Button onClick={() => save(account)} disabled={setHolding.isPending}>
                  Save
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {data.data && data.data.holdings.length > 0 && (
        <p className="mt-3 text-quiet text-muted">
          Holding{' '}
          {formatBitcoin(
            data.data.holdings.reduce((sum, holding) => sum + BigInt(holding.sats), 0n),
          )}{' '}
          BTC in total.
        </p>
      )}
    </SettingsCard>
  );
}

function PropertySection(): ReactNode {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState('');
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(todayForInput());
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const manualAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => account.source === 'manual' && account.type === 'asset',
  );
  const debts = (accounts.data?.accounts ?? []).filter((account) => account.type === 'debt');

  const valuations = useQuery({
    queryKey: ['valuations', selected],
    queryFn: () => valuationsApi.list(selected),
    enabled: selected !== '',
  });

  const equity = useQuery({
    queryKey: ['equity', selected],
    queryFn: () => valuationsApi.equity(selected),
    enabled: selected !== '',
  });

  const record = useMutation({
    mutationFn: () => {
      const parsed = tryParseMoney(value);
      if (!parsed.ok) throw new ApiError(400, 'invalid_value', 'Enter a value like 450000.00.');
      return valuationsApi.record(selected, {
        valueCents: parsed.value.toString(),
        asOf,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: async (result) => {
      setProblem(null);
      setValue('');
      setNote('');
      // Whether this changed the current figure is the part worth saying: an
      // older date is history, not a revaluation.
      setDone(
        result.isCurrent
          ? 'Recorded, and this is now the current value.'
          : 'Recorded as history. It is older than the latest value, so the current figure is unchanged.',
      );
      await queryClient.invalidateQueries({ queryKey: ['valuations'] });
      await queryClient.invalidateQueries({ queryKey: ['equity'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) => {
      setDone(null);
      setProblem(error instanceof ApiError ? error.message : 'Could not record that value.');
    },
  });

  const linkMortgage = useMutation({
    mutationFn: (mortgageAccountId: string | null) =>
      accountsApi.update(selected, { mortgageAccountId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['equity'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    record.mutate();
  }

  const property = manualAccounts.find((account) => account.id === selected);

  return (
    <SettingsCard
      title="Property"
      description="Entered by hand against a date and kept as history, so the net worth chart can show what it was worth then rather than now."
    >
      <div className="flex flex-col gap-3">
        <SelectField label="Property" value={selected} onChange={setSelected}>
          <option value="">Choose an account</option>
          {manualAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </SelectField>

        {property && (
          <>
            <SelectField
              label="Mortgage secured against it"
              value={property.mortgageAccountId ?? ''}
              onChange={(id) => linkMortgage.mutate(id === '' ? null : id)}
            >
              <option value="">No mortgage linked</option>
              {debts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </SelectField>

            {equity.data?.equity && (
              <p className="text-quiet text-muted">
                Equity is{' '}
                <strong className="text-ink">
                  {formatCents(BigInt(equity.data.equity.equityCents))}
                </strong>{' '}
                — {formatCents(BigInt(equity.data.equity.propertyValueCents))} less{' '}
                {formatCents(BigInt(equity.data.equity.mortgageBalanceCents))} still owed. Computed
                every time it is read, so it follows the mortgage down.
              </p>
            )}

            <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg bg-surface p-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <TextField
                    label="Value"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    inputMode="decimal"
                    placeholder="450000.00"
                    className="money"
                  />
                </div>
                <div className="flex-1">
                  <TextField
                    label="As of"
                    type="date"
                    value={asOf}
                    onChange={(event) => setAsOf(event.target.value)}
                  />
                </div>
              </div>

              <TextField
                label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Where the figure came from"
                autoComplete="off"
              />

              {problem && <Alert>{problem}</Alert>}
              {done && <Alert tone="positive">{done}</Alert>}

              <div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={value.trim() === '' || record.isPending}
                >
                  {record.isPending ? 'Recording…' : 'Record this value'}
                </Button>
              </div>
            </form>

            {valuations.data && valuations.data.valuations.length > 0 && (
              <div>
                <h3 className="mb-2 text-quiet font-semibold text-ink">History</h3>
                <table className="w-full border-t-2 border-ink">
                  <thead>
                    <tr className="text-label uppercase tracking-[0.05em] text-muted">
                      <th className="py-2 text-left font-normal">As of</th>
                      <th className="py-2 text-right font-normal">Value</th>
                      <th className="py-2 pl-3 text-left font-normal">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuations.data.valuations.map((valuation) => (
                      <tr key={valuation.id} className="border-b border-line">
                        <td className="py-2 text-quiet text-muted">
                          {new Date(valuation.asOf).toLocaleDateString()}
                        </td>
                        <td className="money py-2 text-ink">
                          {formatCents(BigInt(valuation.valueCents))}
                        </td>
                        <td className="py-2 pl-3 text-quiet text-muted">{valuation.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsCard>
  );
}

export function BitcoinAndPropertySection(): ReactNode {
  return (
    <>
      <BitcoinSection />
      <PropertySection />
    </>
  );
}
