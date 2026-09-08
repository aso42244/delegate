import type { Cents } from '@budget/shared';
import {
  buildBacklog,
  buildComposition,
  buildSpending,
  windowStart,
  type Composition,
  type SpendingEntry,
  type SpendingWindow,
} from './insights.js';
import { buildUtilities, type UtilitiesView } from './utilities.js';
import type { Db } from '../db/client.js';

/**
 * Overview: the tiles a person has, and only those.
 *
 * The page this replaces asks `GET /api/insights` and gets **everything** —
 * seven builders run on every request whether or not the caller has the widget
 * they feed, and again on every change of the time window. That is most of why
 * Insights feels slow, and it is not a rendering problem, so no amount of
 * redesign would have fixed it.
 *
 * The rule here is the opposite one: nothing is computed that nobody asked for.
 * `buildOverview` is given the caller's own tiles and dispatches per key, so a
 * page holding two tiles costs two queries' worth of work rather than seven.
 *
 * ## The catalogue grows a batch at a time
 *
 * `OVERVIEW_TILES` is deliberately *not* `INSIGHT_WIDGETS`. Overview replaces
 * Insights over several releases, porting tiles in batches, and a catalogue that
 * advertised all twenty-one from the first release would let somebody add a tile
 * this page cannot draw yet — which reads as a bug rather than as work in
 * progress. A key is added here in the release that can actually draw it.
 */

export const OVERVIEW_TILES = [
  // Batch A: everything drawn as a ranked bar or a composition. Grouped by what
  // has to be drawn rather than by subject, so one primitive is built once and
  // every tile that needs it gets it — rather than the same chart redesigned
  // five times under five names.
  'spending_by_grouping',
  'spending_by_delegation',
  'asset_debt_composition',
  'utilities_vs_delegated',
  'delegation_movers',

  'uncategorized_backlog',
] as const;

export type OverviewTileKey = (typeof OVERVIEW_TILES)[number];

export function isOverviewTile(value: string): value is OverviewTileKey {
  return (OVERVIEW_TILES as readonly string[]).includes(value);
}

export interface OverviewSpending {
  readonly entries: readonly SpendingEntry[];
  readonly since: Date | null;
  /**
   * "Everything" and "no cycle has been run yet" both have no start date and
   * mean opposite things, so the flag says which this is — one should show every
   * transaction and the other should show none.
   */
  readonly cycleMissing: boolean;
}

export interface OverviewBacklog {
  readonly count: number;
  readonly oldestPostedAt: Date | null;
}

export interface Mover {
  readonly delegationId: string;
  readonly name: string;
  readonly color: string | null;
  /** Signed: negative is a line that emptied over the window. */
  readonly changeCents: Cents;
}

/**
 * Which lines moved most over the window, and in which direction.
 *
 * Read from the nightly snapshots rather than from the ledger, because the
 * question is what a balance *was* on a past date — and that is exactly what
 * ADR 035 records nightly so it never has to be reconstructed again.
 *
 * Deliberately **not** the drill-down `/api/insights/snapshots/delegations`
 * uses. That returns a full point series per delegation so a chart can be drawn
 * through it; this tile shows one number per line, and fetching a quarter of
 * daily history to display a single difference is the shape of waste this whole
 * endpoint exists to stop.
 *
 * The change is last minus first **within the window**, not against today. A
 * line with no snapshot in the window has not been observed and is left out
 * rather than reported as zero — no movement and no evidence are different
 * answers, and only one of them is a fact.
 */
