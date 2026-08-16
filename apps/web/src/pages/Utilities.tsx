import { formatCents, CYCLES_PER_YEAR } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';

/**
 * Utilities.
 *
 * The owner does this arithmetic by hand today: what does the water bill average
 * over a year, and what is that per paycheck? Showing it is the entire point of
 * the page. It **suggests only** — nothing here writes an amount to delegate,
 * because a bill that averages $118 is not the same as a decision to fund it at
 * $118.
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

/**
 * Twelve bars, scaled to the largest month so the shape is readable whatever the
 * amounts are. The month in progress is drawn faintly — it is not a full month
 * of bills and should not look like one.
 */
/** "2026-07" as "Jul 2026", which is what a bar is actually labelled by. */
function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  const date = new Date(Number(year), Number(index) - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function MiniChart({
  months,
  color,
}: {
  readonly months: readonly MonthDto[];
  /** The grouping's colour, so the bars and the dot beside the name agree. */
  readonly color: string | null;
}): ReactNode {
  const values = months.map((month) => BigInt(month.spendCents));
  const peak = values.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <div className="flex h-16 items-end gap-1">
      {months.map((month, index) => {
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
                height: `${Math.max(height, value > 0n ? 4 : 0)}%`,
                opacity: month.complete ? 1 : 0.28,
                background: color ?? 'var(--color-accent)',
              }}
            />

            {/* Shown on hover and on keyboard focus within, because a tooltip
                only a mouse can reach is a tooltip half the page cannot use. */}
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

function UtilityCard({ utility }: { readonly utility: UtilityDto }): ReactNode {
  const average = BigInt(utility.averageCents);
  const suggested = BigInt(utility.suggestedPerCycleCents);
  const configured =
    utility.amountToDelegateCents === null ? null : BigInt(utility.amountToDelegateCents);

  // The comparison the page exists for: is this line under- or over-delegated?
  const gap = configured === null ? null : configured - suggested;

  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <header className="mb-3 flex items-center gap-2">
        {utility.groupingColor && (
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: utility.groupingColor }}
          />
        )}
        <h2 className="text-base font-semibold text-ink">{utility.name}</h2>
        {utility.groupingName && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-label font-semibold text-muted">
            {utility.groupingName}
          </span>
        )}
      </header>

      <MiniChart months={utility.months} color={utility.groupingColor} />

      {/*
        Four figures, each labelled, each in the same column. This was two hero
        numbers and two sentences underneath, which said the same four things at
        three different weights and left the reader to work out which two were
        the comparison. A list of label-and-figure does not need to be read to be
        scanned.

        "Delegated", never "funded": it is the word the rest of the application
        uses for this, and one idea should not have two names.
      */}
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 text-quiet">
        <dt className="text-muted">Average per month</dt>
        <dd className="money font-semibold text-ink">{formatCents(average)}</dd>

        <dt className="text-muted">Suggested per cycle</dt>
        <dd className="money font-semibold text-ink">{formatCents(suggested)}</dd>

        <dt className="text-muted">Delegated per cycle</dt>
        <dd className="money font-semibold text-ink">
          {configured === null ? <span className="text-faint">—</span> : formatCents(configured)}
        </dd>

        {/* Only where there is something to compare. An ad-hoc line has no
            suggestion to be above or below. */}
        {gap !== null && (
          <>
            <dt className="text-muted">
              {gap === 0n
                ? 'Delegated against suggested'
                : `Delegated ${gap < 0n ? 'below' : 'above'} suggested`}
            </dt>
            {/* Colour reinforces the label, never replaces it. */}
            <dd className={`money font-semibold ${gap < 0n ? 'text-warning' : 'text-ink'}`}>
              {formatCents(gap < 0n ? -gap : gap)}
            </dd>
          </>
        )}
      </dl>

      {configured === null && (
        <p className="mt-2 text-quiet text-muted">
          This line is ad hoc, so Delegate adds nothing to it.
        </p>
      )}
    </section>
  );
}

export function Utilities(): ReactNode {
  const query = useQuery({
    queryKey: ['utilities'],
    queryFn: () => api.get<{ utilities: readonly UtilityDto[] }>('/api/utilities'),
  });

  const utilities = query.data?.utilities ?? [];
  const anyHistory = utilities.some((utility) => BigInt(utility.averageCents) !== 0n);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-page font-bold text-ink">Utilities</h1>
        <p className="mt-1 text-quiet text-muted">
          What each one averages, and what that is per paycheck. Suggestions only — nothing here
          changes an amount to delegate.
        </p>
      </header>

      {query.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : utilities.length === 0 ? (
        <p className="text-quiet text-muted">
          No delegations are marked as a utility yet. Turn on Utility in a line&rsquo;s row menu on
          the Budget page.
        </p>
      ) : (
        <>
          {!anyHistory && (
            <p className="mb-4 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-quiet text-accent">
              These averages need categorized history to mean anything. Until a backlog has been
              synced and categorized they will read zero.
            </p>
          )}

          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
            {utilities.map((utility) => (
              <UtilityCard key={utility.delegationId} utility={utility} />
            ))}
          </div>

          <p className="mt-4 text-quiet text-muted">
            A cycle is one of {CYCLES_PER_YEAR} paychecks a year. The average covers the completed
            months only — including the month in progress would make it collapse on the second and
            recover by the thirtieth.
          </p>
        </>
      )}
    </div>
  );
}
