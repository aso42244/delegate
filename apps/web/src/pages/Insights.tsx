import { formatCents, INSIGHT_DISPLAYS, defaultInsightDisplay } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client.js';
import { Button } from '../components/ui.jsx';

/**
 * Insights.
 *
 * A fixed catalog of built-in widgets, toggled on and off, with the choice
 * persisted per user. §9.4 chose a catalog over a generic chart builder, and it
 * is the right call: each widget answers one question well, and nobody has to
 * learn a query language to ask it.
 */

type WidgetKey =
  | 'asset_debt_composition'
  | 'spending_by_grouping'
  | 'spending_by_delegation'
  | 'delegations_negative'
  | 'uncategorized_backlog'
  | 'utilities_vs_delegated'
  | 'income_vs_spending'
  | 'cycle_surplus'
  | 'net_worth_over_time'
  | 'credit_card_trend'
  | 'home_equity_over_time'
  | 'bitcoin_value_over_time';

/** Named for what the reader sees, not for the shape of the code. */
const DISPLAY_LABELS: Record<string, string> = {
  list: 'List',
  bars: 'Bars',
  donut: 'Donut',
  line: 'Line',
  area: 'Area',
  number: 'Number',
};

const WIDGET_TITLES: Record<WidgetKey, string> = {
  asset_debt_composition: 'Assets and debts',
  spending_by_grouping: 'Spending by grouping',
  spending_by_delegation: 'Spending by delegation',
  delegations_negative: 'Delegations currently negative',
  uncategorized_backlog: 'Uncategorized',
  utilities_vs_delegated: 'Utilities: average against funded',
  income_vs_spending: 'Income against spending',
  cycle_surplus: 'Cycle surplus and deficit',
  net_worth_over_time: 'Net worth over time',
  credit_card_trend: 'Credit card balance',
  home_equity_over_time: 'Home equity over time',
  bitcoin_value_over_time: 'Bitcoin holdings over time',
};

/** The four widgets whose data is reconstructed rather than stored — ADR 013. */
const SERIES_WIDGETS: readonly WidgetKey[] = [
  'net_worth_over_time',
  'credit_card_trend',
  'home_equity_over_time',
  'bitcoin_value_over_time',
];

const WINDOWS = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '365 days' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'cycle', label: 'This cycle' },
] as const;

interface SpendingDto {
  readonly since: string | null;
  readonly entries: readonly {
    key: string;
    name: string;
    color: string | null;
    spendCents: string;
  }[];
}

interface SeriesDto {
  readonly points: readonly { date: string; valueCents: string }[];
  readonly earliestKnown: string | null;
  readonly truncated: boolean;
}

interface SeriesResponseDto {
  readonly days: number;
  readonly net_worth_over_time: SeriesDto | null;
  readonly credit_card_trend: (SeriesDto & { name: string }) | null;
  readonly home_equity_over_time: (SeriesDto & { name: string }) | null;
}

interface InsightsDto {
  readonly window: string;
  readonly asset_debt_composition: {
    assets: readonly { name: string; balanceCents: string; shareBasisPoints: number }[];
    debts: readonly { name: string; balanceCents: string; shareBasisPoints: number }[];
    totalAssetsCents: string;
    totalDebtsCents: string;
    netCents: string;
  };
  readonly spending_by_grouping: SpendingDto;
  readonly spending_by_delegation: SpendingDto;
  readonly delegations_negative: readonly { id: string; name: string; balanceCents: string }[];
  readonly uncategorized_backlog: { count: number; oldestPostedAt: string | null };
  readonly income_vs_spending: readonly {
    startedAt: string;
    endedAt: string | null;
    incomeCents: string;
    spendingCents: string;
    surplusCents: string;
    partial: boolean;
  }[];
  readonly utilities_vs_delegated: readonly {
    name: string;
    averageCents: string;
    suggestedPerCycleCents: string;
    amountToDelegateCents: string | null;
  }[];
}

interface LayoutEntry {
  readonly key: WidgetKey;
  /** Null means the widget's own default chart. */
  readonly display: string | null;
}

