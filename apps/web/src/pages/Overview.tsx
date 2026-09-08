import {
  DEFAULT_OVERVIEW_SPAN,
  formatCents,
  nextOverviewSpan,
  type OverviewSpan,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  overviewApi,
  type OverviewDataDto,
  type OverviewLayoutDto,
  type OverviewTileDto,
} from '../api/overview.js';
import { EmptyState, PageHeader, SegmentedControl } from '../components/layout.jsx';
import { Alert, Button } from '../components/ui.jsx';

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
  uncategorized_backlog: { title: 'Waiting to be categorized' },
};

const SPAN_LABEL: Record<OverviewSpan, string> = {
  third: 'Third',
  half: 'Half',
  'two-thirds': 'Two-thirds',
  full: 'Full',
};

/**
 * The grid column count for a span.
 *
 * Written as whole class names rather than built from the number, because
 * Tailwind reads the source for the classes it emits and an interpolated one is
 * a class that exists in the browser's stylesheet nowhere.
 */
const SPAN_CLASS: Record<OverviewSpan, string> = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-3',
  'two-thirds': 'lg:col-span-4',
  full: 'lg:col-span-6',
};

function TileShell({
  tile,
  arranging,
  onMove,
  onResize,
  onRemove,
  children,
}: {
  readonly tile: OverviewTileDto;
  readonly arranging: boolean;
  readonly onMove: (step: -1 | 1) => void;
  readonly onResize: () => void;
  readonly onRemove: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const copy = TILE_COPY[tile.key] ?? { title: tile.key };

  return (
    <section
      className={`col-span-1 flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-canvas p-4 ${
        SPAN_CLASS[tile.span]
      }`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="truncate text-section font-semibold text-ink">{copy.title}</h2>
        {copy.description !== undefined && (
          <p className="truncate text-quiet text-muted">{copy.description}</p>
        )}
        {arranging && (
          /*
           * Every control names the tile it acts on.
           *
           * A grid of tiles each carrying "Move earlier" gives a screen reader a
           * column of identical names with nothing to tell them apart, and the
           * arrows are glyphs, so the accessible name is the only name there is.
           * `Remove Assets and debts` is the convention Insights already uses.
           * The width button keeps its visible label inside its accessible name,
           * so what is read matches what is on it.
           */
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* The width control is meaningless on a phone, where every tile is
                full width — hidden rather than disabled, because a control that
                cannot do anything on this screen is not a state to explain. */}
            <Button
              variant="ghost"
              onClick={onResize}
              aria-label={`Width of ${copy.title}: ${SPAN_LABEL[tile.span]}`}
              className="hidden lg:inline-flex"
            >
              {SPAN_LABEL[tile.span]}
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

/** Ranked bars in each grouping's own colour, so the chart and the budget agree. */
function SpendingTile({ data }: { readonly data: OverviewDataDto }): ReactNode {
  const spending = data.spending_by_grouping;
  if (!spending) return null;

  if (spending.cycleMissing) {
    return <EmptyState>No cycle has been run yet.</EmptyState>;
  }
  if (spending.entries.length === 0) {
    return <EmptyState>Nothing categorized in this window.</EmptyState>;
  }

  const amounts = spending.entries.map((entry) => BigInt(entry.spendCents));
  const peak = amounts.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <div className="flex flex-col gap-2">
      {spending.entries.map((entry, index) => {
        const value = amounts[index]!;
        // Integer arithmetic throughout — the percentage is a width, and the
        // only place a bigint becomes a number is after the division.
        const share = peak === 0n ? 0 : Number((value * 1000n) / peak) / 10;
        return (
          <div key={entry.key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-base text-ink">{entry.name}</span>
              <span className="money shrink-0 font-semibold">{formatCents(value)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-surface-2">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max(share, 1)}%`,
                  background: entry.color ?? 'var(--color-group-grey)',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One figure, and the sentence that says what to do about it. */
function BacklogTile({ data }: { readonly data: OverviewDataDto }): ReactNode {
  const backlog = data.uncategorized_backlog;
  if (!backlog) return null;

  if (backlog.count === 0) {
    return <EmptyState>Nothing waiting.</EmptyState>;
  }

  const oldest = backlog.oldestPostedAt;
  const days =
    oldest === null
      ? null
      : Math.floor((Date.now() - new Date(oldest).getTime()) / (24 * 60 * 60 * 1000));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-hero font-bold text-warning tabular-nums">{backlog.count}</span>
        <span className="text-quiet text-muted">
          {days === null ? 'Waiting to be categorized.' : `Waiting, oldest ${days}d.`}
        </span>
      </div>
      <Link
        to="/transactions?uncategorized=true"
        className="text-quiet font-semibold text-accent hover:underline"
      >
        Open the queue →
      </Link>
    </div>
  );
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

  const tiles = useMemo(() => layout.data?.tiles ?? [], [layout.data]);

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
      const before = (context?.previous?.tiles ?? []).map((tile) => tile.key).sort();
      const after = next.map((tile) => tile.key).sort();
      if (before.join(String.fromCharCode(0)) !== after.join(String.fromCharCode(0))) {
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

  function move(index: number, step: -1 | 1): void {
    const target = index + step;
    if (target < 0 || target >= tiles.length) return;
    const next = [...tiles];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    save.mutate(next);
  }

  function resize(index: number): void {
    const next = tiles.map((tile, position) =>
      position === index ? { ...tile, span: nextOverviewSpan(tile.span) } : tile,
    );
    save.mutate(next);
  }

  function remove(index: number): void {
    save.mutate(tiles.filter((_tile, position) => position !== index));
  }

  function add(key: string): void {
    // The data refetch is in `onSuccess`, not here — see the mutation.
    save.mutate([...tiles, { key, span: DEFAULT_OVERVIEW_SPAN, display: null }]);
  }

  const available = (layout.data?.catalog ?? []).filter(
    (key) => !tiles.some((tile) => tile.key === key),
  );

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          tiles.length === 0
            ? 'No tiles yet.'
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
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="text-quiet text-muted">Add a tile:</span>
          {available.map((key) => (
            <Button key={key} variant="ghost" onClick={() => add(key)}>
              {TILE_COPY[key]?.title ?? key}
            </Button>
          ))}
        </div>
      )}

      {layout.isPending || data.isPending ? null : tiles.length === 0 ? (
        <EmptyState>No tiles yet.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
          {tiles.map((tile, index) => (
            <TileShell
              key={tile.key}
              tile={tile}
              arranging={arranging}
              onMove={(step) => move(index, step)}
              onResize={() => resize(index)}
              onRemove={() => remove(index)}
            >
              {tile.key === 'spending_by_grouping' && data.data && (
                <SpendingTile data={data.data} />
              )}
              {tile.key === 'uncategorized_backlog' && data.data && (
                <BacklogTile data={data.data} />
              )}
            </TileShell>
          ))}
        </div>
      )}
    </>
  );
}
