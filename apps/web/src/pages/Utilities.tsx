import { visibleMonths } from './utility-months.js';
import { formatCents } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';
import { EmptyState } from '../components/layout.jsx';
import { RankedBars, type RankedRow } from '../components/RankedBars.jsx';
import { Tile } from '../components/Tile.jsx';
import { Alert } from '../components/ui.jsx';

/**
 * The Cost half of Recurring: what each utility averages, and what a paycheck's
 * share of that is.
 *
 * The owner did this arithmetic by hand: what does the water bill average over a
 * year, and what is that per paycheck? Showing it is the entire point. It
 * **suggests only** — nothing here writes an amount to delegate, because a bill
 * that averages $118 is not the same as a decision to fund it at $118.
 *
 * **It was a grid of 330px cards, one per utility**, each carrying a chart and
 * four labelled figures stacked under it. Two of them filled a laptop row and
 * the page below the fold was a third utility. It is two tiles now, each a dense
 * list with a row per utility — the shape "Spending by grouping" and "Coming up"
 * already use on Overview, and the shape that lets Due and Cost sit side by side
 * (ADR 061). Nothing was dropped: the per-cycle comparison is the first tile,
 * the twelve months and the monthly average are the second, and the sentence
 * that names the divisor is the first tile's footer.
 */

interface MonthDto {
  readonly month: string;
  readonly spendCents: string;
  readonly complete: boolean;
}

interface UtilityDto {
  readonly delegationId: string;
  readonly name: string;
  readonly groupingName: string | null;
  readonly groupingColor: string | null;
  readonly amountToDelegateCents: string | null;
  readonly averageCents: string;
  readonly suggestedPerCycleCents: string;
  readonly months: readonly MonthDto[];
}

