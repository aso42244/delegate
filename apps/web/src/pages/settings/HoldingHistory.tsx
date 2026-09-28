import { formatBitcoin, formatCents, tryParseBitcoin, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { holdingEventsApi, type BitcoinEventType } from '../../api/bitcoin.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { WatchedWallets } from './WatchedWallets.jsx';

/**
 * The dated history behind one holding.
 *
 * The quantity used to be a single number, which left the net worth chart no
 * choice but to apply today's quantity to every past date. Recording when
 * Bitcoin was actually bought is what fixes that — and once the price paid is
 * recorded too, cost basis comes for free rather than being kept by hand.
 */

/** What each kind means, said from the owner's side rather than the schema's. */
const KINDS: readonly {
  value: Exclude<BitcoinEventType, 'adjustment'>;
  label: string;
  priced: boolean;
}[] = [
  { value: 'purchase', label: 'Bought', priced: true },
  { value: 'sale', label: 'Sold', priced: true },
  { value: 'transfer_in', label: 'Moved in from another wallet', priced: false },
  { value: 'transfer_out', label: 'Moved out to another wallet', priced: false },
  { value: 'opening', label: 'Already held before this', priced: false },
];

const LABELS: Record<BitcoinEventType, string> = {
  opening: 'Opening',
  purchase: 'Bought',
  sale: 'Sold',
  transfer_in: 'Moved in',
  transfer_out: 'Moved out',
  adjustment: 'Corrected',
};

function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function HoldingHistory({
  accountId,
  name,
}: {
  readonly accountId: string;
  readonly name: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<Exclude<BitcoinEventType, 'adjustment'>>('purchase');
  const [amount, setAmount] = useState('');
  const [occurredAt, setOccurredAt] = useState(todayForInput());
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  const history = useQuery({
    queryKey: ['bitcoin', 'events', accountId],
    queryFn: () => holdingEventsApi.list(accountId),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['bitcoin'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['insights'] });
  };

  const record = useMutation({
    mutationFn: () => {
      const parsed = tryParseBitcoin(amount);
      if (!parsed.ok) {
        throw new ApiError(
          400,
          'invalid_amount',
          'Enter a quantity like 0.05. Bitcoin divides to eight places.',
        );
      }

      const priced = KINDS.find((option) => option.value === kind)?.priced ?? false;
      let priceCents: string | null = null;
      if (priced && price.trim() !== '') {
        const parsedPrice = tryParseMoney(price);
        if (!parsedPrice.ok) {
          throw new ApiError(400, 'invalid_price', 'Enter what one Bitcoin cost, like 62500.00.');
        }
        priceCents = parsedPrice.value.toString();
      }

      return holdingEventsApi.record(accountId, {
        eventType: kind,
        sats: parsed.value.toString(),
        occurredAt,
        priceCents,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: async () => {
      setProblem(null);
      setAmount('');
      setPrice('');
      setNote('');
      await refresh();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not record that.'),
  });

  const reverse = useMutation({
    mutationFn: holdingEventsApi.reverse,
    onSuccess: refresh,
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not back that out.'),
  });

  const data = history.data;
  const priced = KINDS.find((option) => option.value === kind)?.priced ?? false;

  function submit(event: FormEvent): void {
    event.preventDefault();
    record.mutate();
  }

  return (
    <div className="mt-4 rounded-lg bg-surface p-3">
      {problem && <Alert tone="danger">{problem}</Alert>}

      {data && (
        <dl className="mb-4 grid grid-cols-[1fr_auto] gap-x-4 text-quiet">
          <dt className="text-muted">Worth today</dt>
          <dd className="money font-semibold text-ink">
            {data.worthCents === null ? (
              <span className="text-faint">—</span>
            ) : (
              formatCents(BigInt(data.worthCents))
            )}
          </dd>

          <dt className="text-muted">Cost of what is held</dt>
          <dd className="money font-semibold text-ink">
            {formatCents(BigInt(data.costBasis.costCents))}
          </dd>

          {/* Only against the priced portion, because that is the only part a
              gain can honestly be computed for. */}
          {data.unrealizedCents !== null && (
            <>
              <dt className="text-muted">
                {BigInt(data.unrealizedCents) < 0n ? 'Down' : 'Up'} on that
              </dt>
              <dd
                className={`money font-semibold ${
                  BigInt(data.unrealizedCents) < 0n ? 'text-warning' : 'text-positive'
                }`}
              >
                {formatCents(
                  BigInt(data.unrealizedCents) < 0n
                    ? -BigInt(data.unrealizedCents)
                    : BigInt(data.unrealizedCents),
                )}
              </dd>
            </>
          )}

          {/* Reported rather than valued at zero, which would read as "free". */}
          {BigInt(data.costBasis.unpricedSats) > 0n && (
            <>
              <dt className="text-muted">Held at an unknown cost</dt>
              <dd className="money font-semibold text-faint">
                {formatBitcoin(BigInt(data.costBasis.unpricedSats))}
              </dd>
            </>
          )}
        </dl>
      )}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 [&>*]:mb-0">
        <SelectField
          width="sm"
          label="What happened"
          value={kind}
          onChange={(value) => setKind(value as Exclude<BitcoinEventType, 'adjustment'>)}
        >
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>

        <TextField
          width="sm"
          label="How much"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.05"
          inputMode="decimal"
          required
        />

        <TextField
          width="sm"
          label="When"
          type="date"
          value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)}
        />

        {/* Only where a price means something. Moving Bitcoin between your own
            wallets buys nothing, and a price there would invent a gain. */}
        {priced && (
          <TextField
            width="sm"
            label="Price of one Bitcoin"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="62500.00"
            inputMode="decimal"
          />
        )}

        <TextField
          width="sm"
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Exchange, DCA…"
        />

        <div>
          <Button type="submit" disabled={record.isPending}>
            Record
          </Button>
        </div>
      </form>

      {/* Below the row rather than under one field: a hint inside a field makes
          that field taller than its neighbours, and every label in the row goes
          out of line with it. */}
      {priced && (
        <p className="mt-1 text-label text-muted">
          Leave the price blank if you do not know it — the Bitcoin is then counted as held at an
          unknown cost rather than as free.
        </p>
      )}

      <WatchedWallets accountId={accountId} />

      {data && data.events.length > 0 && (
        <table className="mt-4 w-full">
          <thead>
            <tr className="text-label uppercase tracking-label text-muted">
              <th className="row-cell pl-1 text-left font-normal">Date</th>
              <th className="row-cell text-left font-normal">What</th>
              <th className="row-cell pr-2 text-right font-normal">Amount</th>
              <th className="row-cell pr-2 text-right font-normal">Cost</th>
              <th className="w-20 row-cell" />
            </tr>
          </thead>
          <tbody>
            {data.events.map((event) => (
              <tr
                key={event.id}
                className={`border-b border-line last:border-0 ${
                  event.reversedAt ? 'text-faint line-through' : ''
                }`}
              >
                <td className="row-cell pl-1 text-quiet text-muted">
                  {event.occurredAt.slice(0, 10)}
                </td>
                <td className="row-cell text-quiet text-ink">
                  {LABELS[event.eventType]}
                  {event.note && <span className="ml-2 text-muted">{event.note}</span>}
                </td>
                <td className="money row-cell pr-2 text-right text-ink">
                  {BigInt(event.deltaSats) > 0n ? '+' : '−'}
                  {formatBitcoin(
                    BigInt(event.deltaSats) < 0n
                      ? -BigInt(event.deltaSats)
                      : BigInt(event.deltaSats),
                  )}
                </td>
                <td className="money row-cell pr-2 text-right text-muted">
                  {event.costCents === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    formatCents(BigInt(event.costCents))
                  )}
                </td>
                <td className="row-cell text-right">
                  {/* Backed out rather than deleted, so a correction stays part
                      of the history of what the chart showed. */}
                  {!event.reversedAt && (
                    <button
                      type="button"
                      onClick={() => reverse.mutate(event.id)}
                      aria-label={`Back out the ${LABELS[event.eventType].toLowerCase()} on ${event.occurredAt.slice(0, 10)} for ${name}`}
                      className="text-quiet text-muted underline"
                    >
                      Back out
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
