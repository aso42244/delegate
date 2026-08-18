import { formatBitcoin, formatBitcoinForInput, formatCents, tryParseBitcoin } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { bitcoinApi, type BitcoinHoldingDto } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, TextField } from '../../components/ui.jsx';
import { HoldingHistory } from './HoldingHistory.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Bitcoin.
 *
 * A holding is added here and nowhere else. It becomes an asset by itself; there
 * is no separate step under Accounts, because the two-step version was the whole
 * complaint and the account row it produced was easy to leave half-configured.
 *
 * Bitcoin is held as a **quantity** — satoshis — and what it is worth is that
 * quantity times the price on the day. A stored dollar figure would be wrong
 * within the minute and would make every historical point on the net worth chart
 * wrong with it.
 */

/** What an in-budget holding does to the banner, said once rather than every time. */
const IN_BUDGET_WARNING = [
  'The budget banner is a reading of your spending. A holding in the budget makes it a reading of the market as well: "Balanced" will move when Bitcoin moves, even on a day you spent nothing.',
  'To keep that from happening hourly, an in-budget holding is revalued once a day. So the identity is balanced against a Bitcoin price up to 24 hours old.',
  'Net worth is unaffected either way — it always uses the price for the day being shown.',
].join('\n\n');

function HoldingRow({
  holding,
  onProblem,
  columns,
}: {
  readonly holding: BitcoinHoldingDto;
  readonly onProblem: (message: string) => void;
  readonly columns: number;
}): ReactNode {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
  };

  const update = useMutation({
    mutationFn: (input: { sats?: string; inBudget?: boolean; inNetWorth?: boolean }) =>
      bitcoinApi.update(holding.id, input),
    onSuccess: async () => {
      setDraft(null);
      await refresh();
    },
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'Could not save that holding.'),
  });

  function commit(): void {
    if (draft === null) return;
    const parsed = tryParseBitcoin(draft.trim() === '' ? '0' : draft);
    if (!parsed.ok) {
      onProblem('Enter a quantity like 0.05. Bitcoin divides to eight places.');
      return;
    }
    update.mutate({ sats: parsed.value.toString() });
  }

  return (
    <>
      <tr className="border-b border-line">
        <td className="row-cell pl-3">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex items-center gap-2 text-ink"
          >
            <span aria-hidden className="text-muted">
              {open ? '▾' : '▸'}
            </span>
            {holding.name}
          </button>
        </td>

        <td className="w-48 row-cell">
          <input
            value={draft ?? formatBitcoinForInput(BigInt(holding.sats))}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') setDraft(null);
            }}
            inputMode="decimal"
            aria-label={`${holding.name} quantity`}
            className="money w-full rounded border border-line bg-canvas px-2 py-0.5"
          />
        </td>

        <td className="w-36 row-cell">
          <span className="money block px-2 text-ink">
            {holding.valueCents === null ? (
              <span className="text-faint">—</span>
            ) : (
              formatCents(BigInt(holding.valueCents))
            )}
          </span>
        </td>

        <td className="w-28 row-cell text-center">
          <input
            type="checkbox"
            checked={holding.inNetWorth}
            onChange={(event) => update.mutate({ inNetWorth: event.target.checked })}
            aria-label={`${holding.name} counts towards net worth`}
          />
        </td>

        <td className="w-28 row-cell text-center">
          <input
            type="checkbox"
            checked={holding.inBudget}
            onChange={(event) => update.mutate({ inBudget: event.target.checked })}
            aria-label={`${holding.name} counts towards the budget`}
          />
        </td>
      </tr>

      {/* The dated history, which is where a purchase actually belongs. The
          quantity field above stays for a quick correction, and records the
          difference as an event rather than writing the total. */}
      {open && (
        <tr>
          <td colSpan={columns} className="p-0">
            <HoldingHistory accountId={holding.id} name={holding.name} />
          </td>
        </tr>
      )}
    </>
  );
}

