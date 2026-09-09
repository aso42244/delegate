import {
  columnsForRow,
  flattenRows,
  formatCents,
  groupIntoRows,
  MAX_TILES_PER_ROW,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMediaQuery } from '../useMediaQuery.js';
import {
  overviewApi,
  type OverviewDataDto,
  type SeriesPointDto,
  type OverviewLayoutDto,
  type OverviewTileDto,
} from '../api/overview.js';
import { EmptyState, PageHeader, SegmentedControl } from '../components/layout.jsx';
import { budgetApi, type BudgetViewDto } from '../api/budget.js';
import { DelegationPickerDialog } from '../components/DelegationPickerDialog.jsx';
import { OverviewPanel, type PanelTab } from '../components/OverviewPanel.jsx';
import { Sankey, type FlowNode } from '../components/Sankey.jsx';
import { CompositionBars, RankedBars, type RankedRow } from '../components/RankedBars.jsx';
import { TimeSeriesChart, type TimePoint } from '../components/TimeSeries.jsx';
import { Alert, Button, Modal, Toggle } from '../components/ui.jsx';

/**
 * Overview — the dashboard that replaces Insights.
 *
 * Not in the sidebar yet. It is reachable at `/overview` and nowhere else while
 * the tiles are ported in batches, so it can be used against real data through
 * the whole build rather than only at the end of it. The release that puts it in
 * the navigation is the release that removes Insights.
 *
 * Three things are settled here and everything later sits on them.
 *
 * **The period is in the URL.** Insights kept its window in component state, so
 * it reset to thirty days every time somebody left the page — including when
 * they left by pressing one of its own tiles. Here it survives navigation, the
 * back button and a reload, and a particular view can be linked to.
 *
 * **One arrangement, adapted.** A tile states a width for the desktop grid and
 * is always full width on a phone, so rearranging on a phone rearranges the
 * laptop too and there is only ever one thing to keep in step. The six-column
 * grid and its four words are `SettingsCard`'s, not a second scale.
 *
 * **Arranging is optimistic; nothing else here would be.** Moving a tile is a
 * change that moves rows, and design.md's rule is that those can be optimistic
 * while a change that moves money cannot. The cache is updated first and the
 * request follows; a failure puts it back and says so.
 */

/** The cashflow chart's own options, defaulting to year-to-date. */
const CASHFLOW_WINDOWS = [
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'ytd', label: 'YTD' },
  { value: '1yr', label: '1Y' },
  { value: 'all', label: 'All' },
] as const;

/** Per device, like the sidebar's collapse: a fact about this screen. */
const PANEL_KEY = 'budget.overview.panel-collapsed';

/** A phone's four destinations. The panel's three tabs, plus the tiles. */
const PHONE_VIEWS = [
  { value: 'overview' as const, label: 'Overview' },
  { value: 'delegations' as const, label: 'Delegations' },
  { value: 'accounts' as const, label: 'Accounts' },
  { value: 'debts' as const, label: 'Debts' },
];

const WINDOWS = [
  { value: 'cycle', label: 'Cycle' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'ytd', label: 'YTD' },
] as const;

type WindowValue = (typeof WINDOWS)[number]['value'];

function isWindow(value: string): value is WindowValue {
  return WINDOWS.some((option) => option.value === value);
}

/** What each tile is called on screen, and the one line under its title. */
const TILE_COPY: Record<string, { readonly title: string; readonly description?: string }> = {
  spending_by_grouping: { title: 'Spending by grouping' },
  spending_by_delegation: { title: 'Spending by delegation' },
  asset_debt_composition: { title: 'What it is all made of' },
  utilities_vs_delegated: { title: 'Utilities against what they cost' },
  delegation_movers: { title: 'What moved' },
  net_worth_over_time: { title: 'Net worth' },
  assets_vs_debts: { title: 'Assets against debts' },
  identity_drift: { title: 'Identity drift' },
  net_worth_composition: { title: 'What net worth is made of' },
  bitcoin_value_over_time: { title: 'Bitcoin over time' },
  home_equity_over_time: { title: 'Home equity' },
  debt_trajectory: { title: 'Debt trajectory' },
  figures: { title: 'Figures' },
  cashflow: { title: 'Cashflow', description: 'Where the money went' },
  delegations: { title: 'Delegations' },
  delegations_negative: { title: 'Over-spent lines' },
  cycle_surplus: { title: 'This cycle' },
  income_vs_spending: { title: 'Income against spending' },
  change_per_cycle: { title: 'Change per cycle' },
  thirty_day_momentum: { title: '30-day momentum' },
  delegation_burn_rate: { title: 'What each line burns' },
  uncategorized_backlog: { title: 'Waiting to be categorized' },
};

/** History starts at the first night and gains one a night — there is no backfill. */
const NO_HISTORY = 'No history yet — the first night records one.';

/**
 * Column spans as whole class names.
 *
 * Tailwind reads the source for the classes it emits, so an interpolated one is
 * a class that exists in the browser's stylesheet nowhere. Four entries because
 * a row holds at most four tiles — see `MAX_TILES_PER_ROW` and the arithmetic
 * behind it.
 */
/**
 * Whole class names, because Tailwind reads the source for the classes it emits
 * and an interpolated one exists in the browser's stylesheet nowhere.
 *
 * Two entries, not four: a row holds at most two tiles now that the panel takes
 * the right of the page.
 */
const COLUMN_CLASS: Record<number, string> = {
  12: 'lg:col-span-12',
  6: 'lg:col-span-6',
};

