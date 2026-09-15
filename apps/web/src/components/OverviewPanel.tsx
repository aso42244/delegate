import { useState, type ReactNode } from 'react';
import type { BudgetRowDto, BudgetViewDto } from '../api/budget.js';
import type { OverviewDataDto } from '../api/overview.js';
import { EmptyState, SegmentedControl } from './layout.jsx';
import { AccountsTable } from './AccountsTable.jsx';
import { DelegationsTable } from './DelegationsTable.jsx';
import { PaceBar, paceSummary } from './PaceBar.jsx';
import { Tile } from './Tile.jsx';
import { useIsDemo } from '../useDemo.js';

/**
 * The budget, across the top of Overview.
 *
 * It was docked down the right in a 398px column, and it was a *reading*: a
 * chosen handful of lines, a pace bar each, and no way to act on any of it. Every
 * review that found something ended on another page.
 *
 * It is the page's first block now — full width, pinned above the tiles, and the
 * same table the Budget page draws. The width is what made that possible rather
 * than a matter of taste: two money columns and a name you can recognise do not
 * fit in 398px, which was measured in v0.60.0 when three of them were cut to one.
 *
 * **Two tabs, not three.** Accounts and Debts were separate tabs over two short
 * lists that are read together — what there is, and what is owed against it — so
 * they are one tab with Accounts first.
 *
 * **Both tabs draw the Budget page's own table.** Delegations always did;
 * Accounts & Debts drew a flat list of name and balance until ADR 068, which was
 * the last thing that page could do and this one could not. Groupings, the row
 * menu, moving an account and ordering the list all arrived with the component
 * rather than being built a second time here.
 *
 * **Pinned.** It is not a tile: it cannot be dragged, removed, or dropped onto,
 * and nothing can be placed above or beside it. A dashboard whose first block is
 * the budget is the arrangement the household asked for, and an arrangement that
 * can lose it is one that will.
 */

export type PanelTab = 'delegations' | 'balances';

const TABS = [
  { value: 'delegations' as const, label: 'Delegations' },
  { value: 'balances' as const, label: 'Accounts & Debts' },
];

/** Which lines the band is showing. */
export type PanelScope = 'selected' | 'all';

const SCOPES = [
  { value: 'selected' as const, label: 'Show selected' },
  { value: 'all' as const, label: 'Show all' },
];

/** Which accounts the balances tab is showing. */
type BalanceFilter = 'withBalance' | 'all';

const BALANCE_FILTERS = [
  { value: 'withBalance' as const, label: 'With balance' },
  { value: 'all' as const, label: 'All' },
];

export function OverviewPanel({
  tab,
  onTab,
  scope,
  onScope,
  data,
  budget,
  onChoose,
}: {
  readonly tab: PanelTab;
  readonly onTab: (next: PanelTab) => void;
  readonly scope: PanelScope;
  readonly onScope: (next: PanelScope) => void;
  readonly data: OverviewDataDto | undefined;
  /** The budget itself. The band draws the same view the Budget page does. */
  readonly budget: BudgetViewDto | undefined;
  readonly onChoose: () => void;
}): ReactNode {
  const [balanceFilter, setBalanceFilter] = useState<BalanceFilter>('withBalance');

  /*
   * The tab's own control, at the right-hand end of the bar.
   *
   * One position, whichever tab is showing: it is the thing that changes what
   * the band is drawing, so it sits where a control is looked for rather than
   * between two readings.
   */
  const control =
    tab === 'delegations' ? (
      <SegmentedControl
        size="sm"
        label="Which delegations"
        value={scope}
        options={SCOPES}
        onChange={onScope}
      />
    ) : (
      <SegmentedControl
        size="sm"
        label="Which accounts"
        value={balanceFilter}
        options={BALANCE_FILTERS}
        onChange={setBalanceFilter}
      />
    );

  return (
    <Tile
      span="full"
      aria-label="Budget"
      /*
       * Read on the left, act on the right.
       *
       * The cycle stamp was between the two controls, which put a *reading*
       * inside a row of things to press and left the two controls unable to hold
       * a fixed position between them. It is the header's left-hand track now
       * and the controls are both on the right, in one order: what the band is
       * showing, then how much of it — so **Show selected / Show all** is the
       * last thing on the line at every width.
       */
      lead={<CycleStamp cycle={data?.payCycle ?? null} />}
      actions={
        /*
         * One row where the tile is wide, stacked and right-justified where it
         * is not.
         *
         * A container query rather than a breakpoint: this asks how wide *this
         * tile* is, which is the question (`ui-system.md` §2). On a phone the
         * two controls come to about 330px and the reading beside them has
         * nowhere to go, so they stack — tabs on top, because that is the choice
         * made first — and both stay hard right, which is where the eye already
         * is for the second of them.
         */
        <div className="flex flex-col items-end gap-2 @xl:flex-row @xl:items-center">
          <SegmentedControl size="sm" label="Panel" value={tab} options={TABS} onChange={onTab} />
          {control}
        </div>
      }
    >
      {tab === 'delegations' ? (
        <DelegationsBand data={data} budget={budget} scope={scope} onChoose={onChoose} />
      ) : (
        <AccountsBand budget={budget} filter={balanceFilter} />
      )}
    </Tile>
  );
}

