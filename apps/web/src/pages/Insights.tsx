import {
  formatCents,
  INSIGHT_DISPLAYS,
  defaultInsightDisplay,
  type SnapshotProvenance,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent, type ReactNode } from 'react';
import { api } from '../api/client.js';
import { PageHeader, SegmentedControl } from '../components/layout.jsx';
import { Button } from '../components/ui.jsx';
import { NotEnoughHistory, SnapshotChart, type ChartSeries } from '../components/SnapshotChart.jsx';

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
  | 'assets_vs_debts'
  | 'account_balance_history'
  | 'delegation_balance_history'
  | 'delegation_burn_rate'
  | 'identity_drift'
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
  utilities_vs_delegated: 'Utilities: average against delegated',
  income_vs_spending: 'Income against spending',
  cycle_surplus: 'Cycle surplus and deficit',
  net_worth_over_time: 'Net worth over time',
  assets_vs_debts: 'Assets against debts',
  account_balance_history: 'Account balance',
  delegation_balance_history: 'Delegation balances',
  delegation_burn_rate: 'Burn rate per cycle',
  identity_drift: 'Identity drift',
  home_equity_over_time: 'Home equity over time',
  bitcoin_value_over_time: 'Bitcoin holdings over time',
};

/** The widgets drawn from the nightly snapshot tables — ADR 035. */
const SNAPSHOT_WIDGETS: readonly WidgetKey[] = [
  'net_worth_over_time',
  'assets_vs_debts',
  'account_balance_history',
  'identity_drift',
  'home_equity_over_time',
  'bitcoin_value_over_time',
];

/** The two that share the drill-down, and so share a fetch of their own. */
const DRILL_WIDGETS: readonly WidgetKey[] = ['delegation_balance_history', 'delegation_burn_rate'];

/**
 * One range for the whole page.
 *
 * Seven rather than the five the snapshot charts need on their own: the spending
 * and cycle tiles predate snapshots and `Cycle` is the only window that means
 * anything to them, so one control drives everything rather than two controls
 * disagreeing above a grid that mixes both.
 */
const WINDOWS = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '6mo', label: '6 months' },
  { value: '1yr', label: '1 year' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'cycle', label: 'This cycle' },
  { value: 'all', label: 'All' },
] as const;

interface SpendingDto {
  readonly since: string | null;
  /** "Everything" and "no cycle yet" both lack a start date and mean opposite
      things, so the server says which this is rather than leaving it to a null. */
  readonly cycleMissing: boolean;
  readonly entries: readonly {
    key: string;
    name: string;
    color: string | null;
    spendCents: string;
  }[];
}

/** A point as the API shapes it: money as decimal strings, provenance intact. */
interface PointDto {
  readonly date: string;
  readonly provenance: SnapshotProvenance;
  readonly days: number;
  readonly [field: string]: string | number;
}

interface SeriesDto {
  readonly bucket: string;
  readonly days: number;
  readonly earliest: string | null;
  readonly points: readonly PointDto[];
  readonly live: Readonly<Record<string, string>> | null;
}

interface SnapshotsDto {
  readonly range: string;
  readonly aggregate: SeriesDto;
  readonly net_worth_composition: {
    days: number;
    points: readonly {
      date: string;
      provenance: SnapshotProvenance;
      bitcoinCents: string;
      otherAssetsCents: string;
      debtsCents: string;
    }[];
  };
  readonly home_equity: { name: string | null; days: number; points: readonly PointDto[] };
  readonly thirty_day_momentum: { points: readonly PointDto[] };
  readonly change_per_cycle: readonly {
    startedAt: string;
    changeCents: string;
    provenance: SnapshotProvenance;
    partial: boolean;
  }[];
  readonly debt_trajectory: {
    points: readonly PointDto[];
    payoffDate: string | null;
    hasEnoughHistory: boolean;
  };
  readonly accounts: readonly { id: string; name: string; type: string }[];
}