export function BitcoinSection(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [inBudget, setInBudget] = useState(false);
  const [inNetWorth, setInNetWorth] = useState(true);
  const [warningOpen, setWarningOpen] = useState(false);

  const data = useQuery({ queryKey: ['bitcoin'], queryFn: bitcoinApi.get });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const create = useMutation({
    mutationFn: bitcoinApi.create,
    onSuccess: async () => {
      setProblem(null);
      setName('');
      setQuantity('');
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not add that holding.'),
  });

  const acknowledge = useMutation({
    mutationFn: bitcoinApi.acknowledgeInBudget,
    onSuccess: refresh,
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
  const holdings = data.data?.holdings ?? [];
  const warningDue = data.data?.inBudgetWarningDue ?? false;

  const totalSats = holdings.reduce((sum, holding) => sum + BigInt(holding.sats), 0n);

  /** The warning gates the first in-budget holding, not every one. */
  function askForBudget(next: boolean): void {
    if (next && warningDue) {
      setWarningOpen(true);
      return;
    }
    setInBudget(next);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (name.trim() === '') {
      setProblem('Give the holding a name — "Hardware wallet", "Exchange".');
      return;
    }

    let sats = '0';
    if (quantity.trim() !== '') {
      const parsed = tryParseBitcoin(quantity);
      if (!parsed.ok) {
        setProblem('Enter a quantity like 0.05. Bitcoin divides to eight places.');
        return;
      }
      sats = parsed.value.toString();
    }

    create.mutate({ name: name.trim(), sats, inBudget, inNetWorth });
  }

  return (
    <>
      <SettingsCard
        title="Bitcoin"
        description="Quantities held, valued at the price on the day. Adding one here makes it an asset — there is nothing to add under Accounts."
      >
        {problem && <Alert tone="danger">{problem}</Alert>}

        <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <p className="text-label uppercase tracking-[0.05em] text-muted">Price</p>
            <p className="money text-hero font-bold text-ink">
              {price === null ? '—' : formatCents(BigInt(price.priceCents))}
            </p>
          </div>
          <div>
            <p className="text-label uppercase tracking-[0.05em] text-muted">Held</p>
            <p className="money text-hero font-bold text-ink">{formatBitcoin(totalSats)}</p>
          </div>
          <Button onClick={() => refetchPrice.mutate()} disabled={refetchPrice.isPending}>
            {refetchPrice.isPending ? 'Fetching…' : 'Refresh price'}
          </Button>
        </div>

        {/* Never hidden and never a zero: a price nobody could refresh today is
            still the best answer available. */}
        {price?.stale && (
          <Alert tone="warning">
            This price is from {price.priceDate}. Holdings are valued at it until a fetch succeeds.
          </Alert>
        )}

        {holdings.length === 0 ? (
          <p className="text-quiet text-muted">No holdings yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-label uppercase tracking-[0.05em] text-muted">
                <th className="row-cell pl-3 text-left font-normal">Name</th>
                <th className="row-cell text-left font-normal">Quantity</th>
                <th className="row-cell pr-2 text-right font-normal">Worth</th>
                <th className="w-28 row-cell text-center font-normal">Net worth</th>
                <th className="w-28 row-cell text-center font-normal">Budget</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((holding) => (
                <HoldingRow key={holding.id} holding={holding} onProblem={setProblem} columns={5} />
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

      <SettingsCard
        title="Add a holding"
        description="One per wallet or exchange you keep track of."
      >
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Hardware wallet"
            required
          />
          <TextField
            label="Quantity"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="0.05"
            inputMode="decimal"
            hint="Leave blank to fill in later."
          />

          <label className="flex items-center gap-2 pb-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={inNetWorth}
              onChange={(event) => setInNetWorth(event.target.checked)}
            />
            Net worth
          </label>

          <label className="flex items-center gap-2 pb-2 text-quiet text-ink">
            <input
              type="checkbox"
              checked={inBudget}
              onChange={(event) => askForBudget(event.target.checked)}
            />
            Budget
          </label>

          <div className="pb-1">
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Add
            </Button>
          </div>
        </form>

        {warningOpen && (
          <div className="mt-3 rounded-lg border border-warning-line bg-warning-soft p-3">
            <p className="text-quiet font-semibold text-warning">
              Putting Bitcoin in the budget changes what the banner means
            </p>
            {IN_BUDGET_WARNING.split('\n\n').map((paragraph) => (
              <p key={paragraph.slice(0, 24)} className="mt-2 text-quiet text-warning">
                {paragraph}
              </p>
            ))}
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  acknowledge.mutate();
                  setInBudget(true);
                  setWarningOpen(false);
                }}
              >
                I understand
              </Button>
              <Button onClick={() => setWarningOpen(false)}>Keep it out of the budget</Button>
            </div>
          </div>
        )}
      </SettingsCard>
    </>
  );
}
