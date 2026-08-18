import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../../api/accounts.js';
import { propertiesApi, valuationsApi, type PropertyDto } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Properties.
 *
 * A property is added here and nowhere else. It becomes an asset by itself, with
 * its opening value, in one act — the previous version needed an account created
 * under Accounts first and then valued over here, which is two places to get one
 * thing right.
 *
 * A value is recorded against an as-of date and kept rather than overwritten, so
 * the net worth chart can show what the house was worth in March instead of what
 * it is worth today. Equity is computed on read: stored, it would drift from the
 * mortgage balance on every payment, in the direction that flatters.
 */

function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function PropertyCard({
  property,
  debts,
  onProblem,
}: {
  readonly property: PropertyDto;
  readonly debts: readonly { id: string; name: string }[];
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(todayForInput());
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['properties'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const update = useMutation({
    mutationFn: (input: {
      inBudget?: boolean;
      inNetWorth?: boolean;
      mortgageAccountId?: string | null;
    }) => propertiesApi.update(property.id, input),
    onSuccess: refresh,
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'Could not save that property.'),
  });

  const record = useMutation({
    mutationFn: () => {
      const parsed = tryParseMoney(value);
      if (!parsed.ok) throw new ApiError(400, 'invalid_value', 'Enter a value like 450000.00.');
      return valuationsApi.record(property.id, {
        valueCents: parsed.value.toString(),
        asOf,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: async (result) => {
      setValue('');
      setNote('');
      // Whether this changed the current figure is the part worth saying: an
      // older date is history, not a revaluation.
      setDone(
        result.isCurrent
          ? 'Recorded, and this is now the current value.'
          : 'Recorded as history. It is older than the latest value, so the current figure is unchanged.',
      );
      await refresh();
    },
    onError: (error: unknown) => {
      setDone(null);
      onProblem(error instanceof ApiError ? error.message : 'Could not record that value.');
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    record.mutate();
  }

  return (
    <SettingsCard
      title={property.name}
      description={`Worth ${formatCents(BigInt(property.valueCents))}${
        property.valuedAt ? ` as of ${property.valuedAt.slice(0, 10)}` : ''
      }.`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={property.inNetWorth}
              onChange={(event) => update.mutate({ inNetWorth: event.target.checked })}
              aria-label={`${property.name} counts towards net worth`}
            />
            Net worth
          </label>
          <label className="flex items-center gap-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={property.inBudget}
              onChange={(event) => update.mutate({ inBudget: event.target.checked })}
              aria-label={`${property.name} counts towards the budget`}
            />
            Budget
          </label>
        </div>

        <SelectField
          label="Mortgage secured against it"
          value={property.mortgage?.id ?? ''}
          onChange={(id) => update.mutate({ mortgageAccountId: id === '' ? null : id })}
        >
          <option value="">No mortgage linked</option>
          {debts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </SelectField>

        {property.equityCents !== null && property.mortgage && (
          <p className="text-quiet text-muted">
            Equity is{' '}
            <strong className="text-ink">{formatCents(BigInt(property.equityCents))}</strong> —{' '}
            {formatCents(BigInt(property.valueCents))} less{' '}
            {formatCents(BigInt(property.mortgage.balanceCents))} still owed. Computed every time it
            is read, so it follows the mortgage down.
          </p>
        )}

        <form
          onSubmit={onSubmit}
          className="flex flex-wrap items-end gap-3 rounded-lg bg-surface p-3"
        >
          <TextField
            label="New value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="450000.00"
            inputMode="decimal"
          />
          <TextField
            label="As of"
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />
          <TextField
            label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Appraisal, comparable sale…"
          />
          <div className="pb-1">
            <Button type="submit" disabled={record.isPending}>
              Record
            </Button>
          </div>
        </form>

        {done && <Alert tone="positive">{done}</Alert>}

        {property.valuations.length > 1 && (
          <details>
            <summary className="cursor-pointer text-quiet text-muted">
              {property.valuations.length} recorded values
            </summary>
            <table className="mt-2 w-full">
              <tbody>
                {property.valuations.map((valuation) => (
                  <tr key={valuation.id} className="border-b border-line last:border-0">
                    <td className="row-cell pl-3 text-quiet text-muted">
                      {valuation.asOf.slice(0, 10)}
                    </td>
                    <td className="row-cell money pr-2 text-right text-ink">
                      {formatCents(BigInt(valuation.valueCents))}
                    </td>
                    <td className="row-cell text-quiet text-muted">{valuation.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </SettingsCard>
  );
}

export function PropertiesSection(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(todayForInput());
  const [mortgageAccountId, setMortgageAccountId] = useState('');
  const [inBudget, setInBudget] = useState(false);
  const [inNetWorth, setInNetWorth] = useState(true);

  const data = useQuery({ queryKey: ['properties'], queryFn: propertiesApi.list });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const debts = (accounts.data?.accounts ?? []).filter((account) => account.type === 'debt');

  const create = useMutation({
    mutationFn: propertiesApi.create,
    onSuccess: async () => {
      setProblem(null);
      setName('');
      setValue('');
      setMortgageAccountId('');
      await queryClient.invalidateQueries({ queryKey: ['properties'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not add that property.'),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (name.trim() === '') {
      setProblem('Give the property a name — its address does nicely.');
      return;
    }
    const parsed = tryParseMoney(value);
    if (!parsed.ok) {
      setProblem('Enter a value like 450000.00.');
      return;
    }

    create.mutate({
      name: name.trim(),
      valueCents: parsed.value.toString(),
      asOf,
      inBudget,
      inNetWorth,
      mortgageAccountId: mortgageAccountId === '' ? null : mortgageAccountId,
    });
  }

  const properties = data.data?.properties ?? [];

  return (
    <>
      {problem && <Alert tone="danger">{problem}</Alert>}

      {properties.map((property) => (
        <PropertyCard key={property.id} property={property} debts={debts} onProblem={setProblem} />
      ))}

      <SettingsCard
        title="Add a property"
        description="Its opening value comes with it. Adding one here makes it an asset — there is nothing to add under Accounts."
      >
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="1505 E Otonka Trail"
            required
          />
          <TextField
            label="Value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="450000.00"
            inputMode="decimal"
            required
          />
          <TextField
            label="As of"
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
          />

          <SelectField
            label="Mortgage against it"
            value={mortgageAccountId}
            onChange={setMortgageAccountId}
          >
            <option value="">None</option>
            {debts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </SelectField>

          <label className="flex items-center gap-2 pb-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={inNetWorth}
              onChange={(event) => setInNetWorth(event.target.checked)}
            />
            Net worth
          </label>

          {/* Off by default. A house is not spendable, so counting it as budget
              money has to be a decision rather than the path of least resistance. */}
          <label className="flex items-center gap-2 pb-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={inBudget}
              onChange={(event) => setInBudget(event.target.checked)}
            />
            Budget
          </label>

          <div className="pb-1">
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Add
            </Button>
          </div>
        </form>
      </SettingsCard>
    </>
  );
}