export async function buildMovers(
  db: Db,
  options: { readonly window: SpendingWindow; readonly timeZone: string },
  now: Date = new Date(),
): Promise<{ movers: Mover[]; cycleMissing: boolean }> {
  const start = await windowStart(db, options.window, options.timeZone, now);
  if (start.kind === 'no_cycle') return { movers: [], cycleMissing: true };

  const rows = await db.delegationSnapshot.findMany({
    where: {
      ...(start.kind === 'since' ? { snapshotDate: { gte: start.date } } : {}),
      delegation: { archivedAt: null },
    },
    orderBy: { snapshotDate: 'asc' },
    select: {
      delegationId: true,
      balanceCents: true,
      delegation: { select: { name: true, grouping: { select: { color: true } } } },
    },
  });

  // First and last per delegation, in one pass over rows already in date order.
  const seen = new Map<string, { first: Cents; last: Cents; name: string; color: string | null }>();
  for (const row of rows) {
    const existing = seen.get(row.delegationId);
    if (existing === undefined) {
      seen.set(row.delegationId, {
        first: row.balanceCents,
        last: row.balanceCents,
        name: row.delegation.name,
        color: row.delegation.grouping?.color ?? null,
      });
      continue;
    }
    existing.last = row.balanceCents;
  }

  const movers = [...seen.entries()].map(([delegationId, entry]) => ({
    delegationId,
    name: entry.name,
    color: entry.color,
    changeCents: entry.last - entry.first,
  }));

  /*
   * Ranked by size of movement, not by direction. The question is "what moved",
   * and a line that emptied by $400 is as interesting as one that filled by
   * $400 — sorting signed would bury every emptied line at the bottom, which is
   * the half somebody is usually looking for.
   */
  movers.sort((a, b) => {
    const left = a.changeCents < 0n ? -a.changeCents : a.changeCents;
    const right = b.changeCents < 0n ? -b.changeCents : b.changeCents;
    return right > left ? 1 : right < left ? -1 : a.name.localeCompare(b.name);
  });

  // A line that did not move is not a mover. It would otherwise pad the tile
  // with zero-length bars and push the real movement off the bottom.
  return { movers: movers.filter((mover) => mover.changeCents !== 0n), cycleMissing: false };
}

/**
 * Every key is optional, and an absent key means "not asked for" rather than
 * "empty".
 *
 * Those are different answers and the client has to be able to tell them apart:
 * a tile nobody has should render nothing at all, while a tile somebody has with
 * no data behind it should render its empty state. Collapsing the two would put
 * `No spending in this window.` on a page that was never asked to show spending.
 */
export interface OverviewData {
  readonly spending_by_grouping?: OverviewSpending;
  readonly spending_by_delegation?: OverviewSpending;
  readonly asset_debt_composition?: Composition;
  readonly utilities_vs_delegated?: UtilitiesView;
  readonly delegation_movers?: {
    readonly movers: readonly Mover[];
    readonly cycleMissing: boolean;
  };
  readonly uncategorized_backlog?: OverviewBacklog;
}

export async function buildOverview(
  db: Db,
  options: {
    readonly tiles: readonly OverviewTileKey[];
    readonly window: SpendingWindow;
    readonly timeZone: string;
  },
  now: Date = new Date(),
): Promise<OverviewData> {
  // A layout cannot hold a duplicate — `overview_tiles` has a unique index over
  // (user, widget) — but this is called with a list, and a list that arrived
  // from anywhere else must not cost the same query twice.
  const wanted = new Set<OverviewTileKey>(options.tiles);

  const [byGrouping, byDelegation, composition, utilities, movers, backlog] = await Promise.all([
    wanted.has('spending_by_grouping')
      ? buildSpending(
          db,
          { by: 'grouping', window: options.window, timeZone: options.timeZone },
          now,
        )
      : undefined,
    wanted.has('spending_by_delegation')
      ? buildSpending(
          db,
          { by: 'delegation', window: options.window, timeZone: options.timeZone },
          now,
        )
      : undefined,
    wanted.has('asset_debt_composition') ? buildComposition(db) : undefined,
    wanted.has('utilities_vs_delegated') ? buildUtilities(db, options.timeZone, now) : undefined,
    wanted.has('delegation_movers')
      ? buildMovers(db, { window: options.window, timeZone: options.timeZone }, now)
      : undefined,
    wanted.has('uncategorized_backlog') ? buildBacklog(db) : undefined,
  ]);

  return {
    ...(byGrouping ? { spending_by_grouping: byGrouping } : {}),
    ...(byDelegation ? { spending_by_delegation: byDelegation } : {}),
    ...(composition ? { asset_debt_composition: composition } : {}),
    ...(utilities ? { utilities_vs_delegated: utilities } : {}),
    ...(movers ? { delegation_movers: movers } : {}),
    ...(backlog ? { uncategorized_backlog: backlog } : {}),
  };
}