function Card({
  title,
  onRemove,
  children,
  onMove,
  canMoveEarlier,
  canMoveLater,
  displays,
  display,
  onDisplay,
}: {
  readonly title: string;
  readonly onRemove: () => void;
  readonly children: ReactNode;
  /** Reordering, as buttons: drag is not reachable by keyboard or by thumb. */
  readonly onMove: (direction: -1 | 1) => void;
  readonly canMoveEarlier: boolean;
  readonly canMoveLater: boolean;
  readonly displays: readonly string[];
  readonly display: string;
  readonly onDisplay: (display: string) => void;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <header className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>

        <div className="flex shrink-0 items-center gap-1">
          {/* Only when there is a choice to make. A single-option switch is a
              control that does nothing. */}
          {displays.length > 1 && (
            <span className="mr-1 flex rounded-md bg-surface-2 p-0.5">
              {displays.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onDisplay(option)}
                  aria-pressed={display === option}
                  aria-label={`Show ${title} as ${DISPLAY_LABELS[option] ?? option}`}
                  className={`rounded px-1.5 py-0.5 text-label font-semibold ${
                    display === option ? 'bg-canvas text-ink' : 'text-muted'
                  }`}
                >
                  {DISPLAY_LABELS[option] ?? option}
                </button>
              ))}
            </span>
          )}

          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={!canMoveEarlier}
            aria-label={`Move ${title} earlier`}
            className="rounded px-1 text-quiet text-muted disabled:opacity-30"
          >
            ◂
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={!canMoveLater}
            aria-label={`Move ${title} later`}
            className="rounded px-1 text-quiet text-muted disabled:opacity-30"
          >
            ▸
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${title}`}
            className="rounded px-1 text-quiet text-muted"
          >
            ×
          </button>
        </div>
      </header>
      {children}
    </section>
  );
}

/**
 * A line, drawn as an inline SVG. The value is stated as text beside it — a
 * shape is not a number, and the number is what the owner is actually reading.
 */
function LineChart({
  series,
  filled = false,
}: {
  readonly series: SeriesDto;
  /** Fills under the line. The same data, weighted towards the total. */
  readonly filled?: boolean;
}): ReactNode {
  if (series.points.length < 2) {
    return <p className="text-quiet text-muted">Not enough history to draw a line yet.</p>;
  }

  const values = series.points.map((point) => BigInt(point.valueCents));
  const low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
  const high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);
  const span = high - low;

  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      // Percentages are layout, never money.
      const y = span === 0n ? 50 : 100 - Number(((value - low) * 100n) / span);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const latest = values[values.length - 1] ?? 0n;

  return (
    <>
      <p className="money mb-2 text-hero font-bold text-ink">{formatCents(latest)}</p>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-24 w-full" aria-hidden>
        {filled && (
          <path d={`${path} L100,100 L0,100 Z`} fill="var(--color-accent-soft)" stroke="none" />
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="mt-2 text-quiet text-muted">
        {formatCents(low)} to {formatCents(high)}
        {/* Where the history genuinely begins, said rather than implied by the
            left edge of a line. */}
        {series.earliestKnown && `, since ${new Date(series.earliestKnown).toLocaleDateString()}`}
        {series.truncated && ' — the ledger does not reach further back.'}
      </p>
    </>
  );
}

/**
 * A donut. Same data as the bars, read as shares of a whole rather than as a
 * ranking — which is the question it answers better.
 *
 * Drawn with one circle and `stroke-dasharray` rather than arc paths: a ring is
 * a stroked circle, and hand-authored arc geometry is a lot of numbers to get
 * subtly wrong.
 */
function Donut({
  entries,
  emptyNote,
}: {
  readonly entries: readonly {
    key: string;
    name: string;
    color: string | null;
    spendCents: string;
  }[];
  readonly emptyNote: string;
}): ReactNode {
  const slices = entries
    .map((entry) => ({ ...entry, value: BigInt(entry.spendCents) }))
    .filter((entry) => entry.value > 0n)
    .slice(0, 8);

  const total = slices.reduce((sum, slice) => sum + slice.value, 0n);
  if (slices.length === 0 || total <= 0n) {
    return <p className="text-quiet text-muted">{emptyNote}</p>;
  }

  // Circumference of r=15.9155 is ~100, so a dash length is a percentage.
  const RADIUS = 15.9155;
  let travelled = 0;

  const arcs = slices.map((slice, index) => {
    const share = Number((slice.value * 10_000n) / total) / 100;
    const arc = {
      key: slice.key,
      color: slice.color ?? FALLBACK_SLICE[index % FALLBACK_SLICE.length] ?? 'var(--color-accent)',
      share,
      offset: travelled,
    };
    travelled += share;
    return arc;
  });

  return (
    <div className="flex items-center gap-4">
      <svg
        viewBox="0 0 42 42"
        className="h-28 w-28 shrink-0"
        role="img"
        aria-label="Share of the total"
      >
        <circle
          cx="21"
          cy="21"
          r={RADIUS}
          fill="none"
          stroke="var(--color-surface-2)"
          strokeWidth="6"
        />
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            cx="21"
            cy="21"
            r={RADIUS}
            fill="none"
            stroke={arc.color}
            strokeWidth="6"
            strokeDasharray={`${arc.share} ${100 - arc.share}`}
            // -25 puts the first slice at twelve o'clock rather than three.
            strokeDashoffset={25 - arc.offset}
          />
        ))}
      </svg>

      {/* The legend carries the numbers. A shape is not a figure, and the
          figure is what is actually being read. */}
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {slices.map((slice, index) => (
          <li key={slice.key} className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background:
                    slice.color ??
                    FALLBACK_SLICE[index % FALLBACK_SLICE.length] ??
                    'var(--color-accent)',
                }}
              />
              <span className="truncate text-quiet text-ink">{slice.name}</span>
            </span>
            <span className="money text-quiet text-muted">{formatCents(slice.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** For entries that carry no colour of their own — a grouping-less line. */
const FALLBACK_SLICE = [
  'var(--color-accent)',
  'var(--color-group-green)',
  'var(--color-group-orange)',
  'var(--color-group-purple)',
  'var(--color-group-grey)',
];

/** The same series as columns. Reads change per period rather than a trend. */
function SeriesBars({ series }: { readonly series: SeriesDto }): ReactNode {
  if (series.points.length < 2) {
    return <p className="text-quiet text-muted">Not enough history to draw this yet.</p>;
  }

  const values = series.points.map((point) => BigInt(point.valueCents));
  const low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
  const high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);
  const span = high - low;
  const latest = values[values.length - 1] ?? 0n;

  return (
    <>
      <p className="money mb-2 text-hero font-bold text-ink">{formatCents(latest)}</p>
      <div aria-hidden className="flex h-24 items-end gap-px">
        {values.map((value, index) => (
          <span
            key={index}
            className="flex-1 rounded-t-[1px] bg-accent"
            style={{
              height: `${span === 0n ? 50 : Math.max(Number(((value - low) * 100n) / span), 2)}%`,
            }}
          />
        ))}
      </div>
      <p className="mt-2 text-quiet text-muted">
        {formatCents(low)} to {formatCents(high)}
      </p>
    </>
  );
}

/**
 * One column per cycle. Reads whether the household is trending better or worse,
 * which a list of dates does not show at a glance.
 *
 * Surplus columns grow from a baseline rather than the floor, because a deficit
 * and a surplus of the same size are opposite things and a bar chart that drew
 * them identically would be lying.
 */
function CycleBars({
  cycles,
  showSurplus,
}: {
  readonly cycles: readonly {
    startedAt: string;
    incomeCents: string;
    spendingCents: string;
    surplusCents: string;
    partial: boolean;
  }[];
  readonly showSurplus: boolean;
}): ReactNode {
  const recent = cycles.slice(-8);
  const values = recent.map((cycle) =>
    showSurplus
      ? BigInt(cycle.surplusCents)
      : BigInt(cycle.incomeCents) - BigInt(cycle.spendingCents),
  );

  const peak = values.reduce((max, value) => {
    const magnitude = value < 0n ? -value : value;
    return magnitude > max ? magnitude : max;
  }, 1n);

  return (
    <>
      <div aria-hidden className="flex h-28 items-center gap-1">
        {values.map((value, index) => {
          const height = Math.max(Number((value < 0n ? -value : value) * 100n) / Number(peak), 2);
          const negative = value < 0n;

          return (
            <span key={index} className="flex h-full flex-1 flex-col justify-center">
              <span className="flex h-1/2 items-end">
                {!negative && (
                  <span
                    className="w-full rounded-t-[2px] bg-positive"
                    style={{ height: `${height}%` }}
                  />
                )}
              </span>
              <span className="flex h-1/2 items-start">
                {negative && (
                  <span
                    className="w-full rounded-b-[2px] bg-negative"
                    style={{ height: `${height}%` }}
                  />
                )}
              </span>
            </span>
          );
        })}
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {recent.map((cycle, index) => (
          <li key={cycle.startedAt} className="flex items-baseline justify-between gap-3">
            <span className="text-quiet text-muted">
              {new Date(cycle.startedAt).toLocaleDateString()}
              {cycle.partial && <span className="ml-1">(in progress)</span>}
            </span>
            <span
              className={`money text-quiet ${
                (values[index] ?? 0n) < 0n ? 'font-semibold text-negative' : 'text-ink'
              }`}
            >
              {formatCents(values[index] ?? 0n, { explicitPlus: true })}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Picks the shape. Every series widget offers the same three. */
function SeriesChart({
  series,
  display,
}: {
  readonly series: SeriesDto;
  readonly display: string;
}): ReactNode {
  if (display === 'bars') return <SeriesBars series={series} />;
  return <LineChart series={series} filled={display === 'area'} />;
}

/** A ranked list with a proportional bar. Bars are layout; the money is text. */
function RankedBars({
  entries,
  emptyNote,
}: {
  readonly entries: readonly {
    key: string;
    name: string;
    color: string | null;
    spendCents: string;
  }[];
  readonly emptyNote: string;
}): ReactNode {
  if (entries.length === 0) return <p className="text-quiet text-muted">{emptyNote}</p>;

  const values = entries.map((entry) => BigInt(entry.spendCents));
  const peak = values.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <ul className="flex flex-col gap-2">
      {entries.slice(0, 8).map((entry, index) => {
        const value = values[index] ?? 0n;
        const width = peak <= 0n ? 0 : Number((value * 100n) / peak);

        return (
          <li key={entry.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-quiet text-ink">{entry.name}</span>
              <span className="money text-quiet text-ink">{formatCents(value)}</span>
            </div>
            <div
              aria-hidden
              className="mt-1 h-1.5 rounded-sm"
              style={{
                width: `${Math.max(width, value > 0n ? 2 : 0)}%`,
                background: entry.color ?? 'var(--color-accent)',
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

export function Insights(): ReactNode {
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<string>('30d');
  const [showCatalog, setShowCatalog] = useState(false);

  const layout = useQuery({
    queryKey: ['insights', 'layout'],
    queryFn: () =>
      api.get<{
        catalog: WidgetKey[];
        chosen: { key: WidgetKey; display: string | null }[];
      }>('/api/insights/layout'),
  });

  const data = useQuery({
    queryKey: ['insights', window],
    queryFn: () => api.get<InsightsDto>(`/api/insights?window=${window}`),
  });

  const save = useMutation({
    mutationFn: (widgets: readonly LayoutEntry[]) =>
      api.put<{ ok: boolean }>('/api/insights/layout', { widgets }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['insights', 'layout'] });
    },
  });

  const catalog = layout.data?.catalog ?? [];
  // Before anything has been chosen the page shows the whole catalog, so it is
  // useful on first visit rather than blank with a button on it.
  const chosen: LayoutEntry[] = layout.data
    ? layout.data.chosen.length > 0
      ? layout.data.chosen.map((entry) => ({ key: entry.key, display: entry.display }))
      : catalog.map((key) => ({ key, display: null }))
    : [];

  const keys = chosen.map((entry) => entry.key);

  function remove(key: WidgetKey): void {
    save.mutate(chosen.filter((entry) => entry.key !== key));
  }

  function add(key: WidgetKey): void {
    save.mutate([...chosen, { key, display: null }]);
  }

  /**
   * Moves a tile one place. Buttons rather than dragging: a drag is unreachable
   * by keyboard and awkward with a thumb, and this page is read on both.
   */
  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= chosen.length) return;

    const next = [...chosen];
    const moved = next[index];
    const displaced = next[target];
    if (!moved || !displaced) return;
    next[index] = displaced;
    next[target] = moved;
    save.mutate(next);
  }

  function setDisplay(index: number, display: string): void {
    const next = [...chosen];
    const entry = next[index];
    if (!entry) return;
    next[index] = { key: entry.key, display };
    save.mutate(next);
  }

  const insights = data.data;

  // Reconstructing balances walks the ledger per account per day, so it is only
  // fetched when a chart that needs it is actually on the page.
  const needsSeries = keys.some((key) => SERIES_WIDGETS.includes(key));
  const series = useQuery({
    queryKey: ['insights', 'series'],
    queryFn: () => api.get<SeriesResponseDto>('/api/insights/series'),
    enabled: needsSeries,
  });

  function render(key: WidgetKey, display: string): ReactNode {
    if (!insights) return null;

    switch (key) {
      case 'asset_debt_composition': {
        const composition = insights.asset_debt_composition;

        if (display === 'donut') {
          return (
            <>
              <p className="money mb-2 text-hero font-bold text-ink">
                {formatCents(BigInt(composition.netCents))}
              </p>
              <Donut
                entries={composition.assets.map((entry) => ({
                  key: entry.name,
                  name: entry.name,
                  color: null,
                  spendCents: entry.balanceCents,
                }))}
                emptyNote="No assets to show yet."
              />
            </>
          );
        }

        return (
          <>
            <p className="money mb-2 text-hero font-bold text-ink">
              {formatCents(BigInt(composition.netCents))}
            </p>
            <p className="text-quiet text-muted">
              {formatCents(BigInt(composition.totalAssetsCents))} held,{' '}
              {formatCents(BigInt(composition.totalDebtsCents))} owed.
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {composition.assets.slice(0, 6).map((entry) => (
                <li key={entry.name} className="flex items-baseline justify-between gap-3">
                  <span className="text-quiet text-ink">{entry.name}</span>
                  <span className="money text-quiet text-muted">
                    {formatCents(BigInt(entry.balanceCents))} ·{' '}
                    {(entry.shareBasisPoints / 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        );
      }

      case 'spending_by_grouping': {
        const note =
          insights.spending_by_grouping.since === null
            ? 'No Delegate press yet, so there is no cycle to report on.'
            : 'Nothing categorized in this window yet.';
        return display === 'donut' ? (
          <Donut entries={insights.spending_by_grouping.entries} emptyNote={note} />
        ) : (
          <RankedBars entries={insights.spending_by_grouping.entries} emptyNote={note} />
        );
      }

      case 'spending_by_delegation': {
        const note =
          insights.spending_by_delegation.since === null
            ? 'No Delegate press yet, so there is no cycle to report on.'
            : 'Nothing categorized in this window yet.';
        return display === 'donut' ? (
          <Donut entries={insights.spending_by_delegation.entries} emptyNote={note} />
        ) : (
          <RankedBars entries={insights.spending_by_delegation.entries} emptyNote={note} />
        );
      }

      case 'delegations_negative':
        return insights.delegations_negative.length === 0 ? (
          <p className="text-quiet text-muted">Nothing is over-spent.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {insights.delegations_negative.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3">
                <span className="text-quiet text-ink">{row.name}</span>
                <span className="money text-quiet font-semibold text-negative">
                  {formatCents(BigInt(row.balanceCents))}
                </span>
              </li>
            ))}
          </ul>
        );

      case 'uncategorized_backlog': {
        const backlog = insights.uncategorized_backlog;
        return (
          <>
            <p className="money text-hero font-bold text-ink">{backlog.count}</p>
            <p className="text-quiet text-muted">
              {backlog.count === 0
                ? 'Everything is categorized.'
                : backlog.oldestPostedAt
                  ? `Oldest from ${new Date(backlog.oldestPostedAt).toLocaleDateString()}.`
                  : 'Waiting to be categorized.'}
            </p>
          </>
        );
      }

      case 'utilities_vs_delegated':
        return insights.utilities_vs_delegated.length === 0 ? (
          <p className="text-quiet text-muted">No delegations are marked as a utility.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {insights.utilities_vs_delegated.map((utility) => (
              <li key={utility.name} className="flex items-baseline justify-between gap-3">
                <span className="text-quiet text-ink">{utility.name}</span>
                <span className="money text-quiet text-muted">
                  {formatCents(BigInt(utility.suggestedPerCycleCents))} suggested ·{' '}
                  {utility.amountToDelegateCents === null
                    ? '—'
                    : formatCents(BigInt(utility.amountToDelegateCents))}{' '}
                  funded
                </span>
              </li>
            ))}
          </ul>
        );

      case 'net_worth_over_time':
        return series.data?.net_worth_over_time ? (
          <SeriesChart series={series.data.net_worth_over_time} display={display} />
        ) : (
          <p className="text-quiet text-muted">
            No history yet. This is rebuilt from your transactions, so it starts where they do.
          </p>
        );

      case 'credit_card_trend':
        return series.data?.credit_card_trend ? (
          <>
            <p className="mb-1 text-quiet text-muted">{series.data.credit_card_trend.name}</p>
            <SeriesChart series={series.data.credit_card_trend} display={display} />
          </>
        ) : (
          <p className="text-quiet text-muted">No card in the budget to trend.</p>
        );

      case 'home_equity_over_time':
        return series.data?.home_equity_over_time ? (
          <>
            <p className="mb-1 text-quiet text-muted">{series.data.home_equity_over_time.name}</p>
            <SeriesChart series={series.data.home_equity_over_time} display={display} />
          </>
        ) : (
          <p className="text-quiet text-muted">
            No property with a mortgage linked to it. Link one in Settings → Bitcoin &amp; Property.
          </p>
        );

      case 'bitcoin_value_over_time':
        return (
          <>
            {series.data?.net_worth_over_time ? (
              <p className="text-quiet text-muted">
                Bitcoin is valued at the price on each date and counted inside net worth above.
              </p>
            ) : (
              <p className="text-quiet text-muted">No price history yet.</p>
            )}
            {/* Quantity history is not stored, so this is what today's holding
                would have been worth — said rather than implied. */}
            <p className="mt-2 text-quiet text-muted">
              Historical quantities are not recorded, so a changed holding shows what today&rsquo;s
              quantity would have been worth.
            </p>
          </>
        );

      case 'income_vs_spending':
      case 'cycle_surplus':
        if (insights.income_vs_spending.length === 0) {
          return (
            <p className="text-quiet text-muted">
              No Delegate press yet, so there are no cycles to compare.
            </p>
          );
        }

        if (display === 'bars') {
          return (
            <CycleBars cycles={insights.income_vs_spending} showSurplus={key === 'cycle_surplus'} />
          );
        }

        return (
          <ul className="flex flex-col gap-1">
            {insights.income_vs_spending.slice(-6).map((cycle) => {
              const surplus = BigInt(cycle.surplusCents);
              return (
                <li key={cycle.startedAt} className="flex items-baseline justify-between gap-3">
                  <span className="text-quiet text-ink">
                    {new Date(cycle.startedAt).toLocaleDateString()}
                    {/* A cycle still running is not comparable with finished ones. */}
                    {cycle.partial && <span className="ml-1 text-muted">(in progress)</span>}
                  </span>
                  <span
                    className={`money text-quiet ${surplus < 0n ? 'font-semibold text-negative' : 'text-ink'}`}
                  >
                    {key === 'cycle_surplus'
                      ? formatCents(surplus, { explicitPlus: true })
                      : `${formatCents(BigInt(cycle.incomeCents))} in · ${formatCents(BigInt(cycle.spendingCents))} out`}
                  </span>
                </li>
              );
            })}
          </ul>
        );
    }
  }

  const available = catalog.filter((key) => !keys.includes(key));

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-page font-bold text-ink">Insights</h1>
          <p className="mt-1 text-quiet text-muted">
            A fixed set of questions, answered well. Choose which ones you want to see.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {WINDOWS.map((option) => (
            <Button
              key={option.value}
              variant={window === option.value ? 'primary' : 'default'}
              onClick={() => setWindow(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </header>

      {data.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {chosen.map((entry, index) => {
            const options = INSIGHT_DISPLAYS[entry.key];
            const display = entry.display ?? defaultInsightDisplay(entry.key);

            return (
              <Card
                key={entry.key}
                title={WIDGET_TITLES[entry.key]}
                onRemove={() => remove(entry.key)}
                onMove={(direction) => move(index, direction)}
                canMoveEarlier={index > 0}
                canMoveLater={index < chosen.length - 1}
                displays={options}
                display={display}
                onDisplay={(next) => setDisplay(index, next)}
              >
                {render(entry.key, display)}
              </Card>
            );
          })}

          {/* The dashed "+ Add from catalog" tile the design asks for. */}
          <button
            type="button"
            onClick={() => setShowCatalog(!showCatalog)}
            aria-expanded={showCatalog}
            className="rounded-lg border border-dashed border-line p-4 text-quiet text-muted"
          >
            + Add from catalog
          </button>
        </div>
      )}

      {showCatalog && (
        <div className="mt-4 rounded-lg border border-line bg-canvas p-4">
          <h2 className="mb-2 text-base font-semibold text-ink">Catalog</h2>
          {available.length === 0 ? (
            <p className="text-quiet text-muted">Everything is already on the page.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {available.map((key) => (
                <Button key={key} onClick={() => add(key)}>
                  {WIDGET_TITLES[key]}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