/** "2026-07" as "Jul 2026", which is what a bar is actually labelled by. */
function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  const date = new Date(Number(year), Number(index) - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Twelve bars, scaled to the largest month so the shape is readable whatever the
 * amounts are. The month in progress is drawn faintly — it is not a full month
 * of bills and should not look like one.
 *
 * Sized by the row it sits in now rather than by a fixed 64px: it is a column in
 * a list, beside a name and a figure, rather than the middle of a card.
 */
function MiniChart({
  months,
  color,
}: {
  readonly months: readonly MonthDto[];
  /** The grouping's colour, so the bars and the dot beside the name agree. */
  readonly color: string | null;
}): ReactNode {
  const all = months.map((month) => BigInt(month.spendCents));
  const peak = all.reduce((max, value) => (value > max ? value : max), 0n);

  /*
   * Nothing spent in the whole window is not a chart of zeroes, it is no chart.
   * `block`, because the row is a grid and an inline span takes no height — the
   * column would collapse and the row beside it would sit a few pixels short.
   */
  if (peak <= 0n) return <span className="block h-6" />;

  // Months before the first bill, and the current one if it has no bill yet, are
  // the absence of history rather than history. See `utility-months.ts`.
  const shown = visibleMonths(months);
  const values = shown.map((month) => BigInt(month.spendCents));

  return (
    <div className="flex h-6 items-end gap-px">
      {shown.map((month, index) => {
        const value = values[index] ?? 0n;
        // Percentages as numbers only for layout — never for money.
        const height = peak <= 0n ? 0 : Number((value * 100n) / peak);

        // The column is the whole height so there is something to point at
        // even in a month that spent nothing; the bar sits inside it.
        return (
          <div
            key={month.month}
            className="group/bar relative flex h-full flex-1 items-end"
            title={`${monthLabel(month.month)}: ${formatCents(value)}${
              month.complete ? '' : ' so far'
            }`}
          >
            <div
              className="w-full rounded-sm"
              style={{
                height: `${Math.max(height, value > 0n ? 8 : 0)}%`,
                opacity: month.complete ? 1 : 0.28,
                background: color ?? 'var(--color-accent)',
              }}
            />

            {/* Shown on hover, because the whole row already carries the same
                reading as a title for anyone who cannot hover a 12px bar. */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 text-label whitespace-nowrap text-canvas group-hover/bar:block"
            >
              {monthLabel(month.month)} · {formatCents(value)}
              {month.complete ? '' : ' so far'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** How far out a line has to be before the comparison is worth marking: a fifth. */
const ADJUST_THRESHOLD = 5n;

/** Whether this line is funded far enough under what it costs to say so. */
function shortOfCost(utility: UtilityDto): boolean {
  if (utility.amountToDelegateCents === null) return false;
  const delegated = BigInt(utility.amountToDelegateCents);
  const suggested = BigInt(utility.suggestedPerCycleCents);
  if (suggested <= 0n) return false;
  // Integer arithmetic on cents: (suggested − delegated) * 5 > suggested.
  return (suggested - delegated) * ADJUST_THRESHOLD > suggested;
}

/**
 * What each line costs a cycle, against what it is set to.
 *
 * The comparison the page exists for, and one row for it rather than four
 * labelled figures: the bar ranks what the household actually spends on each of
 * these, the grey figure is what Delegate puts in, and the bold one is what a
 * year of the bills works out at per paycheck.
 */
function PerCycleTile({
  utilities,
  cyclesPerYear,
  anyHistory,
}: {
  readonly utilities: readonly UtilityDto[];
  readonly cyclesPerYear: number;
  readonly anyHistory: boolean;
}): ReactNode {
  const rows: RankedRow[] = utilities.map((utility) => {
    const suggested = BigInt(utility.suggestedPerCycleCents);
    const delegated =
      utility.amountToDelegateCents === null ? null : BigInt(utility.amountToDelegateCents);
    const short = shortOfCost(utility);

    return {
      key: utility.delegationId,
      name: utility.name,
      color: utility.groupingColor,
      valueCents: suggested,
      compare: {
        label: 'delegated per cycle',
        valueCents: delegated,
        ...(short ? ({ tone: 'warning' } as const) : {}),
      },
      /*
       * Both units, in the one place a row has room for a sentence.
       *
       * Every figure here names its unit — a per-month figure and a per-cycle
       * one adjacent and looking comparable is the bug the four labelled figures
       * were written to fix, and a list has no room for four labels a row.
       */
      title:
        `${utility.name} · ` +
        (delegated === null
          ? 'ad hoc, so Delegate adds nothing to it'
          : `${formatCents(delegated)} delegated per cycle`) +
        ` · ${formatCents(suggested)} suggested per cycle`,
    };
  });

  const shortfalls = utilities.filter(shortOfCost).length;

  return (
    <Tile
      title="Per cycle"
      description="Delegated against suggested"
      footer={
        <>
          {/* Said in words as well as in the colour on the row — §9, never state
              by colour alone. It leads, because it is the thing to act on. */}
          {shortfalls > 0 && (
            <span className="font-semibold text-warning">
              {shortfalls} delegated below suggested ·{' '}
            </span>
          )}
          {/* The divisor is named rather than assumed. A page saying "over 26"
              beside a figure computed from 12 is worse than either alone — and
              the count comes back from the same request as the figures, so the
              two cannot disagree. */}
          {cyclesPerYear > 0 && <>A year of bills over {cyclesPerYear} paychecks.</>}
        </>
      }
    >
      {!anyHistory && (
        <div className="mb-4">
          <Alert tone="info">Averages need categorized history.</Alert>
        </div>
      )}
      <RankedBars rows={rows} emptyMessage="No delegations are marked as a utility." />
    </Tile>
  );
}

/**
 * Twelve months a line, and what that averages.
 *
 * The history the suggestion is computed from, kept where somebody can check it:
 * a suggestion nobody can see the working of is a number to be argued with.
 */
function HistoryTile({ utilities }: { readonly utilities: readonly UtilityDto[] }): ReactNode {
  return (
    <Tile title="12 months" description="Average per month">
      <ul className="grid min-h-0 list-none content-start overflow-y-auto p-0 gap-x-2 [grid-template-columns:minmax(0,6rem)_minmax(2.5rem,1fr)_max-content]">
        {utilities.map((utility) => {
          const average = BigInt(utility.averageCents);
          return (
            <li
              key={utility.delegationId}
              className="row-cell col-span-full grid grid-cols-subgrid items-center gap-x-2"
              title={`${utility.name} · ${formatCents(average)} average per month`}
            >
              <span className="truncate text-quiet text-ink">{utility.name}</span>
              <MiniChart months={utility.months} color={utility.groupingColor} />
              <span className="money shrink-0 text-quiet font-semibold text-ink">
                {formatCents(average)}
              </span>
            </li>
          );
        })}
      </ul>
    </Tile>
  );
}

/**
 * The Cost half of Recurring. Suggests only — nothing here writes an amount to
 * delegate.
 */
export function UtilitiesView(): ReactNode {
  const query = useQuery({
    queryKey: ['utilities'],
    queryFn: () =>
      api.get<{ utilities: readonly UtilityDto[]; cyclesPerYear: number }>('/api/utilities'),
  });

  const utilities = query.data?.utilities ?? [];
  const anyHistory = utilities.some((utility) => BigInt(utility.averageCents) !== 0n);

  if (query.isLoading) {
    return (
      <Tile title="Per cycle">
        <EmptyState>Loading…</EmptyState>
      </Tile>
    );
  }

  if (utilities.length === 0) {
    return (
      <Tile title="Per cycle" description="Delegated against suggested">
        <EmptyState>No delegations are marked as a utility.</EmptyState>
      </Tile>
    );
  }

  return (
    <>
      <PerCycleTile
        utilities={utilities}
        cyclesPerYear={query.data?.cyclesPerYear ?? 0}
        anyHistory={anyHistory}
      />
      <HistoryTile utilities={utilities} />
    </>
  );
}
