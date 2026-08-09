import { formatCents } from '@budget/shared';
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
function MiniChart({ months }: { readonly months: readonly MonthDto[] }): ReactNode {
  const values = months.map((month) => BigInt(month.spendCents));
  const peak = values.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <div className="flex h-16 items-end gap-1" aria-hidden>
      {months.map((month, index) => {
        const value = values[index] ?? 0n;
        // Percentages as numbers only for layout — never for money.
        const height = peak <= 0n ? 0 : Number((value * 100n) / peak);

        return (
          <div
            key={month.month}
            className="flex-1 rounded-sm bg-accent"
            style={{
              height: `${Math.max(height, value > 0n ? 4 : 0)}%`,
              opacity: month.complete ? 1 : 0.28,
            }}
          />
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

  // The comparison the page exists for: is this line under- or over-funded?
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

      <MiniChart months={utility.months} />

      <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <dt className="text-label uppercase tracking-[0.05em] text-muted">Monthly average</dt>
          <dd className="money text-hero font-bold text-ink">{formatCents(average)}</dd>
        </div>
        <div>
          <dt className="text-label uppercase tracking-[0.05em] text-muted">Suggested per cycle</dt>
          <dd className="money text-base text-ink">{formatCents(suggested)}</dd>
        </div>
        <div>
          <dt className="text-label uppercase tracking-[0.05em] text-muted">Currently</dt>
          <dd className="money text-base text-muted">
            {configured === null ? '—' : formatCents(configured)}
          </dd>
        </div>
      </dl>

      {/* Said in words rather than by colour, and never acted on automatically. */}
      {gap !== null && gap !== 0n && (
        <p className="mt-2 text-quiet text-muted">
          {gap < 0n
            ? `Funded ${formatCents(-gap)} per cycle below the suggestion.`
            : `Funded ${formatCents(gap)} per cycle above the suggestion.`}
        </p>
      )}
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
          the Main Budget.
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
            The average covers the completed months only. Including the month in progress would make
            it collapse on the second and recover by the thirtieth.
          </p>
        </>
      )}
    </div>
  );
}
