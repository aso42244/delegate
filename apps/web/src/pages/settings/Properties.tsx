import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { accountsApi } from '../../api/accounts.js';
import { propertiesApi, valuationsApi, type PropertyDto } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Disclosure, EmptyState } from '../../components/layout.jsx';
import { Alert, Button, Modal, SelectField, TextField } from '../../components/ui.jsx';
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
 *
 * Both forms here used to sit permanently open in cards — the create form where
 * the list should be, and a valuation form inside every property. Both are
 * dialogs now, per docs/ui-system.md §6.
 */

function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * The two checkboxes both the card and the dialog carry, written once.
 *
 * `of` names the property when there is one. Six properties on a page means six
 * boxes called "Net worth", and a screen reader has no way to tell them apart —
 * so on a card each box is named for its row, while in the create dialog, where
 * there is exactly one of each and no name yet, the visible label is the name.
 */
function CountsToward({
  of,
  inNetWorth,
  inBudget,
  onNetWorth,
  onBudget,
}: {
  readonly of?: string;
  readonly inNetWorth: boolean;
  readonly inBudget: boolean;
  readonly onNetWorth: (next: boolean) => void;
  readonly onBudget: (next: boolean) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-4">
      <label className="flex items-center gap-2 text-quiet text-ink">
        <input
          type="checkbox"
          checked={inNetWorth}
          onChange={(e) => onNetWorth(e.target.checked)}
          {...(of === undefined ? {} : { 'aria-label': `${of} counts towards net worth` })}
        />
        Net worth
      </label>
      {/* Off by default. A house is not spendable, so counting it as budget
          money has to be a decision rather than the path of least resistance. */}
      <label className="flex items-center gap-2 text-quiet text-ink">
        <input
          type="checkbox"
          checked={inBudget}
          onChange={(e) => onBudget(e.target.checked)}
          {...(of === undefined ? {} : { 'aria-label': `${of} counts towards the budget` })}
        />
        Budget
      </label>
    </div>
  );
}

/** Recording what a property is worth now, or what it was worth in March. */
function NewValueDialog({
  property,
  onClose,
  onProblem,
}: {
  readonly property: PropertyDto;
  readonly onClose: () => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(todayForInput());
  const [note, setNote] = useState('');

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
      // Whether this changed the current figure is the part worth saying: an
      // older date is history, not a revaluation.
      onProblem('');
      await queryClient.invalidateQueries({ queryKey: ['properties'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      if (!result.isCurrent) onProblem('Recorded as history; the current value is unchanged.');
      onClose();
    },
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'Could not record that value.'),
  });

  return (
    <Modal label={`New value for ${property.name}`} title="New value" onClose={onClose}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          record.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          label="Value"
          width="full"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="450000.00"
          inputMode="decimal"
          required
        />
        <TextField
          label="As of"
          type="date"
          width="full"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
        />
        <TextField
          label="Note"
          width="full"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Appraisal, comparable sale…"
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={record.isPending}>
            Record
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
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
  const [valuing, setValuing] = useState(false);

  const update = useMutation({
    mutationFn: (input: {
      inBudget?: boolean;
      inNetWorth?: boolean;
      mortgageAccountId?: string | null;
    }) => propertiesApi.update(property.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['properties'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'Could not save that property.'),
  });

  return (
    <SettingsCard
      title={property.name}
      description={`Worth ${formatCents(BigInt(property.valueCents))}${
        property.valuedAt ? ` as of ${property.valuedAt.slice(0, 10)}` : ''
      }.`}
      action={<Button onClick={() => setValuing(true)}>New value</Button>}
    >
      <div className="flex flex-col gap-4">
        <CountsToward
          of={property.name}
          inNetWorth={property.inNetWorth}
          inBudget={property.inBudget}
          onNetWorth={(next) => update.mutate({ inNetWorth: next })}
          onBudget={(next) => update.mutate({ inBudget: next })}
        />

        <SelectField
          label="Mortgage against it"
          width="md"
          value={property.mortgage?.id ?? ''}
          onChange={(id) => update.mutate({ mortgageAccountId: id === '' ? null : id })}
        >
          <option value="">None</option>
          {debts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </SelectField>

        {property.equityCents !== null && property.mortgage && (
          <p className="text-quiet text-muted">
            Equity <strong className="text-ink">{formatCents(BigInt(property.equityCents))}</strong>{' '}
            — {formatCents(BigInt(property.valueCents))} less{' '}
            {formatCents(BigInt(property.mortgage.balanceCents))} owed.
          </p>
        )}

        {property.valuations.length > 1 && (
          <Disclosure summary={`${property.valuations.length} recorded values`}>
            <table className="w-full border-t-2 border-ink">
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
          </Disclosure>
        )}
      </div>

      {valuing && (
        <NewValueDialog
          property={property}
          onClose={() => setValuing(false)}
          onProblem={onProblem}
        />
      )}
    </SettingsCard>
  );
}

/** The create flow, in a dialog rather than parked below the list. */
function NewPropertyDialog({
  debts,
  onClose,
  onProblem,
}: {
  readonly debts: readonly { id: string; name: string }[];
  readonly onClose: () => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(todayForInput());
  const [mortgageAccountId, setMortgageAccountId] = useState('');
  const [inBudget, setInBudget] = useState(false);
  const [inNetWorth, setInNetWorth] = useState(true);

  const create = useMutation({
    mutationFn: propertiesApi.create,
    onSuccess: async () => {
      onProblem('');
      await queryClient.invalidateQueries({ queryKey: ['properties'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      onClose();
    },
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'Could not add that property.'),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (name.trim() === '') {
      onProblem('Give the property a name — its address does nicely.');
      return;
    }
    const parsed = tryParseMoney(value);
    if (!parsed.ok) {
      onProblem('Enter a value like 450000.00.');
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

  return (
    <Modal
      label="New property"
      title="New property"
      description="Its opening value comes with it, and it becomes an asset by itself."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="Name"
          width="full"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="1505 E Otonka Trail"
          required
        />
        <TextField
          label="Value"
          width="full"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="450000.00"
          inputMode="decimal"
          required
        />
        <TextField
          label="As of"
          type="date"
          width="full"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
        />
        <SelectField
          label="Mortgage against it"
          width="full"
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

        <CountsToward
          inNetWorth={inNetWorth}
          inBudget={inBudget}
          onNetWorth={setInNetWorth}
          onBudget={setInBudget}
        />

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add
          </Button>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function PropertiesSection(): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const data = useQuery({ queryKey: ['properties'], queryFn: propertiesApi.list });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  const debts = (accounts.data?.accounts ?? []).filter((account) => account.type === 'debt');
  const properties = data.data?.properties ?? [];

  return (
    <>
      {problem !== null && problem !== '' && <Alert tone="danger">{problem}</Alert>}

      <SettingsCard
        span="half"
        title="Properties"
        description="Valued on a date and kept, so history stays true."
        action={<Button onClick={() => setAdding(true)}>New property</Button>}
      >
        {properties.length === 0 && <EmptyState>No properties yet.</EmptyState>}
      </SettingsCard>

      {properties.map((property) => (
        <PropertyCard key={property.id} property={property} debts={debts} onProblem={setProblem} />
      ))}

      {adding && (
        <NewPropertyDialog debts={debts} onClose={() => setAdding(false)} onProblem={setProblem} />
      )}
    </>
  );
}
