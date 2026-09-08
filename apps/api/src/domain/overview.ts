import {
  buildBacklog,
  buildSpending,
  type SpendingEntry,
  type SpendingWindow,
} from './insights.js';
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

export const OVERVIEW_TILES = ['spending_by_grouping', 'uncategorized_backlog'] as const;

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

  const [spending, backlog] = await Promise.all([
    wanted.has('spending_by_grouping')
      ? buildSpending(
          db,
          { by: 'grouping', window: options.window, timeZone: options.timeZone },
          now,
        )
      : undefined,
    wanted.has('uncategorized_backlog') ? buildBacklog(db) : undefined,
  ]);

  return {
    ...(spending ? { spending_by_grouping: spending } : {}),
    ...(backlog ? { uncategorized_backlog: backlog } : {}),
  };
}
