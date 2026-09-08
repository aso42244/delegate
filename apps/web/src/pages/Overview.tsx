import { DEFAULT_OVERVIEW_SPAN, nextOverviewSpan, type OverviewSpan } from '@budget/shared';
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
import { CompositionBars, RankedBars, type RankedRow } from '../components/RankedBars.jsx';
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
  spending_by_delegation: { title: 'Spending by delegation' },
  asset_debt_composition: { title: 'What it is all made of' },
  utilities_vs_delegated: { title: 'Utilities against what they cost' },
  delegation_movers: { title: 'What moved' },
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
}: {
  readonly tileKey: string;
  readonly data: OverviewDataDto | undefined;
}): ReactNode {
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
              <TileBody tileKey={tile.key} data={data.data} />
            </TileShell>
          ))}
        </div>
      )}
    </>
  );
}