function TileShell({
  tile,
  columns,
  arranging,
  draggable,
  rowSize,
  onMove,
  onRemove,
  onSplit,
  onJoin,
  drag,
  children,
}: {
  readonly tile: OverviewTileDto;
  readonly columns: number;
  readonly arranging: boolean;
  /** Pointer devices only — HTML5 drag fires no events under a thumb. */
  readonly draggable: boolean;
  readonly rowSize: number;
  readonly onMove: (step: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onSplit: () => void;
  readonly onJoin: () => void;
  readonly drag: {
    readonly onDragStart: () => void;
    readonly onDragOver: (event: React.DragEvent) => void;
    readonly onDrop: (event: React.DragEvent) => void;
    readonly over: 'left' | 'right' | null;
  };
  readonly children: ReactNode;
}): ReactNode {
  const copy = TILE_COPY[tile.key] ?? { title: tile.key };

  return (
    <section
      className={`group relative col-span-1 flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-canvas p-4 ${
        COLUMN_CLASS[columns] ?? 'lg:col-span-12'
      } ${draggable ? 'cursor-grab' : ''}`}
      draggable={draggable}
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      data-tile={tile.key}
    >
      {/* The edge a drop would land on. Drawn on the tile rather than between
          tiles, because a gap is a target nobody can hit at 24px. */}
      {drag.over !== null && (
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 w-1 rounded bg-accent ${
            drag.over === 'left' ? '-left-1' : '-right-1'
          }`}
        />
      )}

      <div className="flex min-w-0 items-baseline gap-2">
        {/*
          Says the tile can be pulled. Revealed on hover rather than drawn
          permanently, because it is an affordance for an occasional act on a
          page of figures — and it keeps its width either way, since an
          `opacity-0` control still occupies its box and a header that reflows on
          hover is worse than one carrying a faint glyph.
        */}
        {draggable && (
          <span
            aria-hidden="true"
            className="shrink-0 text-quiet text-faint opacity-0 transition-opacity group-hover:opacity-100"
          >
            ⠿
          </span>
        )}
        <h2 className="min-w-0 truncate text-section font-semibold text-ink">{copy.title}</h2>
        {copy.description !== undefined && (
          <p className="truncate text-quiet text-muted">{copy.description}</p>
        )}
        {arranging && (
          /*
           * Every control names the tile it acts on. A grid of tiles each
           * carrying "Move earlier" gives a screen reader a column of identical
           * names, and the arrows are glyphs, so the accessible name is the only
           * name there is.
           *
           * These exist because **dragging is never the only route** — it is not
           * reachable by keyboard and does nothing under a thumb. Drag is the
           * fast way; this is the way that always works.
           */
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              onClick={onJoin}
              aria-label={`Move ${copy.title} into the row above`}
              className="hidden lg:inline-flex"
            >
              ⤒
            </Button>
            <Button
              variant="ghost"
              onClick={onSplit}
              aria-label={`Give ${copy.title} a row of its own`}
              className="hidden lg:inline-flex"
              disabled={rowSize === 1}
            >
              ⤓
            </Button>
            <Button
              variant="ghost"
              onClick={() => onMove(-1)}
              aria-label={`Move ${copy.title} earlier`}
            >
              ◂
            </Button>
            <Button
              variant="ghost"
              onClick={() => onMove(1)}
              aria-label={`Move ${copy.title} later`}
            >
              ▸
            </Button>
            <Button variant="ghost" onClick={onRemove} aria-label={`Remove ${copy.title}`}>
              ×
            </Button>
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Spending, ranked. The same component for grouping and for delegation, because
 * they are the same picture of a different cut of the same rows.
 */
function SpendingTile({
  spending,
}: {
  readonly spending: NonNullable<OverviewDataDto['spending_by_grouping']>;
}): ReactNode {
  if (spending.cycleMissing) {
    return <EmptyState>No cycle has been run yet.</EmptyState>;
  }

  const rows: RankedRow[] = spending.entries.map((entry) => ({
    key: entry.key,
    name: entry.name,
    color: entry.color,
    valueCents: BigInt(entry.spendCents),
  }));

  return <RankedBars rows={rows} emptyMessage="Nothing categorized in this window." />;
}

/** Assets over debts, and the figure that reconciles them. */
function CompositionTile({
  composition,
}: {
  readonly composition: NonNullable<OverviewDataDto['asset_debt_composition']>;
}): ReactNode {
  const toRow = (entry: (typeof composition.assets)[number]): RankedRow => ({
    key: entry.name,
    name: entry.name,
    valueCents: BigInt(entry.balanceCents),
  });

  return (
    <CompositionBars
      assets={composition.assets.map(toRow)}
      debts={composition.debts.map(toRow)}
      netCents={BigInt(composition.netCents)}
      emptyMessage="No accounts in net worth yet."
    />
  );
}

/**
 * What each utility is funded at, against what it costs.
 *
 * Both figures are **per cycle**, which is the comparison — a monthly average
 * beside a per-paycheck amount looks comparable and is not. The bar is the
 * suggestion, because that is the figure being ranked; what the line is actually
 * set to sits beside it as the thing to judge it against.
 */
function UtilitiesTile({
  utilities,
}: {
  readonly utilities: NonNullable<OverviewDataDto['utilities_vs_delegated']>;
}): ReactNode {
  const rows: RankedRow[] = utilities.entries.map((entry) => ({
    key: entry.delegationId,
    name: entry.name,
    color: entry.color,
    valueCents: BigInt(entry.suggestedPerCycleCents),
    compare: {
      label: 'delegated per cycle',
      valueCents: entry.amountToDelegateCents === null ? null : BigInt(entry.amountToDelegateCents),
    },
  }));

  return (
    <div className="flex flex-col gap-2">
      <RankedBars rows={rows} emptyMessage="No utilities tracked yet." />
      {rows.length > 0 && (
        <p className="text-quiet text-muted">
          Suggested and delegated, per cycle, over {utilities.cyclesPerYear} a year.
        </p>
      )}
    </div>
  );
}

/** Which lines moved over the window, in both directions from a centre line. */
function MoversTile({
  movers,
}: {
  readonly movers: NonNullable<OverviewDataDto['delegation_movers']>;
}): ReactNode {
  if (movers.cycleMissing) {
    return <EmptyState>No cycle has been run yet.</EmptyState>;
  }

  const rows: RankedRow[] = movers.entries.map((entry) => ({
    key: entry.delegationId,
    name: entry.name,
    color: entry.color,
    valueCents: BigInt(entry.changeCents),
  }));

  return (
    <RankedBars rows={rows} signed emptyMessage="No history yet — the first night records one." />
  );
}

/** One figure, and the sentence that says what to do about it. */
function BacklogTile({
  backlog,
}: {
  readonly backlog: NonNullable<OverviewDataDto['uncategorized_backlog']>;
}): ReactNode {
  if (backlog.count === 0) {
    return <EmptyState>Nothing waiting.</EmptyState>;
  }

  const oldest = backlog.oldestPostedAt;
  const days =
    oldest === null
      ? null
      : Math.floor((Date.now() - new Date(oldest).getTime()) / (24 * 60 * 60 * 1000));

  return (
    <Figure
      value={String(backlog.count)}
      note={days === null ? 'Waiting to be categorized.' : `Waiting, oldest ${days}d.`}
      tone="warning"
      action={
        <Link
          to="/transactions?uncategorized=true"
          className="text-quiet font-semibold text-accent hover:underline"
        >
          Open the queue →
        </Link>
      }
    />
  );
}

/**
 * One number, and the sentence that says what to do about it.
 *
 * `text-figure` is the top of the scale and the same size as a page title,
 * deliberately not larger — a dashboard where every tile shouts louder than the
 * page it sits on has spent the last of its hierarchy. See ui-system.md §2.
 *
 * The tone is carried by the words as well as the colour, the rule every other
 * state in this application follows.
 */
function Figure({
  value,
  note,
  tone = 'neutral',
  action,
}: {
  readonly value: string;
  readonly note: string;
  readonly tone?: 'neutral' | 'positive' | 'negative' | 'warning';
  readonly action?: ReactNode;
}): ReactNode {
  const colour =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'negative'
        ? 'text-negative'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-ink';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className={`money text-figure font-bold ${colour}`}>{value}</span>
        <span className="text-quiet text-muted">{note}</span>
      </div>
      {action}
    </div>
  );
}

/**
 * Turns a serialised point into one the chart can draw.
 *
 * Money arrives as strings of cents (ADR 002) and becomes `bigint` exactly here,
 * at the page edge — never a `number`, and never earlier than it has to.
 */
function toPoints(points: readonly SeriesPointDto[], fields: readonly string[]): TimePoint[] {
  return points.map((raw) => ({
    date: raw.date,
    provenance: raw.provenance as TimePoint['provenance'],
    values: Object.fromEntries(
      fields.map((field) => {
        const value = raw[field];
        // A field the server did not send is absent, not zero — but a chart has
        // to draw something, and zero is the only honest stand-in for a series
        // this tile was told to read.
        return [field, BigInt(typeof value === 'string' ? value : '0')];
      }),
    ),
  }));
}

function toLive(
  live: Readonly<Record<string, string>> | null | undefined,
  fields: readonly string[],
): Record<string, bigint> | null {
  if (!live) return null;
  return Object.fromEntries(fields.map((field) => [field, BigInt(live[field] ?? '0')]));
}

/** The three tiles that share one aggregate series, each reading its own fields. */
function AggregateTile({
  aggregate,
  tileKey,
}: {
  readonly aggregate: NonNullable<OverviewDataDto['aggregate']>;
  readonly tileKey: string;
}): ReactNode {
  const spec =
    tileKey === 'assets_vs_debts'
      ? {
          fields: ['netWorthAssetsCents', 'netWorthDebtsCents'],
          series: [
            { key: 'netWorthAssetsCents', name: 'Assets' },
            { key: 'netWorthDebtsCents', name: 'Debts' },
          ],
          includeZero: false,
          label: 'Assets against debts over time',
        }
      : tileKey === 'identity_drift'
        ? {
            fields: ['identityValueCents'],
            series: [{ key: 'identityValueCents', name: 'Drift' }],
            // Drift is read against zero, so zero has to be on the chart even
            // when every point sits above it.
            includeZero: true,
            label: 'How far the budget identity sat from zero',
          }
        : {
            fields: ['netWorthCents'],
            series: [{ key: 'netWorthCents', name: 'Net worth' }],
            includeZero: false,
            label: 'Net worth over time',
          };

  return (
    <TimeSeriesChart
      points={toPoints(aggregate.points, spec.fields)}
      series={spec.series}
      live={toLive(aggregate.live, spec.fields)}
      includeZero={spec.includeZero}
      emptyMessage={NO_HISTORY}
      label={spec.label}
    />
  );
}

/**
 * The composition series, read two ways.
 *
 * A holding is separated from every other asset by whether the stored row
 * carried a quantity — which is the only split derivable from what was actually
 * recorded, rather than one inferred afterwards from today's accounts.
 */
function CompositionSeriesTile({
  composition,
  tileKey,
}: {
  readonly composition: NonNullable<OverviewDataDto['composition']>;
  readonly tileKey: string;
}): ReactNode {
  const bitcoinOnly = tileKey === 'bitcoin_value_over_time';
  const fields = bitcoinOnly
    ? ['bitcoinCents']
    : ['otherAssetsCents', 'bitcoinCents', 'debtsCents'];

  const points = toPoints(composition.points, fields);

  if (bitcoinOnly && points.every((entry) => entry.values['bitcoinCents'] === 0n)) {
    return <p className="text-quiet text-muted">No holding recorded yet.</p>;
  }

  return (
    <TimeSeriesChart
      points={points}
      series={
        bitcoinOnly
          ? [{ key: 'bitcoinCents', name: 'Bitcoin' }]
          : [
              { key: 'otherAssetsCents', name: 'Other assets' },
              { key: 'bitcoinCents', name: 'Bitcoin' },
              { key: 'debtsCents', name: 'Debts' },
            ]
      }
      emptyMessage={NO_HISTORY}
      label={bitcoinOnly ? 'Bitcoin holdings over time' : 'What net worth is made of'}
    />
  );
}

/** The property less what is still owed on it. */
function EquityTile({
  equity,
}: {
  readonly equity: NonNullable<OverviewDataDto['home_equity_over_time']>;
}): ReactNode {
  if (equity.name === null) {
    return <p className="text-quiet text-muted">No property with a mortgage against it.</p>;
  }

  return (
    <TimeSeriesChart
      points={toPoints(equity.points, ['equityCents'])}
      series={[{ key: 'equityCents', name: equity.name }]}
      emptyMessage={NO_HISTORY}
      label={`Equity in ${equity.name} over time`}
    />
  );
}

/** Where the debts are heading, and when they reach zero if they do. */
function TrajectoryTile({
  trajectory,
}: {
  readonly trajectory: NonNullable<OverviewDataDto['debt_trajectory']>;
}): ReactNode {
  if (!trajectory.hasEnoughHistory) {
    // Distinct from "never pays off", which is a projection rather than a gap.
    return <p className="text-quiet text-muted">Not enough history to project yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <TimeSeriesChart
        points={toPoints(trajectory.points, ['debtsCents'])}
        series={[{ key: 'debtsCents', name: 'Debts' }]}
        includeZero
        emptyMessage={NO_HISTORY}
        label="Total debt over time"
      />
      <p className="text-quiet text-muted">
        {trajectory.payoffDate === null
          ? 'Not paying down at the current rate.'
          : `Clear around ${new Date(trajectory.payoffDate).toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric',
            })}.`}
      </p>
    </div>
  );
}

/** The lines that are over-spent — the only red on the budget, per §11. */
function NegativeTile({
  lines,
}: {
  readonly lines: NonNullable<OverviewDataDto['delegations_negative']>;
}): ReactNode {
  if (lines.length === 0) {
    return <p className="text-quiet text-muted">Nothing over-spent.</p>;
  }

  return (
    <RankedBars
      rows={lines.map((line) => ({
        key: line.id,
        name: line.name,
        valueCents: BigInt(line.balanceCents),
        color: 'var(--color-negative)',
      }))}
      emptyMessage="Nothing over-spent."
    />
  );
}

/** The cycle in progress: what came in, what went out, what is left. */
function CycleTile({
  cycles,
  tileKey,
}: {
  readonly cycles: NonNullable<OverviewDataDto['cycles']>;
  readonly tileKey: string;
}): ReactNode {
  const current = cycles[cycles.length - 1];
  if (!current) {
    return <p className="text-quiet text-muted">No cycle has been run yet.</p>;
  }

  if (tileKey === 'cycle_surplus') {
    const surplus = BigInt(current.surplusCents);
    return (
      <Figure
        value={formatCents(surplus, { explicitPlus: true })}
        note={
          current.partial ? 'Surplus so far this cycle.' : 'Surplus over the last complete cycle.'
        }
        tone={surplus < 0n ? 'negative' : 'positive'}
      />
    );
  }

  /*
   * Income and spending across every cycle, as a pair of bars per cycle rather
   * than two lines. A cycle is a discrete thing — one Delegate press to the
   * next — and a line drawn between two of them implies values in between that
   * nobody recorded and that do not exist.
   */
  return (
    <RankedBars
      rows={cycles
        .slice()
        .reverse()
        .map((cycle) => ({
          key: cycle.startedAt,
          name: new Date(cycle.startedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          }),
          valueCents: BigInt(cycle.incomeCents),
          compare: { label: 'spent', valueCents: BigInt(cycle.spendingCents) },
          ...(cycle.partial ? { note: `${formatCents(BigInt(cycle.incomeCents))} so far` } : {}),
        }))}
      emptyMessage="No cycle has been run yet."
    />
  );
}

/** Net worth change per pay cycle, aligned to actual paydays. */
function ChangePerCycleTile({
  cycles,
}: {
  readonly cycles: NonNullable<OverviewDataDto['change_per_cycle']>;
}): ReactNode {
  return (
    <RankedBars
      signed
      rows={cycles
        .slice()
        .reverse()
        .map((cycle) => ({
          key: cycle.startedAt,
          name: new Date(cycle.startedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          }),
          valueCents: BigInt(cycle.changeCents),
        }))}
      emptyMessage={NO_HISTORY}
    />
  );
}

/** What each line spends in one pay cycle, at the rate observed. */
function BurnRateTile({
  burn,
}: {
  readonly burn: NonNullable<OverviewDataDto['delegation_burn_rate']>;
}): ReactNode {
  if (burn.cycleMissing) {
    return <EmptyState>No cycle has been run yet.</EmptyState>;
  }

  return (
    <RankedBars
      rows={burn.entries.map((entry) => ({
        key: entry.delegationId,
        name: entry.name,
        color: entry.color,
        valueCents: BigInt(entry.perCycleCents),
      }))}
      emptyMessage={NO_HISTORY}
    />
  );
}

/**
 * The lines somebody chose to watch.
 *
 * Drawn from the **budget's own read model** rather than anything computed for
 * this page. Remaining and To delegate are live figures with no period in them,
 * the Budget page already reads them, and a second query would be a second
 * answer to a question already answered — which is how two places come to
 * disagree about the same number.
 *
 * Remaining is the hero at `text-hero`; To delegate stays quiet at
 * `--color-faint`, exactly as design.md specifies for that column.
 */
function DelegationsTile({
  budget,
  chosen,
  onChoose,
}: {
  readonly budget: BudgetViewDto | undefined;
  readonly chosen: readonly string[];
  readonly onChoose: () => void;
}): ReactNode {
  const rows = (budget?.delegations.groupings ?? [])
    .filter((grouping) => grouping.systemKey !== 'outstanding-checks')
    .flatMap((grouping) => grouping.rows.map((row) => ({ row, color: grouping.color })))
    .concat((budget?.delegations.ungrouped ?? []).map((row) => ({ row, color: null })))
    .filter((entry) => chosen.includes(entry.row.id));

  return (
    <div className="flex flex-col gap-4">
      {chosen.length === 0 ? (
        <EmptyState>No delegations chosen yet.</EmptyState>
      ) : rows.length === 0 ? (
        // Chosen, but none of them resolve: every one has been archived since.
        // Different from choosing none, and it should say so.
        <EmptyState>The chosen delegations have been archived.</EmptyState>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="border-b-2 border-ink pb-1 text-left text-label uppercase tracking-[0.05em] text-muted">
                Delegation
              </th>
              <th className="border-b-2 border-ink pb-1 text-right text-label uppercase tracking-[0.05em] text-muted">
                Remaining
              </th>
              <th className="border-b-2 border-ink pb-1 text-right text-label uppercase tracking-[0.05em] text-muted">
                To delegate
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, color }) => {
              const balance = BigInt(row.balanceCents);
              return (
                <tr key={row.id}>
                  <td className="row-cell border-b border-line">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: color ?? 'var(--color-group-grey)' }}
                      />
                      <span className="truncate text-base text-ink">{row.name}</span>
                    </span>
                  </td>
                  <td
                    className={`money row-cell border-b border-line text-hero font-bold ${
                      balance < 0n ? 'text-negative' : 'text-ink'
                    }`}
                  >
                    {formatCents(balance)}
                  </td>
                  {/* Deliberately quiet — design.md makes this the de-emphasised
                      column, and it is the one figure here nobody reads twice a
                      day. */}
                  <td className="money row-cell border-b border-line text-quiet text-faint">
                    {row.amountToDelegateCents === null
                      ? '—'
                      : formatCents(BigInt(row.amountToDelegateCents))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="mt-auto flex items-center gap-2 border-t border-line pt-2">
        <button type="button" className="linkish" onClick={onChoose}>
          Choose which delegations show →
        </button>
      </div>
    </div>
  );
}

/**
 * The cashflow chart, and its own period control.
 *
 * Its window is separate from the page's on purpose: this answers "where did it
 * go", read as a retrospective, while everything around it answers "where do I
 * stand". Year-to-date by default, because a fortnight of cashflow is mostly one
 * paycheck and one rent payment.
 */
function CashflowTile({
  cashflow,
  window,
  onWindow,
  preview = false,
}: {
  readonly cashflow: NonNullable<OverviewDataDto['cashflow']>;
  readonly window: string;
  readonly onWindow: (next: string) => void;
  readonly preview?: boolean;
}): ReactNode {
  const uncategorizedIn = BigInt(cashflow.uncategorizedInCents);
  const uncategorizedOut = BigInt(cashflow.uncategorizedOutCents);
  const surplus = BigInt(cashflow.surplusCents);

  const inflows: FlowNode[] = [
    ...cashflow.inflows.map((node) => ({
      key: node.key,
      name: node.name,
      amountCents: BigInt(node.amountCents),
      tone: 'income' as const,
    })),
    ...(uncategorizedIn > 0n
      ? [
          {
            key: '__uncat_in',
            name: 'Uncategorized',
            amountCents: uncategorizedIn,
            tone: 'uncategorized' as const,
          },
        ]
      : []),
  ];

  const outflows: FlowNode[] = [
    ...cashflow.outflows.map((node) => ({
      key: node.key,
      name: node.name,
      amountCents: BigInt(node.amountCents),
      tone: 'spending' as const,
    })),
    ...(uncategorizedOut > 0n
      ? [
          {
            key: '__uncat_out',
            name: 'Uncategorized',
            amountCents: uncategorizedOut,
            tone: 'uncategorized' as const,
          },
        ]
      : []),
    // Only when there is one. A negative surplus is money that came from
    // somewhere this window cannot see — savings, or last cycle — and drawing it
    // as a destination would say the household received it.
    ...(surplus > 0n
      ? [
          {
            key: '__surplus',
            name: 'Surplus',
            amountCents: surplus,
            tone: 'surplus' as const,
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {!preview && (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            size="sm"
            label="Cashflow period"
            value={window}
            options={CASHFLOW_WINDOWS}
            onChange={onWindow}
          />
          <span className="text-quiet text-muted">This chart has its own period.</span>
        </div>
      )}

      {cashflow.cycleMissing ? (
        <EmptyState>No cycle has been run yet.</EmptyState>
      ) : (
        <Sankey inflows={inflows} outflows={outflows} emptyMessage="Nothing came in yet." />
      )}

      {(uncategorizedIn > 0n || uncategorizedOut > 0n) && (
        <div className="flex items-center gap-2 border-t border-line pt-2">
          {/* Uncategorized is the one thing on this chart somebody can act on,
              and until it is worked every other figure is wrong by that much. */}
          <Link
            to="/transactions?uncategorized=true"
            className="text-quiet font-semibold text-accent hover:underline"
          >
            Categorize what is left →
          </Link>
        </div>
      )}
    </div>
  );
}

/** Every figure the band can hold. Longer than the band is wide, deliberately. */
const FIGURE_CATALOG = [
  'inflow',
  'spent',
  'left_to_spend',
  'uncategorized',
  'safe_per_day',
  'net_worth',
  'days_to_payday',
] as const;

/** How many the band draws. Four columns on a desktop, two on a phone. */
const FIGURE_SLOTS = 4;

/**
 * Which figures the band draws.
 *
 * Capped at four rather than scrolling: the band is a row across the top of a
 * dashboard, and a fifth figure would either shrink the other four below
 * readable or wrap into a second row that is no longer a band.
 */
function FigurePickerDialog({
  selected,
  onSave,
  onClose,
}: {
  readonly selected: readonly string[];
  readonly onSave: (keys: readonly string[]) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [chosen, setChosen] = useState<readonly string[]>(() => [...selected]);
  const full = chosen.length >= FIGURE_SLOTS;

  return (
    <Modal
      label="Choose which figures show"
      title="Which figures show"
      description={`Pick up to ${FIGURE_SLOTS}. They are drawn in the order you choose them.`}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <span className="text-quiet text-muted">
            {chosen.length} of {FIGURE_SLOTS} chosen
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => onSave(chosen)}>
              Save
            </Button>
          </span>
        </div>
      }
    >
      <ul className="flex list-none flex-col gap-1 p-0">
        {FIGURE_CATALOG.map((key) => {
          const on = chosen.includes(key);
          return (
            <li key={key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-base text-ink">
                {FIGURE_COPY[key]?.label ?? key}
              </span>
              {/* A full band disables the unchosen rather than hiding them, so
                  the cap is visible as a state rather than as options that
                  vanished. */}
              <Toggle
                checked={on}
                disabled={!on && full}
                onChange={(next) =>
                  setChosen((current) =>
                    next ? [...current, key] : current.filter((entry) => entry !== key),
                  )
                }
                label={`Show ${FIGURE_COPY[key]?.label ?? key}`}
              />
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** What each figure is called, and how it is read. */
const FIGURE_COPY: Record<string, { readonly label: string; readonly note?: string }> = {
  inflow: { label: 'Inflow' },
  spent: { label: 'Spent' },
  left_to_spend: { label: 'Left to spend' },
  uncategorized: { label: 'Uncategorized' },
  safe_per_day: { label: 'Safe per day' },
  net_worth: { label: 'Net worth' },
  days_to_payday: { label: 'Days to payday' },
};

/**
 * The band of figures across the top.
 *
 * One tile drawing up to four numbers rather than four tiles: a row holds two,
 * so four separate tiles would take two full rows and fill the first screen
 * before a chart appeared.
 *
 * A figure with no answer draws an em-dash rather than a zero. `Safe per day`
 * has none until a payday anchor is set, and a confident $0.00 would be a
 * different and wrong claim.
 */
function FiguresTile({
  figures,
  onChoose,
  preview = false,
}: {
  readonly figures: NonNullable<OverviewDataDto['figures']>;
  readonly onChoose: () => void;
  readonly preview?: boolean;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {figures.map((figure) => {
          const copy = FIGURE_COPY[figure.key] ?? { label: figure.key };
          const value =
            figure.count !== null
              ? String(figure.count)
              : figure.valueCents === null
                ? '—'
                : formatCents(BigInt(figure.valueCents));
          const negative = figure.valueCents !== null && BigInt(figure.valueCents) < 0n;

          return (
            <div key={figure.key} className="flex flex-col gap-1">
              <span className="text-micro font-semibold tracking-[0.07em] text-muted uppercase">
                {copy.label}
              </span>
              <span
                className={`money text-figure font-bold ${negative ? 'text-negative' : 'text-ink'}`}
              >
                {value}
              </span>
            </div>
          );
        })}
      </div>
      {!preview && (
        <button type="button" className="linkish self-start" onClick={onChoose}>
          Choose which figures show →
        </button>
      )}
    </div>
  );
}

/**
 * Which body a tile draws.
 *
 * A tile whose key is absent from the payload draws nothing at all, which is not
 * the same as a tile with nothing in it — the server keeps those apart
 * deliberately and this is the place that would otherwise collapse them.
 */
function TileBody({
  tileKey,
  data,
  budget,
  chosen,
  onChoose,
  cashflowWindow,
  onCashflowWindow,
  onChooseFigures,
  preview = false,
}: {
  readonly tileKey: string;
  readonly data: OverviewDataDto | undefined;
  readonly budget?: BudgetViewDto | undefined;
  readonly chosen?: readonly string[];
  readonly onChoose?: () => void;
  readonly cashflowWindow?: string;
  readonly onCashflowWindow?: (next: string) => void;
  readonly onChooseFigures?: () => void;
  /**
   * A picture of the tile, not the tile.
   *
   * Previews build **no interactive elements**. Marking them
   * `pointer-events-none` and `aria-hidden` stops them being used and does
   * nothing about the markup: a `<button>` inside a `<button>` is invalid HTML,
   * and the parser hoists the inner one out of its ancestor, which tears apart
   * the structure around it. That is what a segmented control inside the
   * picker's card was doing to the whole page.
   */
  readonly preview?: boolean;
}): ReactNode {
  // The delegations tile reads the budget rather than this page's payload, so
  // it draws before — and without — anything the overview endpoint computes.
  if (tileKey === 'delegations') {
    return (
      <DelegationsTile
        budget={budget}
        chosen={chosen ?? []}
        onChoose={onChoose ?? (() => undefined)}
      />
    );
  }

  if (!data) return null;

  switch (tileKey) {
    case 'spending_by_grouping':
      return data.spending_by_grouping ? (
        <SpendingTile spending={data.spending_by_grouping} />
      ) : null;
    case 'spending_by_delegation':
      return data.spending_by_delegation ? (
        <SpendingTile spending={data.spending_by_delegation} />
      ) : null;
    case 'asset_debt_composition':
      return data.asset_debt_composition ? (
        <CompositionTile composition={data.asset_debt_composition} />
      ) : null;
    case 'utilities_vs_delegated':
      return data.utilities_vs_delegated ? (
        <UtilitiesTile utilities={data.utilities_vs_delegated} />
      ) : null;
    case 'delegation_movers':
      return data.delegation_movers ? <MoversTile movers={data.delegation_movers} /> : null;
    case 'net_worth_over_time':
    case 'assets_vs_debts':
    case 'identity_drift':
      return data.aggregate ? <AggregateTile aggregate={data.aggregate} tileKey={tileKey} /> : null;
    case 'net_worth_composition':
    case 'bitcoin_value_over_time':
      return data.composition ? (
        <CompositionSeriesTile composition={data.composition} tileKey={tileKey} />
      ) : null;
    case 'home_equity_over_time':
      return data.home_equity_over_time ? <EquityTile equity={data.home_equity_over_time} /> : null;
    case 'debt_trajectory':
      return data.debt_trajectory ? <TrajectoryTile trajectory={data.debt_trajectory} /> : null;
    case 'delegations_negative':
      return data.delegations_negative ? <NegativeTile lines={data.delegations_negative} /> : null;
    case 'cycle_surplus':
    case 'income_vs_spending':
      return data.cycles ? <CycleTile cycles={data.cycles} tileKey={tileKey} /> : null;
    case 'change_per_cycle':
      return data.change_per_cycle ? <ChangePerCycleTile cycles={data.change_per_cycle} /> : null;
    case 'thirty_day_momentum':
      return data.thirty_day_momentum ? (
        <TimeSeriesChart
          points={toPoints(data.thirty_day_momentum.points, ['netWorthCents'])}
          series={[{ key: 'netWorthCents', name: 'Change over 30 days' }]}
          includeZero
          emptyMessage={NO_HISTORY}
          label="Rolling thirty-day change in net worth"
        />
      ) : null;
    case 'delegation_burn_rate':
      return data.delegation_burn_rate ? <BurnRateTile burn={data.delegation_burn_rate} /> : null;
    case 'figures':
      return data.figures ? (
        <FiguresTile
          figures={data.figures}
          onChoose={onChooseFigures ?? (() => undefined)}
          preview={preview}
        />
      ) : null;
    case 'cashflow':
      return data.cashflow ? (
        <CashflowTile
          cashflow={data.cashflow}
          window={cashflowWindow ?? 'ytd'}
          onWindow={onCashflowWindow ?? (() => undefined)}
          preview={preview}
        />
      ) : null;
    case 'uncategorized_backlog':
      return data.uncategorized_backlog ? (
        <BacklogTile backlog={data.uncategorized_backlog} />
      ) : null;
    default:
      return null;
  }
}

export function Overview(): ReactNode {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const raw = params.get('window') ?? 'cycle';
  const window: WindowValue = isWindow(raw) ? raw : 'cycle';

  const layout = useQuery({
    queryKey: ['overview', 'layout'],
    queryFn: () => overviewApi.layout(),
  });

  const data = useQuery({
    queryKey: ['overview', 'data', window],
    queryFn: () => overviewApi.data(window),
  });

  const arranging = params.get('arrange') === 'true';

  /*
   * What is being dragged, and where a drop would land.
   *
   * Kept in state rather than read from the event: `dataTransfer` is empty
   * during `dragover` in every browser, and which edge the drop lands on has to
   * be decided while the pointer is still moving. The Budget page's account
   * reordering learned this first.
   */
  /*
   * Dragging is available on the page itself, not only inside Arrange.
   *
   * Pointer devices only: HTML5 drag fires no events under a thumb, and a phone
   * stacks every tile full width anyway, so there are no rows there to
   * rearrange. The buttons inside Arrange remain the route that always works.
   */
  const pointer = useMediaQuery('(hover: hover)');

  /** Which tile's picker is open, by key. Null is closed. */
  const [picking, setPicking] = useState<string | null>(null);

  /*
   * The panel: which tab, and whether it is docked open.
   *
   * Collapse is per device, like the sidebar's, because it describes the screen
   * somebody is looking at rather than the household's budget. On a phone the
   * panel is not docked at all, so the state is unused there.
   */
  /** Whether the figures band's own picker is open. */
  const [pickingFigures, setPickingFigures] = useState(false);

  const [tab, setTab] = useState<PanelTab>('delegations');
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof globalThis.window === 'undefined') return false;
    try {
      return globalThis.window.localStorage.getItem(PANEL_KEY) === 'true';
    } catch {
      // A private window, or site data blocked. A missing preference is not an
      // error; it means the default.
      return false;
    }
  });

  function setPanelCollapsed(next: boolean): void {
    setCollapsed(next);
    try {
      globalThis.window.localStorage.setItem(PANEL_KEY, String(next));
    } catch {
      // Nothing to do: the panel still collapses for this session.
    }
  }

  /*
   * On a phone the panel's tabs are promoted onto the page and Overview becomes
   * the fourth. There is no room to dock 398px beside anything at 390px wide,
   * and the answer she opens the app for should not be behind a button.
   */
  const [phoneView, setPhoneView] = useState<'overview' | PanelTab>('overview');

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; side: 'left' | 'right' } | null>(null);

  /** Every tile's figures, fetched only while the picker is open. */
  const preview = useQuery({
    queryKey: ['overview', 'preview', window],
    queryFn: () => overviewApi.preview(window),
    enabled: arranging,
  });

  const tiles = useMemo(() => layout.data?.tiles ?? [], [layout.data]);

  /**
   * The budget itself, for the Delegations tile and its picker.
   *
   * The same query key the Budget page uses, so the two share one cache entry
   * and one answer — which is what makes "a 1:1 mirror" a property of the data
   * rather than a claim about two orderings.
   *
   * Fetched only when a Delegations tile is actually on the page: this is the
   * one tile whose data does not come from `/api/overview`, and asking for the
   * whole budget on a page that does not show it would be the waste that
   * endpoint exists to stop.
   */
  const wantsBudget = tiles.some((tile) => tile.key === 'delegations');
  const budget = useQuery({
    queryKey: ['budget'],
    queryFn: () => budgetApi.view(),
    enabled: wantsBudget || picking !== null,
  });

  const save = useMutation({
    /*
     * A refused layout comes back as a 200 with `ok: false`, so it has to be
     * turned into a rejection here or it would be indistinguishable from
     * success: the optimistic arrangement would stay on screen, the server
     * would hold the old one, and the two would only disagree after a reload.
     * A thing that fails quietly is worse than one that does not run at all.
     */
    mutationFn: async (next: readonly OverviewTileDto[]) => {
      const result = await overviewApi.saveLayout(next);
      if (!result.ok) throw new Error('layout_refused');
      return result;
    },
    onMutate: async (next) => {
      // Rearranging moves rows, never money, so the cache leads and the request
      // follows. The previous value is kept so a failure can put it back.
      await queryClient.cancelQueries({ queryKey: ['overview', 'layout'] });
      const previous = queryClient.getQueryData<OverviewLayoutDto>(['overview', 'layout']);
      if (previous) {
        queryClient.setQueryData<OverviewLayoutDto>(['overview', 'layout'], {
          ...previous,
          tiles: next,
        });
      }
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['overview', 'layout'], context.previous);
      }
    },
    /*
     * The figures are refetched only when the *set* of tiles changed.
     *
     * Nothing on this page can differ because a tile moved or changed width, so
     * reordering invalidates nothing. Adding or removing one does change it,
     * because `GET /api/overview` reads the caller's stored layout to decide
     * what to compute — which is the whole point of that endpoint and also its
     * one sharp edge: the refetch has to happen **after** the layout write has
     * landed. Firing it alongside the mutation reads the old layout and comes
     * back without the tile that was just added, which renders as a tile that
     * is on the page and empty. Found exactly that way.
     */
    onSuccess: (_result, next, context) => {
      /*
       * Two things change what the server would compute: which tiles are on the
       * page, and what a tile has been told about itself — the cashflow chart's
       * period is stored in its configuration, not in the URL.
       *
       * Reordering and resizing change neither, so those invalidate nothing.
       * And this has to run **after** the write lands: `GET /api/overview` reads
       * the stored layout to decide what to compute, so firing it alongside the
       * mutation reads the old one. That was found once already, when adding a
       * tile drew it empty; it recurred here, where changing the period silently
       * kept the old one until a reload.
       */
      const signature = (tiles: readonly OverviewTileDto[]): string =>
        tiles
          .map((tile) => `${tile.key}:${JSON.stringify(tile.config ?? null)}`)
          .sort()
          .join('\u0000');

      if (signature(context?.previous?.tiles ?? []) !== signature(next)) {
        void queryClient.invalidateQueries({ queryKey: ['overview', 'data'] });
      }
    },
  });

  function setWindow(next: WindowValue): void {
    const updated = new URLSearchParams(params);
    updated.set('window', next);
    setParams(updated, { replace: true });
  }

  function setArranging(next: boolean): void {
    const updated = new URLSearchParams(params);
    if (next) updated.set('arrange', 'true');
    else updated.delete('arrange');
    setParams(updated, { replace: true });
  }

  /** The arrangement as rows, which is what every edit below works on. */
  /*
   * The grid's rows. The panel's own layout row is filtered out first: it holds
   * the chosen delegations and is drawn by the panel, so leaving it in would put
   * an empty tile in the grid beside the panel already showing its contents.
   */
  const rows = useMemo(
    () => groupIntoRows(tiles.filter((tile) => tile.key !== 'delegations')),
    [tiles],
  );

  /** Writes rows back as tiles, renumbering so a gap left by a row closes. */
  function saveRows(next: readonly (readonly OverviewTileDto[])[]): void {
    save.mutate(flattenRows(next).map(({ row, position, tile }) => ({ ...tile, row, position })));
  }

  function locate(key: string): { row: number; index: number } | null {
    for (const [row, group] of rows.entries()) {
      const index = group.findIndex((tile) => tile.key === key);
      if (index !== -1) return { row, index };
    }
    return null;
  }

  /** Lifts a tile out, leaving its row possibly empty for `flattenRows` to drop. */
  function without(key: string): OverviewTileDto[][] {
    return rows.map((group) => group.filter((tile) => tile.key !== key));
  }

  /**
   * Moves a tile one place along the reading order.
   *
   * Within its row first. At the row's edge it steps **out** onto a row of its
   * own rather than merging into the neighbouring one — merging is what `⤒`
   * is for, and a reorder button that silently changed two tiles' widths would
   * be doing something nobody pressed it for.
   *
   * The route that always works: dragging is not reachable by keyboard and does
   * nothing under a thumb, so it is the fast way rather than the only one.
   */
  function move(key: string, step: -1 | 1): void {
    const at = locate(key);
    if (!at) return;

    const group = rows[at.row]!;
    const target = at.index + step;

    if (target >= 0 && target < group.length) {
      const next = rows.map((entry) => [...entry]);
      const moving = next[at.row]!;
      const [moved] = moving.splice(at.index, 1);
      moving.splice(target, 0, moved!);
      saveRows(next);
      return;
    }

    /*
     * Off the end of its row. Only the source row can be emptied by the removal,
     * and only when it held this tile alone — which is what decides where the
     * new row lands once the empty one is gone.
     */
    const alone = group.length === 1;
    const compact = without(key).filter((entry) => entry.length > 0);
    const insertAt = alone ? at.row + step : step < 0 ? at.row : at.row + 1;
    if (insertAt < 0 || insertAt > compact.length) return;

    compact.splice(insertAt, 0, [group[at.index]!]);
    saveRows(compact);
  }

  /** Gives a tile a row of its own, directly below the one it was sharing. */
  function split(key: string): void {
    const at = locate(key);
    if (!at || rows[at.row]!.length === 1) return;
    const next = without(key);
    next.splice(at.row + 1, 0, [rows[at.row]![at.index]!]);
    saveRows(next);
  }

  /** Moves a tile up into the row above, if that row has room for it. */
  function join(key: string): void {
    const at = locate(key);
    if (!at || at.row === 0) return;
    if ((rows[at.row - 1]?.length ?? 0) >= MAX_TILES_PER_ROW) return;
    const tile = rows[at.row]![at.index]!;
    const next = without(key);
    next[at.row - 1] = [...next[at.row - 1]!, tile];
    saveRows(next);
  }

  function remove(key: string): void {
    saveRows(without(key));
  }

  function add(key: string): void {
    // A new tile takes a row of its own at the foot. The data refetch is in the
    // mutation's `onSuccess`, not here — see the comment on it.
    save.mutate([...tiles, { key, row: rows.length, position: 0, display: null, config: null }]);
  }

  /**
   * Dropping one tile beside another puts them in the same row, and the row
   * divides itself between them — two halves, then thirds, then quarters.
   *
   * The pointer's half of the target decides which side it lands on, the same
   * rule the Budget page's account reordering follows: dropping always-before
   * leaves no gesture meaning "after this one", so the last place in a row
   * cannot be reached at all.
   */
  function drop(targetKey: string, side: 'left' | 'right'): void {
    if (dragging === null || dragging === targetKey) return;
    const target = locate(targetKey);
    const source = locate(dragging);
    if (!target || !source) return;

    const tile = rows[source.row]![source.index]!;
    const next = without(dragging);
    const destination = next[target.row]!;

    if (destination.length >= MAX_TILES_PER_ROW) return;

    const at = destination.findIndex((entry) => entry.key === targetKey);
    next[target.row] = [
      ...destination.slice(0, side === 'left' ? at : at + 1),
      tile,
      ...destination.slice(side === 'left' ? at : at + 1),
    ];
    saveRows(next);
  }

  /** The delegation ids a tile has been told to show. */
  function chosenFor(tile: OverviewTileDto): readonly string[] {
    const config = tile.config;
    if (config === null || typeof config !== 'object') return [];
    const ids = (config as { delegationIds?: unknown }).delegationIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  }

  /** The cashflow tile's own period, stored on the tile rather than in the URL. */
  function setCashflowWindow(next: string): void {
    save.mutate(
      tiles.map((tile) => (tile.key === 'cashflow' ? { ...tile, config: { window: next } } : tile)),
    );
    // The refetch is in the mutation's `onSuccess`, which compares
    // configurations as well as keys — see the comment there.
  }

  /** The figures band's own selection. */
  function saveFigures(keys: readonly string[]): void {
    save.mutate(
      tiles.map((tile) =>
        tile.key === 'figures' ? { ...tile, config: { keys: [...keys] } } : tile,
      ),
    );
    setPickingFigures(false);
  }

  /** The panel's own selection, creating its layout row the first time. */
  function savePanelChoice(delegationIds: readonly string[]): void {
    const config = { delegationIds: [...delegationIds] };
    const next = panelTile
      ? tiles.map((tile) => (tile.key === 'delegations' ? { ...tile, config } : tile))
      : [
          ...tiles,
          {
            key: 'delegations',
            // Off the end of the grid, and never drawn there anyway.
            row: rows.length,
            position: 0,
            display: null,
            config,
          },
        ];
    save.mutate(next);
    setPicking(null);
  }

  function saveChoice(key: string, delegationIds: readonly string[]): void {
    save.mutate(
      tiles.map((tile) =>
        tile.key === key ? { ...tile, config: { delegationIds: [...delegationIds] } } : tile,
      ),
    );
    setPicking(null);
  }

  /*
   * The panel's chosen lines are stored on the `delegations` layout row.
   *
   * That row is never drawn in the grid — the panel draws it instead — but it
   * stays in the layout because it is where the selection lives, and a
   * selection needs somewhere to be whether or not anything renders it. The
   * grid filters it out below and the picker creates it on first save, so the
   * panel works on a page that has never held a tile.
   */
  const panelTile = tiles.find((tile) => tile.key === 'delegations');

  const available = (layout.data?.catalog ?? [])
    // The panel is not a tile and must not be offered as one.
    .filter((key) => key !== 'delegations')
    .filter((key) => !tiles.some((tile) => tile.key === key));
  return (
    <>
      <PageHeader
        title="Overview"
        /*
         * The subtitle states a fact the body does not already state. It said
         * "No tiles yet." while the empty state below said exactly the same
         * words — the text budget broken in the plainest way, and visible in the
         * first screenshot of the page in real use.
         */
        subtitle={
          tiles.length === 0
            ? undefined
            : `${tiles.length} ${tiles.length === 1 ? 'tile' : 'tiles'}.`
        }
        actions={
          <>
            <SegmentedControl
              label="Time window"
              value={window}
              options={WINDOWS}
              onChange={setWindow}
            />
            <Button
              variant={arranging ? 'primary' : 'default'}
              onClick={() => setArranging(!arranging)}
              aria-pressed={arranging}
            >
              {arranging ? 'Done' : 'Arrange'}
            </Button>
          </>
        }
      />

      {save.isError && (
        <div className="mb-4">
          <Alert tone="danger">That arrangement could not be saved. Nothing was changed.</Alert>
        </div>
      )}

      {arranging && available.length > 0 && (
        <section className="mb-6 flex flex-col gap-4">
          <h2 className="text-section font-semibold text-ink">Add a tile</h2>
          {/*
            Each one drawn with the household's own figures rather than named in
            words. A picker listing six titles asks people to choose between
            things they cannot see; this shows what they would be adding. The
            data comes from `/api/overview/preview`, which is the one deliberate
            exception to this endpoint's "only what you have" rule.
          */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {available.map((key) => (
              <div
                key={key}
                className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-4 text-left"
              >
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-section font-semibold text-ink">
                    {TILE_COPY[key]?.title ?? key}
                  </span>
                  {/* The action is its own control rather than the whole card.
                      A card that is a button cannot contain one, and some tiles
                      draw controls of their own. */}
                  <Button
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => add(key)}
                    aria-label={`Add ${TILE_COPY[key]?.title ?? key}`}
                  >
                    Add
                  </Button>
                </span>
                {/* Not interactive, and not reachable: it is a picture of the
                    tile inside a button, and a control inside a control is a
                    target nobody can aim at. */}
                <span aria-hidden="true" className="pointer-events-none block">
                  {preview.isPending ? (
                    <span className="block text-quiet text-muted">Loading…</span>
                  ) : (
                    <TileBody tileKey={key} data={preview.data} budget={budget.data} preview />
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {pickingFigures && (
        <FigurePickerDialog
          /*
           * What is actually on screen, not what the tile's configuration says.
           *
           * A band that has never been configured draws the server's defaults,
           * so reading the stored config here opened the dialog empty beside a
           * tile showing four figures — the picker and the thing it picks for
           * disagreeing about the current state. The payload already names the
           * keys it drew; that is the one answer.
           */
          selected={(data.data?.figures ?? []).map((figure) => figure.key)}
          onSave={saveFigures}
          onClose={() => setPickingFigures(false)}
        />
      )}

      {picking !== null && (
        <DelegationPickerDialog
          budget={budget.data}
          selected={panelTile ? chosenFor(panelTile) : []}
          onSave={(ids) =>
            picking === 'delegations' ? savePanelChoice(ids) : saveChoice(picking, ids)
          }
          onClose={() => setPicking(null)}
        />
      )}

      {/* The phone's four destinations. Below `lg` only: on a pointer the panel
          is docked beside the tiles and none of this is drawn. */}
      <div className="mb-4 lg:hidden">
        <SegmentedControl
          label="View"
          value={phoneView}
          options={PHONE_VIEWS}
          onChange={setPhoneView}
        />
      </div>

      {phoneView !== 'overview' && (
        <div className="lg:hidden">
          <OverviewPanel
            variant="inline"
            tab={phoneView}
            onTab={setPhoneView}
            data={data.data}
            onChoose={() => setPicking('delegations')}
          />
        </div>
      )}

      <div
        className={`${phoneView === 'overview' ? '' : 'hidden lg:grid'} grid gap-6 lg:grid-cols-[minmax(0,1fr)_398px]`}
      >
        <div className="min-w-0">
          {layout.isPending || data.isPending ? null : tiles.length === 0 ? (
            <EmptyState>No tiles yet.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {rows.map((group) =>
                group.map((tile) => (
                  <TileShell
                    key={tile.key}
                    tile={tile}
                    columns={columnsForRow(group.length)}
                    rowSize={group.length}
                    arranging={arranging}
                    draggable={pointer}
                    onMove={(step) => move(tile.key, step)}
                    onRemove={() => remove(tile.key)}
                    onSplit={() => split(tile.key)}
                    onJoin={() => join(tile.key)}
                    drag={{
                      onDragStart: () => setDragging(tile.key),
                      onDragOver: (event) => {
                        if (dragging === null || dragging === tile.key) return;
                        // Without this the browser refuses the drop outright.
                        event.preventDefault();
                        const box = event.currentTarget.getBoundingClientRect();
                        const side = event.clientX < box.left + box.width / 2 ? 'left' : 'right';
                        setOver({ key: tile.key, side });
                      },
                      onDrop: (event) => {
                        event.preventDefault();
                        const side = over?.key === tile.key ? over.side : 'right';
                        drop(tile.key, side);
                        setDragging(null);
                        setOver(null);
                      },
                      over: over?.key === tile.key ? over.side : null,
                    }}
                  >
                    <TileBody
                      tileKey={tile.key}
                      data={data.data}
                      budget={budget.data}
                      chosen={chosenFor(tile)}
                      onChoose={() => setPicking(tile.key)}
                      cashflowWindow={data.data?.cashflowWindow ?? 'ytd'}
                      onCashflowWindow={(next) => setCashflowWindow(next)}
                      onChooseFigures={() => setPickingFigures(true)}
                    />
                  </TileShell>
                )),
              )}
            </div>
          )}
        </div>

        {/* Docked, and only on a pointer. Collapsed it is a single control that
            gives the width back rather than a sliver of panel. */}
        <div className="hidden lg:block">
          {collapsed ? (
            <Button onClick={() => setPanelCollapsed(false)} aria-label="Open the budget panel">
              Budget
            </Button>
          ) : (
            <div className="sticky top-0 max-h-[calc(100vh-96px)]">
              <OverviewPanel
                variant="docked"
                tab={tab}
                onTab={setTab}
                data={data.data}
                onChoose={() => setPicking('delegations')}
                onCollapse={() => setPanelCollapsed(true)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