/**
 * Where the household is between one payday and the next, in one line.
 *
 * No cadence: `pay_cadence` is a divisor and the length of the cycle falls out
 * of the anchor, so "of 14" told the household a number it already knows.
 */
function CycleStamp({ cycle }: { readonly cycle: OverviewDataDto['payCycle'] }): ReactNode {
  if (!cycle) {
    // No anchor set. Said plainly rather than drawing an empty bar, because an
    // empty progress bar reads as "nothing has happened yet".
    return <span className="text-micro text-muted">No payday set</span>;
  }

  const percent = Math.round((cycle.progressBasisPoints / 10_000) * 100);
  const day = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  /*
   * Wrapping, not `whitespace-nowrap`. It held one line while it sat among the
   * controls and could push them along; in the header's left-hand track on a
   * phone it has about 160px, and a line that refuses to break there is a line
   * that squeezes the controls beside it instead of giving way.
   */
  return (
    <span className="text-micro text-muted">
      {day(cycle.start)}–{day(cycle.end)} · day {cycle.elapsedDays} · {percent}% through
    </span>
  );
}

function DelegationsBand({
  data,
  budget,
  scope,
  onChoose,
}: {
  readonly data: OverviewDataDto | undefined;
  readonly budget: BudgetViewDto | undefined;
  readonly scope: PanelScope;
  readonly onChoose: () => void;
}): ReactNode {
  const demo = useIsDemo();
  const tick = data?.payCycle?.progressBasisPoints ?? null;

  /*
   * This cycle's spending, by line.
   *
   * The only figure a pace bar needs that the budget view does not carry. It
   * comes from `/api/overview`, which computes it for every line — the selection
   * decides what is shown rather than what is computed.
   */
  const spentById = new Map((data?.panel ?? []).map((line) => [line.id, line.spentCents]));
  const chosen = data?.panelSelected ?? [];

  /*
   * The bar's colour, by line.
   *
   * Taken from the grouping the line is filed under, because a row does not
   * carry one — the table has never needed it while every coloured row was drawn
   * inside the grouping that gave it the colour.
   */
  const colorById = new Map<string, string | null>();
  for (const grouping of budget?.delegations.groupings ?? []) {
    for (const row of grouping.rows) colorById.set(row.id, grouping.color);
  }

  if (!budget) return <EmptyState>Loading the budget…</EmptyState>;

  if (scope === 'selected' && chosen.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState>No delegations chosen yet.</EmptyState>
        {!demo && <ChooseLink onChoose={onChoose} />}
      </div>
    );
  }

  const pace = (row: BudgetRowDto): ReactNode => {
    // A check is a piece of paper, not an envelope being spent down. There is no
    // cycle reading to draw for one.
    if (row.kind === 'check') return null;

    const spent = BigInt(spentById.get(row.id) ?? '0');
    const planned = BigInt(row.amountToDelegateCents ?? '0');
    const balance = BigInt(row.balanceCents ?? '0');
    const summary = paceSummary({
      spentCents: spent,
      plannedCents: planned,
      balanceCents: balance,
    });

    return (
      <span className="block min-w-0" title={summary}>
        <PaceBar
          spentCents={spent}
          plannedCents={planned}
          balanceCents={balance}
          color={colorById.get(row.id) ?? null}
          cycleProgressBasisPoints={tick}
          label={`${row.name}: ${summary}`}
        />
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <DelegationsTable
        view={budget}
        pace={pace}
        {...(scope === 'selected' ? { only: chosen } : {})}
      />
      {/* Choosing writes the layout, which a read-only demo refuses. What it
          opens with is what it watches. */}
      {!demo && scope === 'selected' && <ChooseLink onChoose={onChoose} />}
    </div>
  );
}

/**
 * Right, with the figures it belongs to, rather than adrift under the left edge
 * of a column whose content is all right-aligned.
 *
 * **"Select Delegations"**, which is what it does. "Choose which delegations
 * show" described the dialog's contents rather than naming the act, and it was
 * long enough on a phone to wrap under the table it belongs to.
 */
function ChooseLink({ onChoose }: { readonly onChoose: () => void }): ReactNode {
  return (
    <div className="flex justify-end">
      <button type="button" className="linkish" onClick={onChoose}>
        Select Delegations
      </button>
    </div>
  );
}

/**
 * Accounts and debts, one tab, **and only what the budget counts**.
 *
 * `in_budget` decides which accounts the identity sums, and ADR 050 made that a
 * wall rather than a description. This band is the budget's, so it stands on the
 * same side of it: a property and a retirement account are net worth, not money
 * this budget can allocate. Nothing here does that filtering — `/api/budget`
 * already answers with the in-budget accounts and only those, which is why this
 * reads the view the delegations tab is already holding rather than fetching
 * every account and sieving them.
 *
 * Accounts first. It is the half somebody is usually asking about, and a debt
 * read before the money that covers it is the wrong order to be handed.
 */
function AccountsBand({
  budget,
  filter,
}: {
  readonly budget: BudgetViewDto | undefined;
  readonly filter: BalanceFilter;
}): ReactNode {
  // The same wait the delegations tab makes. Drawing empty sections for a beat
  // is worse than drawing nothing: the headings appear, then the rows push them
  // down.
  if (!budget) return null;

  return (
    <AccountsTable
      view={budget}
      arrangement="side-by-side"
      onlyWithBalance={filter === 'withBalance'}
    />
  );
}
