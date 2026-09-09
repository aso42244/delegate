import {
  columnsForRow,
  flattenRows,
  formatCents,
  groupIntoRows,
  MAX_TILES_PER_ROW,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMediaQuery } from '../useMediaQuery.js';
import { useIsDemo } from '../useDemo.js';
import {
  overviewApi,
  type BalanceHistoryDto,
  type OverviewDataDto,
  type PickableDto,
  type SeriesPointDto,
  type OverviewLayoutDto,
  type OverviewTileDto,
} from '../api/overview.js';
import { EmptyState, PageHeader, SegmentedControl } from '../components/layout.jsx';
import { budgetApi, type BudgetViewDto } from '../api/budget.js';
import { transactionsApi } from '../api/transactions.js';
import { recurringApi } from '../api/recurring.js';
import { DelegationPickerDialog } from '../components/DelegationPickerDialog.jsx';
import {
  BillAttentionList,
  BillsThisCycle,
  OutflowBand,
  OutstandingChecks,
  PaceChart,
  UpcomingList,
  UtilitiesToAdjust,
  UtilityTrends,
} from '../components/OverviewCharts.jsx';
import { OverviewPanel, type PanelTab } from '../components/OverviewPanel.jsx';
import { Sankey, type FlowNode } from '../components/Sankey.jsx';
import { CompositionBars, RankedBars, type RankedRow } from '../components/RankedBars.jsx';
import { TimeSeriesChart, type TimePoint } from '../components/TimeSeries.jsx';
import { Alert, Button, Modal, SelectField, Toggle } from '../components/ui.jsx';

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

/**
 * The cashflow chart's own options, defaulting to year-to-date.
 *
 * No "All". On a household with years of imported history it drew a chart whose
 * scale nothing else on the page shares, and the question this tile answers —
 * where is the money going — is not one anybody asks of all time at once.
 */
const CASHFLOW_WINDOWS = [
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'ytd', label: 'YTD' },
  { value: '1yr', label: '1Y' },
] as const;

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
  utilities_vs_delegated: { title: 'Utilities: Spent vs. Delegated' },
  delegation_movers: { title: 'What moved' },
  net_worth_over_time: { title: 'Net worth' },
  assets_vs_debts: { title: 'Assets against debts' },
  identity_drift: { title: 'Identity drift' },
  net_worth_composition: { title: 'What net worth is made of' },
  bitcoin_value_over_time: { title: 'Bitcoin over time' },
  home_equity_over_time: { title: 'Home equity' },
  debt_trajectory: { title: 'Debt trajectory' },
  figures: { title: 'Figures' },
  /* Each row names its own month, so the header does not have to — and "This
     month" became wrong the moment there were three of them. */
  daily_outflow: { title: 'Daily outflow' },
  income_vs_spending_pace: { title: 'In against out', description: 'Running totals' },
  allocation: { title: 'Allocation' },
  upcoming_bills: { title: 'Coming up', description: 'Next 14 days' },
  bills_attention: { title: 'Needs a look' },
  bills_this_cycle: { title: 'Recurring this cycle' },
  utilities_trend: { title: 'Which way they’re going', description: '12 months' },
  utilities_adjust: { title: 'Worth adjusting' },
  account_balance_history: { title: 'Account balance' },
  delegation_balance_history: { title: 'Delegation balance' },
  /* No description. The chart says where the money went by being a picture of
     where the money went, and the header's right-hand side is the period. */
  cashflow: { title: 'Cashflow' },
  delegations: { title: 'Delegations' },
  delegations_negative: { title: 'Over-spent lines' },
  cycle_surplus: { title: 'This cycle' },
  income_vs_spending: { title: 'Income against spending' },
  change_per_cycle: { title: 'Change per cycle' },
  thirty_day_momentum: { title: '30-day momentum' },
  delegation_burn_rate: { title: 'What each line burns' },
  outstanding_checks: { title: 'Outstanding checks' },
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
/*
 * Written out rather than interpolated, because Tailwind reads the source for
 * class names and `lg:col-span-${n}` is a string it never sees.
 */
/*
 * How wide a tile is, at each width the page has.
 *
 * Three steps down rather than one: a row of three becomes two at `md` and one
 * below it, and a row of two becomes one. A tile that keeps a third of the width
 * on a laptop is 300px of ranked bars with the names truncated to nothing, which
 * is the floor the row cap is derived from in the first place.
 *
 * Written out rather than interpolated, because Tailwind reads the source for
 * class names and `lg:col-span-${n}` is a string it never sees.
 */
