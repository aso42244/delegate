import { formatCents } from '@budget/shared';
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
  | 'cycle_surplus';

const WIDGET_TITLES: Record<WidgetKey, string> = {
  asset_debt_composition: 'Assets and debts',
  spending_by_grouping: 'Spending by grouping',
  spending_by_delegation: 'Spending by delegation',
  delegations_negative: 'Delegations currently negative',
  uncategorized_backlog: 'Uncategorized',
  utilities_vs_delegated: 'Utilities: average against funded',
  income_vs_spending: 'Income against spending',
  cycle_surplus: 'Cycle surplus and deficit',
};

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

function Card({
  title,
  onRemove,
  children,
}: {
  readonly title: string;
  readonly onRemove: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${title}`}
          className="text-quiet text-muted"
        >
          ×
        </button>
      </header>
      {children}
    </section>
  );
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
    queryFn: () => api.get<{ catalog: WidgetKey[]; chosen: WidgetKey[] }>('/api/insights/layout'),
  });

  const data = useQuery({
    queryKey: ['insights', window],
    queryFn: () => api.get<InsightsDto>(`/api/insights?window=${window}`),
  });

  const save = useMutation({
    mutationFn: (widgets: readonly WidgetKey[]) =>
      api.put<{ ok: boolean }>('/api/insights/layout', { widgets }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['insights', 'layout'] });
    },
  });

  const catalog = layout.data?.catalog ?? [];
  // Before anything has been chosen the page shows the whole catalog, so it is
  // useful on first visit rather than blank with a button on it.
  const chosen = layout.data ? (layout.data.chosen.length > 0 ? layout.data.chosen : catalog) : [];

  function remove(key: WidgetKey): void {
    save.mutate(chosen.filter((widget) => widget !== key));
  }

  function add(key: WidgetKey): void {
    save.mutate([...chosen, key]);
  }

  const insights = data.data;

  function render(key: WidgetKey): ReactNode {
    if (!insights) return null;

    switch (key) {
      case 'asset_debt_composition': {
        const composition = insights.asset_debt_composition;
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

      case 'spending_by_grouping':
        return (
          <RankedBars
            entries={insights.spending_by_grouping.entries}
            emptyNote={
              insights.spending_by_grouping.since === null
                ? 'No Delegate press yet, so there is no cycle to report on.'
                : 'Nothing categorized in this window yet.'
            }
          />
        );

      case 'spending_by_delegation':
        return (
          <RankedBars
            entries={insights.spending_by_delegation.entries}
            emptyNote={
              insights.spending_by_delegation.since === null
                ? 'No Delegate press yet, so there is no cycle to report on.'
                : 'Nothing categorized in this window yet.'
            }
          />
        );

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

      case 'income_vs_spending':
      case 'cycle_surplus':
        return insights.income_vs_spending.length === 0 ? (
          <p className="text-quiet text-muted">
            No Delegate press yet, so there are no cycles to compare.
          </p>
        ) : (
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

  const available = catalog.filter((key) => !chosen.includes(key));

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
          {chosen.map((key) => (
            <Card key={key} title={WIDGET_TITLES[key]} onRemove={() => remove(key)}>
              {render(key)}
            </Card>
          ))}

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
