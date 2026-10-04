import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { investmentsApi, type LotDto, type PositionDto } from '../../api/investments.js';
import { EmptyState, StatusLine } from '../../components/layout.jsx';
import { Alert, Button, Modal, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Holdings → Brokerage (ADR 080).
 *
 * The feed says what each position holds; this is where the household says
 * when it was bought. Each position shows whether its lots add up to what the
 * feed reports — the shares to the millionth, the cost to the cent — because a
 * comparison built on lots that do not cover the position is a comparison of
 * part of it.
 */

function todayForInput(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

/** "2025-03-07" as "Mar 7, 2025", never through the browser's zone. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function LotDialog({
  position,
  lot,
  onClose,
}: {
  readonly position: PositionDto;
  /** The lot being corrected, or none for a new purchase. */
  readonly lot: LotDto | null;
  readonly onClose: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [purchasedOn, setPurchasedOn] = useState(lot?.purchasedOn ?? todayForInput());
  const [shares, setShares] = useState(lot?.shares ?? '');
  const [cost, setCost] = useState(
    lot === null
      ? ''
      : formatCents(BigInt(lot.costCents), { currencySymbol: false, grouping: false }),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (costCents: bigint): Promise<void> => {
      const input = { purchasedOn, shares: shares.trim(), costCents: costCents.toString() };
      if (lot === null) await investmentsApi.addLot(position.id, input);
      else await investmentsApi.updateLot(lot.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['investments'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That purchase could not be saved.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const parsed = tryParseMoney(cost);
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    save.mutate(parsed.value);
  }

  return (
    <Modal
      label={
        lot === null
          ? `Record a purchase of ${position.symbol}`
          : `Correct a ${position.symbol} lot`
      }
      title={lot === null ? `Record a purchase of ${position.symbol}` : 'Correct this lot'}
      description="When it was bought, how many shares, and what it cost in all."
      onClose={onClose}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Bought on"
          type="date"
          width="sm"
          value={purchasedOn}
          onChange={(event) => setPurchasedOn(event.target.value)}
          required
        />
        <TextField
          label="Shares"
          width="sm"
          inputMode="decimal"
          value={shares}
          onChange={(event) => setShares(event.target.value)}
          placeholder="10.5"
          required
        />
        <TextField
          label="Cost, fees included"
          width="sm"
          inputMode="decimal"
          value={cost}
          onChange={(event) => setCost(event.target.value)}
          placeholder="2500.00"
          required
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

/** Whether a position's lots add up to what the feed reports, in one sentence. */
function Coverage({ position }: { readonly position: PositionDto }): ReactNode {
  if (position.shareCoverage === 'none') {
    return <StatusLine tone="muted">No purchases recorded yet.</StatusLine>;
  }
  const difference =
    position.costDifferenceCents === null ? null : BigInt(position.costDifferenceCents);
  if (position.shareCoverage === 'matched' && (difference === null || difference === 0n)) {
    return (
      <StatusLine tone="positive">
        {difference === null
          ? `Purchases match the ${position.shares} shares the feed reports.`
          : 'Purchases match the feed’s shares and cost basis to the cent.'}
      </StatusLine>
    );
  }
  const shares =
    position.shareCoverage === 'matched'
      ? null
      : `Purchases cover ${position.lotShares} of the ${position.shares} shares the feed reports.`;
  const cost =
    difference === null || difference === 0n
      ? null
      : `Their cost is ${formatCents(difference < 0n ? -difference : difference)} ${
          difference < 0n ? 'under' : 'over'
        } the feed’s cost basis.`;
  return <StatusLine tone="warning">{[shares, cost].filter(Boolean).join(' ')}</StatusLine>;
}

function PositionBlock({
  position,
  onEdit,
  onProblem,
}: {
  readonly position: PositionDto;
  readonly onEdit: (lot: LotDto | null) => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (lotId: string) => investmentsApi.archiveLot(lotId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['investments'] });
      await queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error: unknown) =>
      onProblem(error instanceof ApiError ? error.message : 'That lot could not be archived.'),
  });

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-quiet font-semibold text-ink">
            {position.symbol}
            <span className="font-normal text-muted"> · {position.accountName}</span>
          </h3>
          <span className="text-quiet text-muted">
            {position.shares} shares ·{' '}
            <span className="money">{formatCents(BigInt(position.marketValueCents))}</span>
            {position.feedCostBasisCents !== null && (
              <>
                {' '}
                · cost basis{' '}
                <span className="money">{formatCents(BigInt(position.feedCostBasisCents))}</span>
              </>
            )}
          </span>
        </div>
        <Button onClick={() => onEdit(null)}>Record a purchase</Button>
      </div>

      <Coverage position={position} />

      {position.lots.length > 0 && (
        <table className="w-full border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-label text-muted">
              <th className="row-cell pl-3 text-left font-normal">Bought</th>
              <th className="row-cell pr-3 text-right font-normal">Shares</th>
              <th className="row-cell pr-3 text-right font-normal">Cost</th>
              <th className="row-cell pr-3 text-right font-normal">Worth now</th>
              <th className="row-cell pr-3 text-right font-normal">In the S&amp;P 500</th>
              <th className="row-cell" />
            </tr>
          </thead>
          <tbody>
            {position.lots.map((lot) => (
              <tr key={lot.id} className="border-b border-line last:border-0">
                <td className="row-cell pl-3 text-ink">{dayLabel(lot.purchasedOn)}</td>
                <td className="money row-cell pr-3 text-ink">{lot.shares}</td>
                <td className="money row-cell pr-3 text-muted">
                  {formatCents(BigInt(lot.costCents))}
                </td>
                <td className="money row-cell pr-3 text-ink">
                  {formatCents(BigInt(lot.valueCents))}
                </td>
                <td className="money row-cell pr-3 text-muted">
                  {lot.benchmarkValueCents === null
                    ? '—'
                    : formatCents(BigInt(lot.benchmarkValueCents))}
                </td>
                <td className="row-cell pr-3 text-right whitespace-nowrap">
                  <Button variant="ghost" onClick={() => onEdit(lot)}>
                    Correct
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => archive.mutate(lot.id)}
                    disabled={archive.isPending}
                  >
                    Archive
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function InvestmentsSection(): ReactNode {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['investments'], queryFn: investmentsApi.get });
  const [editing, setEditing] = useState<{
    readonly position: PositionDto;
    readonly lot: LotDto | null;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useMutation({
    mutationFn: investmentsApi.refreshBenchmark,
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['investments'] });
    },
    onError: () => setProblem('The S&P 500’s prices could not be fetched just now.'),
  });

  const data = query.data;
  const benchmark = data?.benchmark;

  return (
    <SettingsCard
      title="Brokerage"
      description="Positions arrive with the bank feed. Record when each was bought to compare it with the S&P 500 from that day."
      action={
        <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Fetching…' : 'Fetch S&P 500 prices'}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {benchmark !== undefined && (
          <StatusLine tone={benchmark.latestDate === null ? 'muted' : 'positive'}>
            {benchmark.latestDate === null
              ? 'No S&P 500 prices yet. They are fetched each weekday evening.'
              : `S&P 500 (SPY, dividends included) through ${dayLabel(benchmark.latestDate)}.`}
          </StatusLine>
        )}

        {problem && <Alert>{problem}</Alert>}

        {data === undefined ? (
          <EmptyState>Reading positions…</EmptyState>
        ) : data.positions.length === 0 ? (
          <EmptyState>
            No positions yet. They appear here when the bank feed reports a brokerage account’s
            holdings.
          </EmptyState>
        ) : (
          data.positions.map((position) => (
            <PositionBlock
              key={position.id}
              position={position}
              onEdit={(lot) => setEditing({ position, lot })}
              onProblem={setProblem}
            />
          ))
        )}
      </div>

      {editing && (
        <LotDialog position={editing.position} lot={editing.lot} onClose={() => setEditing(null)} />
      )}
    </SettingsCard>
  );
}