const COLUMN_CLASS: Record<number, string> = {
  12: 'lg:col-span-12',
  6: 'md:col-span-6 lg:col-span-6',
  4: 'md:col-span-6 lg:col-span-4',
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
  controls,
  height,
  onResize,
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
    readonly over: DropEdge | null;
  };
  /** This tile's own control, drawn on the right of its header. */
  readonly controls?: ReactNode;
  /** The height of this tile's row, or null for whatever its content wants. */
  readonly height?: number | null;
  /** Live while dragging, then once more to commit. Absent where a row cannot
   *  be resized — the sidebar, where every tile has its own row already. */
  readonly onResize?: ((px: number, done: boolean) => void) | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const copy = TILE_COPY[tile.key] ?? { title: tile.key };

  /*
   * A drag starts on the grip and nowhere else.
   *
   * The whole card used to be the handle: a grab cursor over every figure in it,
   * and a drag begun by any stray press — on a chart, on a label somebody meant
   * to select. The grip is the affordance, so it should be the only thing that
   * starts a drag.
   *
   * `draggable` stays on the **section** rather than moving to the grip, because
   * the browser's drag image is the element carrying the attribute: the grip
   * alone drags a ⠿ glyph across the page, while the section drags a picture of
   * the tile, which is what is actually being moved. What gates it is where the
   * press landed, recorded on the way down and read at `dragstart`.
   *
   * A ref rather than state, and recomputed on **every** press inside the tile:
   * a state update would not necessarily have flushed before the browser decided
   * whether the element was draggable, and a flag only ever set true would leave
   * the tile armed after a press on the grip that went nowhere.
   */
  const fromGrip = useRef(false);

  return (
    <section
      className={`group relative col-span-1 flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-canvas p-4 ${
        COLUMN_CLASS[columns] ?? 'lg:col-span-12'
      }`}
      // A fixed height turns the body into the thing that scrolls, so a tile
      // dragged shorter than its content stays a tile rather than a clipped one.
      style={height === null || height === undefined ? undefined : { height }}
      draggable={draggable}
      onPointerDown={(event) => {
        fromGrip.current = (event.target as HTMLElement).closest('[data-grip]') !== null;
      }}
      onDragStart={(event) => {
        if (!fromGrip.current) {
          event.preventDefault();
          return;
        }
        drag.onDragStart();
      }}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      data-tile={tile.key}
    >
      {/* The edge a drop would land on. Drawn on the tile rather than between
          tiles, because a gap is a target nobody can hit at 24px. */}
      {/*
        Where the drop would land, drawn on the edge it would land on.
        
        Four edges rather than two: left and right join this tile's row, top and
        bottom make a new row above or below it. Without the horizontal pair
        there was no gesture that meant "on its own line" — every drop joined a
        row, and a tile could only be given its own by pressing ⤓ afterwards.
      */}
      {drag.over !== null && (
        <span
          aria-hidden="true"
          className={
            drag.over === 'left'
              ? 'absolute inset-y-0 -left-1 w-1 rounded bg-accent'
              : drag.over === 'right'
                ? 'absolute inset-y-0 -right-1 w-1 rounded bg-accent'
                : drag.over === 'above'
                  ? 'absolute inset-x-0 -top-1 h-1 rounded bg-accent'
                  : 'absolute inset-x-0 -bottom-1 h-1 rounded bg-accent'
          }
        />
      )}

      {/*
        Says the tile can be pulled. Revealed on hover rather than drawn
        permanently, because it is an affordance for an occasional act on a page
        of figures.

        **Out of the flow, in the tile's own padding.** It used to sit before the
        heading as an `opacity-0` box that still took its width, which indented
        every title by a glyph and a gap — so no heading lined up with the bars
        and figures beneath it. Taking it out of the flow keeps the header from
        reflowing on hover *and* puts the title on the tile's left edge.
      */}
      {draggable && (
        <span
          aria-hidden="true"
          data-grip="true"
          className="absolute top-4 left-1 cursor-grab text-quiet text-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          ⠿
        </span>
      )}

      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="min-w-0 truncate text-section font-semibold text-ink">{copy.title}</h2>
        {copy.description !== undefined && (
          <p className="truncate text-quiet text-muted">{copy.description}</p>
        )}
        {/* A control that belongs to this tile rather than to the page: the
            cashflow period, on the header's right where a tile's own control is
            looked for. Hidden while arranging, which needs the same room. */}
        {controls !== undefined && !arranging && (
          <div className="ml-auto flex shrink-0 items-center gap-2">{controls}</div>
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
      {/*
        The body holds the tile's shape; whatever is inside it decides what gives.

        `min-h-0` because a flex item's minimum is its content, which would
        otherwise push the tile back to its natural height whatever the row was
        dragged to.

        `overflow-hidden` rather than `auto`, because a scrolling body and a
        scrolling list inside it are two scrollbars for one overflow — and the
        outer one takes the whole tile with it, so a short row clipped its donut
        halfway instead of shortening the legend beside it. A chart scales to the
        room it is given; a list scrolls in place.
      */}
      <div
        className={
          height === null || height === undefined
            ? 'flex min-h-0 flex-col'
            : 'flex min-h-0 flex-1 flex-col overflow-hidden'
        }
      >
        {children}
      </div>

      {/*
        The row's height, dragged from the bottom edge.

        On every tile in the row rather than on the row, because a row is not an
        element here — it is a col-span relationship inside one grid. Dragging
        any member resizes all of them, which is also the behaviour somebody
        expects: the edge under the pointer is the edge that moves.
      */}
      {onResize !== undefined && (
        <span
          role="separator"
          aria-label={`Height of the row holding ${copy.title}`}
          aria-orientation="horizontal"
          tabIndex={0}
          className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-ns-resize rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:bg-accent"
          onPointerDown={(event) => {
            event.preventDefault();
            const handle = event.currentTarget;
            const start = event.clientY;
            const from = handle.closest('section')?.getBoundingClientRect().height ?? 0;
            handle.setPointerCapture(event.pointerId);

            const move = (moved: PointerEvent): void =>
              onResize(Math.round(from + (moved.clientY - start)), false);
            const up = (ended: PointerEvent): void => {
              onResize(Math.round(from + (ended.clientY - start)), true);
              handle.removeEventListener('pointermove', move);
              handle.removeEventListener('pointerup', up);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
          }}
          /* Dragging is not reachable by keyboard, so the arrows are — 24px a
             press, which is a row height somebody can actually land on. */
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const box = event.currentTarget.closest('section')?.getBoundingClientRect();
            if (!box) return;
            onResize(Math.round(box.height + (event.key === 'ArrowDown' ? 24 : -24)), true);
          }}
        />
      )}
    </section>
  );
}

/**
 * Today, as a calendar day in the reader's own zone.
 *
 * `toISOString` gives the UTC day, which after 7pm in Chicago is already
 * tomorrow — and "today" would outline a cell for a day that has not happened.
 */