interface DrillDto {
  readonly level: 'groupings' | 'delegations' | 'delegation';
  readonly days: number;
  readonly cyclesPerYear: number;
  readonly groupingName: string | null;
  readonly delegationName: string | null;
  readonly series: readonly {
    key: string;
    name: string;
    color: string | null;
    burnRateCents: string;
    changeCents: string;
    points: readonly PointDto[];
  }[];
}

/** Pulls one money field off a shaped point. */
function field(point: PointDto, name: string): bigint {
  const value = point[name];
  return typeof value === 'string' ? BigInt(value) : 0n;
}

function toChartSeries(
  key: string,
  name: string,
  color: string | null,
  points: readonly PointDto[],
  fieldName: string,
): ChartSeries {
  return {
    key,
    name,
    color,
    points: points.map((point) => ({
      date: point.date,
      provenance: point.provenance,
      valueCents: field(point, fieldName),
    })),
  };
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
  displays,
  display,
  onDisplay,
  drag,
}: {
  readonly title: string;
  readonly onRemove: () => void;
  readonly children: ReactNode;
  readonly displays: readonly string[];
  readonly display: string;
  readonly onDisplay: (display: string) => void;
  readonly drag: {
    readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLElement>) => void;
    readonly onDragEnd: () => void;
    readonly isTarget: boolean;
  };
}): ReactNode {
  return (
    <section
      // Dragging is an enhancement. It is not reachable by keyboard and does
      // nothing under a thumb, so ◂ ▸ above stay the route that always works.
      draggable
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
      className={`rounded-lg border bg-canvas p-4 ${
        drag.isTarget ? 'border-accent outline-2 outline-accent' : 'border-line'
      }`}
    >
      <header className="mb-4 flex items-start justify-between gap-2">
        {/* The handle says the card is draggable. Outside the heading, because
            it is not part of the tile's name — putting it inside made the
            accessible name "⠿ Spending by grouping". */}
        <span aria-hidden className="mt-0.5 cursor-grab text-quiet text-faint">
          ⠿
        </span>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink" title={title}>
          {title}
        </h2>

        <div className="flex shrink-0 items-center gap-2">
          {/* Only when there is a choice to make. A single-option switch is a
              control that does nothing. */}
          {displays.length > 1 && (
            <SegmentedControl
              size="sm"
              label={`How to show ${title}`}
              value={display}
              options={displays.map((option) => ({
                value: option,
                label: DISPLAY_LABELS[option] ?? option,
              }))}
              onChange={onDisplay}
              describeOption={(option) => `Show ${title} as ${option.label}`}
            />
          )}

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
          <li key={cycle.startedAt} className="flex items-baseline justify-between gap-2">
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
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-quiet text-ink">{entry.name}</span>
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

/**
 * The delegation drill-down's breadcrumb.
 *
 * Three levels: every grouping, one grouping's delegations, one delegation. The
 * level survives a change of page range, so widening from 30 days to a year
 * widens the view you are looking at rather than throwing you back to the top.
 */
function Breadcrumb({
  level,
  groupingName,
  delegationName,
  onUp,
}: {
  readonly level: 'groupings' | 'delegations' | 'delegation';
  readonly groupingName: string | null;
  readonly delegationName: string | null;
  readonly onUp: () => void;
}): ReactNode {
  if (level === 'groupings') return null;

  return (
    <p className="mb-2 flex items-center gap-2">
      <Button onClick={onUp}>Back</Button>
      <span className="truncate text-quiet text-muted">
        {level === 'delegation' ? (delegationName ?? '') : (groupingName ?? '')}
      </span>
    </p>
  );
}

/**
 * Average spend per pay cycle, ranked.
 *
 * The number that reveals whether the amount delegated to a line is actually
 * right — which is why the cycle count is stated beside it rather than assumed
 * to be 26.
 */
function BurnRate({
  entries,
  cyclesPerYear,
  display,
  onPick,
  canDrill,
}: {
  readonly entries: readonly {
    key: string;
    name: string;
    color: string | null;
    burnRateCents: string;
  }[];
  readonly cyclesPerYear: number;
  readonly display: string;
  readonly onPick: (key: string) => void;
  readonly canDrill: boolean;
}): ReactNode {
  const values = entries.map((entry) => BigInt(entry.burnRateCents));
  const peak = values.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <>
      <ul className="flex flex-col gap-2">
        {entries.slice(0, 8).map((entry, index) => {
          const value = values[index] ?? 0n;
          const width = peak <= 0n ? 0 : Number((value * 100n) / peak);

          return (
            <li key={entry.key}>
              <div className="flex items-baseline justify-between gap-2">
                {canDrill ? (
                  <button
                    type="button"
                    onClick={() => onPick(entry.key)}
                    className="min-w-0 truncate text-left text-quiet text-ink underline decoration-line"
                  >
                    {entry.name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-quiet text-ink">{entry.name}</span>
                )}
                <span className="money text-quiet text-ink">{formatCents(value)}</span>
              </div>
              {display === 'bars' && (
                <div
                  aria-hidden
                  className="mt-1 h-1.5 rounded-sm"
                  style={{
                    width: `${Math.max(width, value > 0n ? 2 : 0)}%`,
                    background: entry.color ?? 'var(--color-accent)',
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-quiet text-muted">Per cycle, at {cyclesPerYear} a year.</p>
    </>
  );
}

export function Insights(): ReactNode {
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<string>('30d');
  const [showCatalog, setShowCatalog] = useState(false);
  // Which tile is being dragged, and which one the pointer is currently over.
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  // The delegation drill-down, three levels deep, and the account picker.
  const [groupingId, setGroupingId] = useState<string | null>(null);
  const [delegationId, setDelegationId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

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

  /** Lifts a tile out of the order and drops it in at another index. */
  function moveTo(from: number, to: number): void {
    if (from === to) return;

    const next = [...chosen];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
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

  // Only fetched when a chart that needs it is actually on the page. Reading a
  // year of snapshots is cheap, but it is not free on a two-core NAS.
  const needsSnapshots = keys.some((key) => SNAPSHOT_WIDGETS.includes(key));
  const snapshots = useQuery({
    queryKey: ['insights', 'snapshots', window],
    queryFn: () => api.get<SnapshotsDto>(`/api/insights/snapshots?range=${window}`),
    enabled: needsSnapshots,
  });

  /**
   * The drill-down level, held here rather than in the stored layout.
   *
   * It survives a change of range — which is the point: picking a grouping and
   * then widening from 30 days to a year should widen *that* view rather than
   * throwing you back to the top. It is not persisted, because where somebody
   * had drilled to last week is not a preference.
   */
  const needsDrill = keys.some((key) => DRILL_WIDGETS.includes(key));
  const drill = useQuery({
    queryKey: ['insights', 'drill', window, groupingId, delegationId],
    queryFn: () =>
      api.get<DrillDto>(
        `/api/insights/snapshots/delegations?range=${window}` +
          (groupingId ? `&groupingId=${groupingId}` : '') +
          (delegationId ? `&delegationId=${delegationId}` : ''),
      ),
    enabled: needsDrill,
  });

  const accounts = snapshots.data?.accounts ?? [];
  const shownAccount = accountId ?? accounts[0]?.id ?? null;
  const accountHistory = useQuery({
    queryKey: ['insights', 'account', shownAccount, window],
    queryFn: () =>
      api.get<SeriesDto>(`/api/insights/snapshots/account/${shownAccount!}?range=${window}`),
    enabled: shownAccount !== null && keys.includes('account_balance_history'),
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
            <ul className="mt-4 flex flex-col gap-1">
              {composition.assets.slice(0, 6).map((entry) => (
                <li key={entry.name} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-quiet text-ink">{entry.name}</span>
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
        const note = insights.spending_by_grouping.cycleMissing
          ? 'No Delegate press yet, so there is no cycle to report on.'
          : 'Nothing categorized in this window.';
        return display === 'donut' ? (
          <Donut entries={insights.spending_by_grouping.entries} emptyNote={note} />
        ) : (
          <RankedBars entries={insights.spending_by_grouping.entries} emptyNote={note} />
        );
      }

      case 'spending_by_delegation': {
        const note = insights.spending_by_delegation.cycleMissing
          ? 'No Delegate press yet, so there is no cycle to report on.'
          : 'Nothing categorized in this window.';
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
              <li key={row.id} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-quiet text-ink">{row.name}</span>
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
              <li key={utility.name} className="flex items-baseline justify-between gap-2">
                <span className="text-quiet text-ink">{utility.name}</span>
                <span className="money text-quiet text-muted">
                  {formatCents(BigInt(utility.suggestedPerCycleCents))} suggested ·{' '}
                  {utility.amountToDelegateCents === null
                    ? '—'
                    : formatCents(BigInt(utility.amountToDelegateCents))}{' '}
                  delegated
                </span>
              </li>
            ))}
          </ul>
        );

      case 'net_worth_over_time':
      case 'assets_vs_debts':
      case 'identity_drift': {
        const data = snapshots.data?.aggregate;
        if (!data) return <NotEnoughHistory days={0} />;

        // Three readings of one stored series. Every field each of them needs is
        // on every point, so the page fetches it once.
        if (key === 'assets_vs_debts') {
          return (
            <SnapshotChart
              display={display}
              days={data.days}
              label="Assets against debts"
              series={[
                toChartSeries('assets', 'Assets', null, data.points, 'netWorthAssetsCents'),
                toChartSeries('debts', 'Debts', null, data.points, 'netWorthDebtsCents'),
              ]}
            />
          );
        }

        if (key === 'identity_drift') {
          return (
            <>
              <SnapshotChart
                display={display}
                days={data.days}
                label="Identity drift"
                zeroLine
                series={[toChartSeries('drift', 'Drift', null, data.points, 'identityValueCents')]}
                liveCents={data.live ? BigInt(data.live['identityValueCents'] ?? '0') : null}
              />
              {/* What the line means, once, rather than a legend nobody reads. */}
              <p className="mt-1 text-quiet text-muted">
                It should sit near the line. A slow walk away means something is miscategorised.
              </p>
            </>
          );
        }

        return (
          <SnapshotChart
            display={display}
            days={data.days}
            label="Net worth over time"
            series={[toChartSeries('net', 'Net worth', null, data.points, 'netWorthCents')]}
            liveCents={data.live ? BigInt(data.live['netWorthCents'] ?? '0') : null}
          />
        );
      }

      case 'account_balance_history': {
        if (accounts.length === 0) return <NotEnoughHistory days={0} />;

        return (
          <>
            {/* The picker the hardwired credit-card tile never had. */}
            <label className="mb-2 flex items-center gap-2">
              <span className="text-quiet text-muted">Account</span>
              <select
                className="field-md rounded border border-line bg-canvas px-1 text-quiet text-ink"
                value={shownAccount ?? ''}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>

            {accountHistory.data ? (
              <SnapshotChart
                display={display}
                days={accountHistory.data.days}
                label="Account balance"
                series={[
                  toChartSeries(
                    'balance',
                    'Balance',
                    null,
                    accountHistory.data.points,
                    'balanceCents',
                  ),
                ]}
                liveCents={
                  accountHistory.data.live
                    ? BigInt(accountHistory.data.live['balanceCents'] ?? '0')
                    : null
                }
              />
            ) : (
              <NotEnoughHistory days={0} />
            )}
          </>
        );
      }

      case 'delegation_balance_history':
      case 'delegation_burn_rate': {
        const data = drill.data;
        if (!data) return <NotEnoughHistory days={0} />;

        return (
          <>
            <Breadcrumb
              level={data.level}
              groupingName={data.groupingName}
              delegationName={data.delegationName}
              onUp={() => {
                if (delegationId) setDelegationId(null);
                else setGroupingId(null);
              }}
            />

            {data.series.length === 0 ? (
              <NotEnoughHistory days={data.days} />
            ) : key === 'delegation_burn_rate' ? (
              <BurnRate
                entries={data.series}
                cyclesPerYear={data.cyclesPerYear}
                display={display}
                onPick={(entryKey) => {
                  if (data.level === 'groupings') setGroupingId(entryKey);
                  else if (data.level === 'delegations') setDelegationId(entryKey);
                }}
                canDrill={data.level !== 'delegation'}
              />
            ) : (
              <>
                <SnapshotChart
                  display={display}
                  days={data.days}
                  label="Delegation balances"
                  series={data.series.map((entry) =>
                    toChartSeries(entry.key, entry.name, entry.color, entry.points, 'balanceCents'),
                  )}
                />
                {data.level !== 'delegation' && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {data.series.slice(0, 8).map((entry) => (
                      <li key={entry.key}>
                        <Button
                          onClick={() =>
                            data.level === 'groupings'
                              ? setGroupingId(entry.key)
                              : setDelegationId(entry.key)
                          }
                        >
                          {entry.name}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        );
      }

      case 'home_equity_over_time': {
        const equity = snapshots.data?.home_equity;
        if (!equity || equity.name === null) {
          return <p className="text-quiet text-muted">No property with a mortgage linked to it.</p>;
        }
        return (
          <>
            <p className="mb-1 text-quiet text-muted">{equity.name}</p>
            <SnapshotChart
              display={display}
              days={equity.days}
              label="Home equity over time"
              series={[toChartSeries('equity', 'Equity', null, equity.points, 'equityCents')]}
            />
          </>
        );
      }

      case 'bitcoin_value_over_time': {
        /*
         * Read from the composition series, which already separates a holding
         * from every other asset by whether the stored row carried a quantity.
         * That is the only split derivable from what was recorded.
         */
        const data = snapshots.data?.net_worth_composition;
        if (!data || data.points.length === 0) {
          return <p className="text-quiet text-muted">No holding recorded yet.</p>;
        }

        return (
          <SnapshotChart
            display={display}
            days={data.days}
            label="Bitcoin holdings over time"
            series={[
              {
                key: 'bitcoin',
                name: 'Bitcoin',
                color: null,
                points: data.points.map((point) => ({
                  date: point.date,
                  provenance: point.provenance,
                  valueCents: BigInt(point.bitcoinCents),
                })),
              },
            ]}
          />
        );
      }

      case 'income_vs_spending':
      case 'cycle_surplus':
        if (insights.income_vs_spending.length === 0) {
          return <p className="text-quiet text-muted">No cycles yet.</p>;
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
                <li key={cycle.startedAt} className="flex items-baseline justify-between gap-2">
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
      <PageHeader
        title="Insights"
        actions={
          <>
            {/* One control rather than five buttons with one of them turned
                primary — which put a second, differently-built segmented control
                directly above the ones in every tile header. */}
            <SegmentedControl
              label="Time window"
              value={window}
              options={WINDOWS}
              onChange={setWindow}
            />

            {/* Up here rather than a dashed tile at the end of the grid. Adding a
                card is an action on the page, and it was sitting wherever the
                last card happened to leave it — below the fold once enough were
                on. */}
            <Button onClick={() => setShowCatalog(!showCatalog)} aria-expanded={showCatalog}>
              New tile
            </Button>
          </>
        }
      />

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
                displays={options}
                display={display}
                onDisplay={(next) => setDisplay(index, next)}
                drag={{
                  isTarget: dragTarget === index && dragging !== index,
                  onDragStart: (event) => {
                    setDragging(index);
                    // Some browsers refuse to start a drag without payload.
                    event.dataTransfer.setData('text/plain', entry.key);
                    event.dataTransfer.effectAllowed = 'move';
                  },
                  onDragOver: (event) => {
                    if (dragging === null) return;
                    // Without preventDefault the drop never fires at all.
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragTarget(index);
                  },
                  onDrop: (event) => {
                    event.preventDefault();
                    if (dragging !== null) moveTo(dragging, index);
                    setDragging(null);
                    setDragTarget(null);
                  },
                  onDragEnd: () => {
                    setDragging(null);
                    setDragTarget(null);
                  },
                }}
              >
                {render(entry.key, display)}
              </Card>
            );
          })}
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