function localToday(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * What one day cost, opened from the outflow band.
 *
 * A read, not a working surface: the register is where a row is changed, and a
 * link goes there. This answers the question the band always provokes — the 3rd
 * cost $412, which $412 — without leaving the dashboard.
 *
 * The day is sent as a calendar day and bounded by the server in the household's
 * zone, so the list is exactly the rows that drew the cell. Computing the window
 * here would use the browser's zone, and an evening charge would go missing from
 * the day it is drawn on.
 */
function DayDialog({
  dayIso,
  onClose,
}: {
  readonly dayIso: string;
  readonly onClose: () => void;
}): ReactNode {
  const day = dayIso.slice(0, 10);
  const rows = useQuery({
    queryKey: ['transactions', 'day', day],
    /*
     * The same rows the cell was drawn from, and only those.
     *
     * `kind: 'normal'` drops income and confirmed transfers — a payroll deposit
     * is not a day's spending, and a card payment is money moving between two
     * accounts the household already owns. The band counts neither, so listing
     * them here put a $200 credit and a card payment in a list headed by what
     * went out, and the total underneath disagreed with both.
     */
    queryFn: () => transactionsApi.list({ day, kind: 'normal', limit: 100 }),
  });

  const [year, month, date] = day.split('-').map(Number);
  const title = new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // Money out. A refund landing the same day is a negative amount of spending
  // and nets off, which is what the cell above did with it too.
  const spending = (rows.data?.transactions ?? []).filter((row) => BigInt(row.amountCents) < 0n);
  const spent = spending.reduce((sum, row) => sum - BigInt(row.amountCents), 0n);

  return (
    <Modal
      label={`What was spent on ${title}`}
      title={title}
      onClose={onClose}
      width="xl"
      dismissible
    >
      {rows.isPending ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : spending.length === 0 ? (
        <EmptyState>Nothing went out that day.</EmptyState>
      ) : (
        <ul className="list-none border-t border-line p-0">
          {spending.map((row) => (
            <li key={row.id} className="row-cell flex items-center gap-3 border-b border-line">
              {/*
                Description and where it was filed on one row, not stacked.

                Two lines a transaction turned six charges into twelve rows of
                alternating weight, and the second line — an account and a
                delegation — is short. A row reads left to right: what it was,
                where it came from, where it went, how much.
              */}
              <span
                className="min-w-0 flex-[2] truncate text-quiet text-ink"
                title={row.description}
              >
                {row.description}
              </span>
              <span className="hidden min-w-0 flex-1 truncate text-micro text-muted sm:block">
                {row.account.name}
              </span>
              <span className="hidden min-w-0 flex-1 truncate text-micro text-muted sm:block">
                {row.allocations.length > 0
                  ? row.allocations.map((entry) => entry.delegation.name).join(', ')
                  : 'Uncategorized'}
                {row.pending && ' · Pending'}
              </span>
              <span className="money w-24 shrink-0 text-quiet font-semibold text-ink">
                {formatCents(-BigInt(row.amountCents))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!rows.isPending && (
        <div className="mt-3 flex items-center justify-between gap-2 text-quiet">
          <span className="font-semibold text-ink">
            <span className="money">{formatCents(spent)}</span> out
          </span>
          {/* The register, filtered to this day — the same calendar day, cut in
              the household's zone by the server, so the two lists agree. */}
          <Link to={`/transactions?day=${day}`} className="linkish">
            Open in the register →
          </Link>
        </div>
      )}
    </Modal>
  );
}

/**
 * Every bill, in the middle of the page.
 *
 * A dialog rather than a link away, because the tiles it opens from are a
 * glance: somebody reading "three bills need a look" wants the other twenty in
 * front of them, not a page change and a way back. Changing a bill — renaming
 * it, attaching a charge, dismissing it — is still Recurring's job, and the
 * footer goes there.
 */
function AllBillsDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const bills = useQuery({ queryKey: ['bills'], queryFn: () => recurringApi.list() });
  const rows = bills.data?.bills ?? [];

  return (
    <Modal label="Every recurring bill" title="All bills" onClose={onClose} width="lg" dismissible>
      {bills.isPending ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState>No bill has arrived three times yet.</EmptyState>
      ) : (
        <ul className="list-none border-t border-line p-0">
          {rows.map((bill) => (
            <li
              key={bill.key}
              className="row-cell flex items-center gap-3 border-b border-line"
              title={`${bill.name} · ${bill.cadence} · next ${shortDate(bill.expectedNextAt)}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-quiet text-ink">{bill.name}</span>
                <span className="block truncate text-micro text-muted">
                  {bill.cadence}
                  {bill.delegationName !== null && ` · ${bill.delegationName}`}
                </span>
              </span>
              <span className="w-20 shrink-0 text-right text-micro text-muted">
                {shortDate(bill.expectedNextAt)}
              </span>
              <span className="money w-20 shrink-0 text-right text-quiet font-semibold text-ink">
                {formatCents(BigInt(bill.typicalAmountCents))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Outside the list, because the way out belongs here whether or not there
          is anything to show — a household with no bills yet is exactly the one
          that might want to look at the page. */}
      {!bills.isPending && (
        <div className="mt-3 flex items-center justify-between gap-2 text-quiet">
          <span className="text-muted">
            {rows.length} {rows.length === 1 ? 'recurring bill' : 'recurring'}
          </span>
          <Link to="/recurring" className="linkish">
            Open Recurring →
          </Link>
        </div>
      )}
    </Modal>
  );
}

/** A bill's next date, read as a calendar date rather than an instant. */
function shortDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(year!, month! - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
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

  // Each row's share of what was spent in the window. The bars are scaled to the
  // largest row rather than to the total, so the bar compares a line with the
  // others and the percentage places it against everything.
  const total = spending.entries.reduce((sum, entry) => sum + BigInt(entry.spendCents), 0n);

  const rows: RankedRow[] = spending.entries.map((entry) => {
    const amount = BigInt(entry.spendCents);
    return {
      key: entry.key,
      name: entry.name,
      color: entry.color,
      valueCents: amount,
      ...(total > 0n ? { aside: share(amount, total) } : {}),
    };
  });

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
        <Link to="/transactions?uncategorized=true" className="linkish">
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
 *
 * The control sits in the tile's header rather than above the chart, which is
 * where a tile's own control is looked for — and it no longer carries a sentence
 * saying it has its own period. A control in the tile's corner says that by
 * being there.
 */
function CashflowTile({
  cashflow,
}: {
  readonly cashflow: NonNullable<OverviewDataDto['cashflow']>;
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
    // `h-full min-h-0` so a dragged row reaches the chart: without it the column
    // is as tall as its content and the Sankey never learns it has less room.
    <div className="flex h-full min-h-0 flex-col gap-4">
      {cashflow.cycleMissing ? (
        <EmptyState>No cycle has been run yet.</EmptyState>
      ) : (
        <Sankey inflows={inflows} outflows={outflows} emptyMessage="Nothing came in yet." />
      )}
    </div>
  );
}

/**
 * One account's or one delegation's balance over time.
 *
 * The two tiles that ask "which one". The answer lives in the tile's own
 * configuration, and until it is given the tile says so rather than picking on
 * somebody's behalf — a chart of an account nobody chose is a chart nobody can
 * trust at a glance.
 *
 * The picker offers only things that **have** history, so it can never point at
 * something that draws an empty box. On a household whose snapshots start at the
 * first night, a list of everything would make choosing wrong the default.
 */
function BalanceHistoryTile({
  history,
  options,
  selectedId,
  onSelect,
  label,
  emptyMessage,
  preview = false,
}: {
  readonly history: BalanceHistoryDto | undefined;
  readonly options: readonly PickableDto[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly label: string;
  readonly emptyMessage: string;
  readonly preview?: boolean;
}): ReactNode {
  if (options.length === 0) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {!preview && (
        <SelectField
          label={label}
          width="md"
          value={selectedId ?? ''}
          onChange={(next) => onSelect(next)}
        >
          {/* Present until something is chosen, and gone afterwards: an empty
              option that stays is one somebody can select back into nothing. */}
          {selectedId === null && <option value="">Choose one…</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </SelectField>
      )}

      {history === undefined ? (
        <p className="text-quiet text-muted">Nothing chosen yet.</p>
      ) : (
        <TimeSeriesChart
          points={toPoints(history.points, ['balanceCents'])}
          series={[{ key: 'balanceCents', name: history.name ?? 'Balance' }]}
          includeZero
          emptyMessage={NO_HISTORY}
          label={`${history.name ?? 'Balance'} over time`}
        />
      )}
    </div>
  );
}

/**
 * Said once, by the three tiles that cannot be drawn without a payday.
 *
 * A band of days measured from a guessed payday would be a picture of the wrong
 * fortnight, so these draw nothing at all rather than something plausible.
 */
function NeedsPayday(): ReactNode {
  return (
    <p className="text-quiet text-muted">
      Set your next payday on Settings → Budget to see this cycle.
    </p>
  );
}

/**
 * A share of a total, to the nearest whole percent.
 *
 * Integer arithmetic on cents throughout, and rounded rather than truncated so a
 * slice at 7.6% does not read as 7. Anything under half a percent says `<1%`,
 * because `0%` beside a real amount reads as a bug.
 */
function share(amountCents: bigint, total: bigint): string {
  const tenths = Number((amountCents * 1000n) / total);
  return tenths < 5 ? '<1%' : `${Math.round(tenths / 10)}%`;
}

/**
 * Where the money is, as ranked bars.
 *
 * It was a donut with a legend beside it. A donut answers "what share" and
 * nothing else — the legend beside it was already carrying every figure anybody
 * read, in a column half the tile wide, and at a third of the page's width
 * neither half had room. The same rows as bars are the shape every other tile on
 * this page uses, they sort largest first without a colour key, and they read at
 * the density the budget panel reads at.
 *
 * The share is kept as a small figure beside each amount, because the bars are
 * scaled to the largest row rather than to the total — so the bar says "compared
 * with the others" and the percentage says "of everything".
 */
function AllocationTile({
  slices,
  mode,
}: {
  readonly slices: NonNullable<OverviewDataDto['allocation']>;
  readonly mode: 'plan' | 'position';
}): ReactNode {
  const chosen = mode === 'plan' ? slices.plan : slices.position;
  const total = chosen.reduce((sum, slice) => sum + BigInt(slice.amountCents), 0n);

  const rows: RankedRow[] = chosen.map((slice) => {
    const amount = BigInt(slice.amountCents);
    return {
      key: slice.key,
      name: slice.name,
      color: slice.color,
      valueCents: amount,
      ...(total > 0n ? { aside: share(amount, total) } : {}),
    };
  });

  return (
    <RankedBars
      rows={rows}
      emptyMessage={
        mode === 'plan' ? 'No amounts to delegate yet.' : 'Nothing in the envelopes yet.'
      }
    />
  );
}

/**
 * Two readings of one subject, which is why they are one tile with a switch.
 *
 * **Current** is where the money is sitting now, which drifts with the timing of
 * bills rather than with anything decided. **Delegations** is what every payday
 * puts where — the household's priorities, stable enough to recognise at a
 * glance. Current is first because it is the one somebody is usually asking
 * about; the other they already decided.
 *
 * They were "Now" and "Plan", which named the *idea* rather than the thing on
 * screen — this budget calls those amounts delegations everywhere else.
 */
const ALLOCATION_MODES = [
  // Current first, because it is the one somebody is usually asking about — the
  // plan is a decision they already made and can recognise; this is where the
  // money actually is today.
  { value: 'position' as const, label: 'Current' },
  { value: 'plan' as const, label: 'Delegations' },
];

/**
 * Which edge of a tile a drop would land on.
 *
 * The vertical thirds decide first: a pointer in the top or bottom quarter means
 * a new row, and anywhere in the middle half means joining this one. Quarters
 * rather than halves because joining is the commoner act and should have the
 * larger target — and because a tile is much wider than it is tall, so a
 * horizontal band of a quarter is still a comfortable thing to hit.
 */
export type DropEdge = 'left' | 'right' | 'above' | 'below';

/**
 * Which edge of a tile a drop would land on.
 *
 * The vertical quarters decide first: a pointer in the top or bottom quarter
 * means a new row, and anywhere in the middle half means joining this one.
 * Quarters rather than halves because joining is the commoner act and should
 * have the larger target — and because a tile is much wider than it is tall, so
 * a horizontal band of a quarter is still comfortable to hit.
 */
function edgeFor(box: DOMRect, x: number, y: number): DropEdge {
  const band = box.height / 4;
  if (y < box.top + band) return 'above';
  if (y > box.bottom - band) return 'below';
  return x < box.left + box.width / 2 ? 'left' : 'right';
}

/**
 * Where a tile goes when a region has none.
 *
 * It used to be an 8px sliver above every region, reserving its space so it did
 * not shift the layout mid-drag. That solved one problem and created two: 8px is
 * not a target anybody can hit — a tile dragged at it landed back in the grid —
 * and the 32px it took above the main column pushed those tiles below the panel
 * beside them.
 *
 * So it is drawn only when a region is **empty**, where it is the only way in,
 * and it is a proper zone rather than a line. A populated region needs none: the
 * top edge of its first tile already means "above this", which is the same drop.
 */
function EmptyRegionDrop({
  label,
  active,
  onOver,
  onLeave,
  onDrop,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onOver: () => void;
  readonly onLeave: () => void;
  readonly onDrop: () => void;
}): ReactNode {
  return (
    <div
      aria-label={label}
      onDragOver={(event) => {
        // Without this the browser refuses the drop outright.
        event.preventDefault();
        onOver();
      }}
      onDragLeave={onLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={`flex min-h-24 items-center justify-center rounded-lg border border-dashed p-4 text-quiet transition-colors ${
        active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
      }`}
    >
      {label}
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
  onChooseFigures,
  onPickDay,
  onOpenAllBills,
  allocationMode,
  accountId,
  onAccount,
  delegationId,
  onDelegation,
  preview = false,
}: {
  readonly tileKey: string;
  readonly data: OverviewDataDto | undefined;
  readonly budget?: BudgetViewDto | undefined;
  readonly chosen?: readonly string[];
  readonly onChoose?: () => void;
  readonly onChooseFigures?: () => void;
  /** Opens what was spent on one day of the outflow band. */
  readonly onPickDay?: ((dayIso: string) => void) | undefined;
  /** Opens every recurring bill, in the middle of the page. */
  readonly onOpenAllBills?: (() => void) | undefined;
  readonly allocationMode?: 'plan' | 'position';
  readonly accountId?: string | undefined;
  readonly onAccount?: (id: string) => void;
  readonly delegationId?: string | undefined;
  readonly onDelegation?: (id: string) => void;
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
    case 'daily_outflow':
      // Calendar months, so it needs no payday anchor and works on a household
      // that has never set one.
      return data.daily_outflow ? (
        <OutflowBand
          months={data.daily_outflow}
          todayIso={localToday()}
          onPickDay={onPickDay ?? (() => undefined)}
        />
      ) : null;
    case 'income_vs_spending_pace':
      return data.income_vs_spending_pace ? (
        <PaceChart points={data.income_vs_spending_pace} />
      ) : (
        <NeedsPayday />
      );
    case 'allocation':
      return data.allocation ? (
        <AllocationTile slices={data.allocation} mode={allocationMode ?? 'position'} />
      ) : null;
    case 'account_balance_history':
      return (
        <BalanceHistoryTile
          history={data.account_balance_history}
          options={data.pickable?.accounts ?? []}
          selectedId={accountId ?? null}
          onSelect={(id) => onAccount?.(id)}
          label="Account"
          emptyMessage="No account has history yet."
          preview={preview}
        />
      );
    case 'delegation_balance_history':
      return (
        <BalanceHistoryTile
          history={data.delegation_balance_history}
          options={data.pickable?.delegations ?? []}
          selectedId={delegationId ?? null}
          onSelect={(id) => onDelegation?.(id)}
          label="Delegation"
          emptyMessage="No delegation has history yet."
          preview={preview}
        />
      );
    case 'upcoming_bills':
      return data.upcoming_bills ? (
        <UpcomingList bills={data.upcoming_bills} onOpenAll={onOpenAllBills ?? (() => undefined)} />
      ) : null;
    case 'bills_attention':
      return data.bills_attention ? (
        <BillAttentionList
          bills={data.bills_attention}
          onOpenAll={onOpenAllBills ?? (() => undefined)}
        />
      ) : null;
    case 'bills_this_cycle':
      return data.bills_this_cycle ? (
        <BillsThisCycle summary={data.bills_this_cycle} />
      ) : (
        <EmptyState>Set your next payday on Settings → Budget to see this cycle.</EmptyState>
      );
    case 'utilities_trend':
      return data.utilities_vs_delegated ? (
        <UtilityTrends entries={data.utilities_vs_delegated.entries} />
      ) : null;
    case 'outstanding_checks':
      return data.outstanding_checks ? (
        <OutstandingChecks checks={data.outstanding_checks} />
      ) : null;
    case 'utilities_adjust':
      return data.utilities_vs_delegated ? (
        <UtilitiesToAdjust entries={data.utilities_vs_delegated.entries} />
      ) : null;
    case 'cashflow':
      return data.cashflow ? <CashflowTile cashflow={data.cashflow} /> : null;
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
  /** Which day of the outflow band is open, if any. */
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  /** Whether every bill is showing, opened from one of the bill tiles. */
  const [showingBills, setShowingBills] = useState(false);
  /**
   * The row being dragged taller or shorter, and how tall it is right now.
   *
   * Local while the pointer is down so the edge tracks it, and written once on
   * release — a layout PUT per pointermove would be a request every few
   * milliseconds for a gesture that has one outcome.
   */
  const [resizing, setResizing] = useState<{ row: number; px: number } | null>(null);

  const [tab, setTab] = useState<PanelTab>('delegations');
  // Read-only: the controls that write are not drawn. The server refuses them
  // regardless; this is about not offering what cannot be done.
  const demo = useIsDemo();

  /*
   * On a phone the panel's tabs are promoted onto the page and Overview becomes
   * the fourth. There is no room to dock 398px beside anything at 390px wide,
   * and the answer she opens the app for should not be behind a button.
   */
  const [phoneView, setPhoneView] = useState<'overview' | PanelTab>('overview');

  const [dragging, setDragging] = useState<string | null>(null);
  /** Which region's top strip the pointer is over, while a drag is running. */
  const [topTarget, setTopTarget] = useState<'main' | 'sidebar' | null>(null);
  const [over, setOver] = useState<{ key: string; side: DropEdge } | null>(null);

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
      /*
       * The allocation tile's **configuration** is left out — not the tile.
       *
       * It is the one config the server no longer reads: both readings of the
       * donut are computed and sent together, so which of them is showing
       * changes nothing about what would come back. Including it meant every
       * press of that switch waited on a recompute of the whole page — about a
       * second, for a toggle whose data was already in the browser.
       *
       * Dropping the tile from the signature entirely was the first attempt and
       * was wrong in the way this comment exists to prevent: *adding* Allocation
       * then changed nothing either, so the page never refetched and the tile
       * drew empty until a reload. Which tiles are on the page always changes
       * what the server computes.
       */
      const signature = (tiles: readonly OverviewTileDto[]): string =>
        tiles
          .map((tile) =>
            tile.key === 'allocation'
              ? tile.key
              : `${tile.key}:${JSON.stringify(tile.config ?? null)}`,
          )
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
  const placed = useMemo(() => tiles.filter((tile) => tile.key !== 'delegations'), [tiles]);
  const rows = useMemo(
    () => groupIntoRows(placed.filter((tile) => tile.region !== 'sidebar')),
    [placed],
  );
  /** The sidebar is one column: every tile in it has a row to itself. */
  const sidebarTiles = useMemo(() => placed.filter((tile) => tile.region === 'sidebar'), [placed]);

  /**
   * Writes rows back as tiles, renumbering so a gap left by a row closes.
   *
   * **The panel's own row is carried through explicitly.** It is filtered out of
   * `rows` because it is drawn by the panel rather than in the grid, which meant
   * every arrange operation wrote a layout without it — silently deleting the
   * chosen delegations the moment anybody moved a tile. Losing a selection as a
   * side effect of rearranging something else is the worst kind of data loss:
   * nothing failed, and nothing said so.
   */
  function saveRows(
    next: readonly (readonly OverviewTileDto[])[],
    sidebar: readonly OverviewTileDto[] = sidebarTiles,
  ): void {
    /*
     * A height belongs to a row, so a tile that leaves one leaves it behind.
     *
     * It is stored on every member because a row is not a record — but that
     * makes a tile carry the number with it, and a tall tile dragged onto a row
     * of its own would arrive still 600px tall for no reason anybody gave.
     * Clearing it on a move is the rule that matches what the drag meant.
     */
    const before = new Map(tiles.map((tile) => [tile.key, tile.row]));
    const grid = flattenRows(next).map(({ row, position, tile }) => ({
      ...tile,
      region: 'main' as const,
      row,
      position,
      heightPx: before.get(tile.key) === row ? tile.heightPx : null,
    }));
    // The sidebar is one column, so its row number is its order and its
    // position is always zero.
    const aside = sidebar.map((tile, row) => ({
      ...tile,
      region: 'sidebar' as const,
      row,
      position: 0,
    }));
    const panel = tiles.find((tile) => tile.key === 'delegations');
    save.mutate([
      ...grid,
      ...aside,
      ...(panel ? [{ ...panel, region: 'main' as const, row: grid.length, position: 0 }] : []),
    ]);
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
    save.mutate([
      ...tiles,
      {
        key,
        region: 'main' as const,
        row: rows.length,
        position: 0,
        // Its own height until somebody drags the row.
        heightPx: null,
        display: null,
        config: null,
      },
    ]);
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
  /**
   * Moves the dragged tile to an edge of `targetKey`.
   *
   * `region` is where the target lives, so one function serves both: dropping a
   * main tile onto a sidebar tile moves it across, and the reverse brings it
   * back. The sidebar is one column, so every drop there is a new row and the
   * horizontal edges are the only ones it can offer.
   */
  function drop(targetKey: string, side: DropEdge, region: 'main' | 'sidebar'): void {
    if (dragging === null || dragging === targetKey) return;

    const tile = placed.find((entry) => entry.key === dragging);
    if (!tile) return;

    // Out of wherever it was, in both regions, before deciding where it lands.
    const grid = without(dragging);
    const aside = sidebarTiles.filter((entry) => entry.key !== dragging);

    if (region === 'sidebar') {
      const at = aside.findIndex((entry) => entry.key === targetKey);
      if (at < 0) return;
      const insert = side === 'above' || side === 'left' ? at : at + 1;
      saveRows(
        grid.filter((row) => row.length > 0),
        [...aside.slice(0, insert), tile, ...aside.slice(insert)],
      );
      return;
    }

    const compact = grid.filter((row) => row.length > 0);
    const at = compact.findIndex((row) => row.some((entry) => entry.key === targetKey));
    if (at < 0) return;

    if (side === 'above' || side === 'below') {
      // A row of its own, which is the gesture that did not exist before.
      compact.splice(side === 'above' ? at : at + 1, 0, [tile]);
      saveRows(compact, aside);
      return;
    }

    const destination = compact[at]!;
    if (destination.length >= MAX_TILES_PER_ROW) return;
    const index = destination.findIndex((entry) => entry.key === targetKey);
    compact[at] = [
      ...destination.slice(0, side === 'left' ? index : index + 1),
      tile,
      ...destination.slice(side === 'left' ? index : index + 1),
    ];
    saveRows(compact, aside);
  }

  /**
   * A drop above everything, for the one place no tile's edge can reach.
   *
   * The top edge of the first tile is a target, but only once there is a first
   * tile in that region — an empty sidebar, or the strip above a full grid, had
   * no way to be dropped onto at all.
   */
  function dropAtTop(region: 'main' | 'sidebar'): void {
    if (dragging === null) return;
    const tile = placed.find((entry) => entry.key === dragging);
    if (!tile) return;

    const grid = without(dragging).filter((row) => row.length > 0);
    const aside = sidebarTiles.filter((entry) => entry.key !== dragging);

    if (region === 'sidebar') saveRows(grid, [tile, ...aside]);
    else saveRows([[tile], ...grid], aside);
  }

  /**
   * A tile's own control, drawn in its header.
   *
   * Two have one: the cashflow chart's period, which the page's own control does
   * not set, and the allocation donut's reading. Both belong to the tile rather
   * than to the page, and a control in the tile's corner is how that is said.
   */
  function controlsFor(key: string): ReactNode {
    if (key === 'cashflow') {
      return (
        <SegmentedControl
          size="sm"
          label="Cashflow period"
          value={data.data?.cashflowWindow ?? 'ytd'}
          options={CASHFLOW_WINDOWS}
          onChange={setCashflowWindow}
        />
      );
    }
    if (key === 'allocation') {
      return (
        <SegmentedControl
          size="sm"
          label="Allocation reading"
          value={allocationMode}
          options={ALLOCATION_MODES}
          onChange={setAllocationMode}
        />
      );
    }
    return undefined;
  }

  /** How tall a row is: the largest its members claim, or their own height. */
  function heightOf(group: readonly OverviewTileDto[], index: number): number | null {
    if (resizing?.row === index) return resizing.px;
    const claimed = group
      .map((tile) => tile.heightPx)
      .filter((height): height is number => height !== null);
    return claimed.length > 0 ? Math.max(...claimed) : null;
  }

  /*
   * Bounds, matched to the ones the server enforces. Held here as well because
   * a refused save is a row that snaps back with no explanation, and the honest
   * place to stop a drag is at the edge of what can be stored.
   */
  const MIN_ROW = 120;
  const MAX_ROW = 1600;

  /** A row's height, live while dragging and written once on release. */
  function resizeRow(index: number, px: number, done: boolean): void {
    const clamped = Math.max(MIN_ROW, Math.min(px, MAX_ROW));
    if (!done) {
      setResizing({ row: index, px: clamped });
      return;
    }
    setResizing(null);

    const group = rows[index];
    if (!group) return;
    const keys = new Set(group.map((tile) => tile.key));
    // Written to every member, because a row is a number they share rather than
    // a record of its own.
    save.mutate(tiles.map((tile) => (keys.has(tile.key) ? { ...tile, heightPx: clamped } : tile)));
  }

  /** What a picker tile has been pointed at, or undefined. */
  function pickedId(key: string, field: string): string | undefined {
    const config = tiles.find((tile) => tile.key === key)?.config;
    if (config === null || config === undefined || typeof config !== 'object') return undefined;
    const value = (config as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
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

  /** Which account or delegation a balance-history tile charts. */
  function setPicked(key: string, field: string, id: string): void {
    save.mutate(
      tiles.map((tile) => (tile.key === key ? { ...tile, config: { [field]: id } } : tile)),
    );
  }

  /** The donut's reading, stored on its tile. */
  function setAllocationMode(next: 'plan' | 'position'): void {
    save.mutate(
      tiles.map((tile) => (tile.key === 'allocation' ? { ...tile, config: { mode: next } } : tile)),
    );
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
            region: 'main' as const,
            // Off the end of the grid, and never drawn there anyway.
            row: rows.length,
            position: 0,
            heightPx: null,
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

  /**
   * What the donut is drawing, read from its stored configuration.
   *
   * Current unless it was told otherwise, matching the order of the switch: it
   * is the reading somebody is usually asking about.
   */
  const allocationMode: 'plan' | 'position' =
    (tiles.find((tile) => tile.key === 'allocation')?.config as { mode?: string } | null)?.mode ===
    'plan'
      ? 'plan'
      : 'position';

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
        actions={
          <>
            <SegmentedControl
              label="Time window"
              value={window}
              options={WINDOWS}
              onChange={setWindow}
            />
            {/* Arranging writes a layout, which a read-only demo refuses.
                What it opens on is what it has. */}
            {!demo && (
              <Button
                variant={arranging ? 'primary' : 'default'}
                onClick={() => setArranging(!arranging)}
                aria-pressed={arranging}
              >
                {arranging ? 'Done' : 'Arrange'}
              </Button>
            )}
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

      {pickedDay !== null && <DayDialog dayIso={pickedDay} onClose={() => setPickedDay(null)} />}

      {showingBills && <AllBillsDialog onClose={() => setShowingBills(false)} />}

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
          {layout.isPending || data.isPending ? null : rows.length === 0 ? (
            /* Nothing here, so this is the only way in. Anywhere else, the top
               edge of the first tile is the same drop. */
            <EmptyRegionDrop
              label={dragging === null ? 'No tiles yet.' : 'Drop here'}
              active={topTarget === 'main'}
              onOver={() => setTopTarget('main')}
              onLeave={() => setTopTarget(null)}
              onDrop={() => {
                dropAtTop('main');
                setDragging(null);
                setTopTarget(null);
              }}
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-12 lg:grid-cols-12">
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
                        setOver({
                          key: tile.key,
                          side: edgeFor(box, event.clientX, event.clientY),
                        });
                      },
                      onDrop: (event) => {
                        event.preventDefault();
                        const side = over?.key === tile.key ? over.side : 'right';
                        drop(tile.key, side, 'main');
                        setDragging(null);
                        setOver(null);
                      },
                      over: over?.key === tile.key ? over.side : null,
                    }}
                    controls={controlsFor(tile.key)}
                    height={heightOf(group, rows.indexOf(group))}
                    onResize={(px, done) => resizeRow(rows.indexOf(group), px, done)}
                  >
                    <TileBody
                      tileKey={tile.key}
                      data={data.data}
                      budget={budget.data}
                      chosen={chosenFor(tile)}
                      onChoose={() => setPicking(tile.key)}
                      onChooseFigures={() => setPickingFigures(true)}
                      onPickDay={setPickedDay}
                      onOpenAllBills={() => setShowingBills(true)}
                      allocationMode={allocationMode}
                      accountId={pickedId('account_balance_history', 'accountId')}
                      onAccount={(id) => setPicked('account_balance_history', 'accountId', id)}
                      delegationId={pickedId('delegation_balance_history', 'delegationId')}
                      onDelegation={(id) =>
                        setPicked('delegation_balance_history', 'delegationId', id)
                      }
                    />
                  </TileShell>
                )),
              )}
            </div>
          )}
        </div>

        {/*
          The right column: the budget panel, pinned at the top, and whatever
          tiles have been dragged in beneath it.

          One column, always. It is about 400px wide, and two tiles across that
          is neither — so every tile here has a row to itself and the only drop
          edges it offers are the horizontal ones.
        */}
        <div className="hidden flex-col gap-6 lg:flex">
          {/*
            Always shown. It collapsed to a button, per device — and the answer
            somebody opens this page for should not be behind one. The width it
            gave back was the width the dashboard is designed around.
          */}
          <OverviewPanel
            variant="docked"
            tab={tab}
            onTab={setTab}
            data={data.data}
            onChoose={() => setPicking('delegations')}
          />

          {/* Above everything in this column, which no tile's own edge reaches
              — and the only way to drop into an empty sidebar at all. */}
          {sidebarTiles.length === 0 && (
            <EmptyRegionDrop
              label={dragging === null ? 'Drag a tile here' : 'Drop here'}
              active={topTarget === 'sidebar'}
              onOver={() => setTopTarget('sidebar')}
              onLeave={() => setTopTarget(null)}
              onDrop={() => {
                dropAtTop('sidebar');
                setDragging(null);
                setTopTarget(null);
              }}
            />
          )}

          {sidebarTiles.map((tile) => (
            <TileShell
              key={tile.key}
              tile={tile}
              columns={12}
              rowSize={1}
              arranging={arranging}
              draggable={pointer}
              onMove={() => undefined}
              onRemove={() => remove(tile.key)}
              onSplit={() => undefined}
              onJoin={() => undefined}
              drag={{
                onDragStart: () => setDragging(tile.key),
                onDragOver: (event) => {
                  if (dragging === null || dragging === tile.key) return;
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  // One column, so only above or below can mean anything here.
                  setOver({
                    key: tile.key,
                    side: event.clientY < box.top + box.height / 2 ? 'above' : 'below',
                  });
                },
                onDrop: (event) => {
                  event.preventDefault();
                  const side = over?.key === tile.key ? over.side : 'below';
                  drop(tile.key, side, 'sidebar');
                  setDragging(null);
                  setOver(null);
                },
                over: over?.key === tile.key ? over.side : null,
              }}
              controls={controlsFor(tile.key)}
            >
              <TileBody
                tileKey={tile.key}
                data={data.data}
                budget={budget.data}
                chosen={chosenFor(tile)}
                onChoose={() => setPicking(tile.key)}
                onChooseFigures={() => setPickingFigures(true)}
                onPickDay={setPickedDay}
                onOpenAllBills={() => setShowingBills(true)}
                allocationMode={allocationMode}
                accountId={pickedId('account_balance_history', 'accountId')}
                onAccount={(id) => setPicked('account_balance_history', 'accountId', id)}
                delegationId={pickedId('delegation_balance_history', 'delegationId')}
                onDelegation={(id) => setPicked('delegation_balance_history', 'delegationId', id)}
              />
            </TileShell>
          ))}
        </div>
      </div>
    </>
  );
}
