/**
 * The Overview grid: rows, and the widths they imply.
 *
 * A tile does not declare a width. It belongs to a **row**, and a row divides
 * itself evenly among its members — one tile is full width, two are halves,
 * three are thirds, four are quarters.
 *
 * This replaced a per-tile `span` borrowed from `SettingsCard`
 * (`third`/`half`/`two-thirds`/`full`). That vocabulary is right for a page of
 * independent cards and wrong for a dashboard, because it cannot express *these
 * three share a row*: two tiles each declaring `half` only look like a row by
 * coincidence, and inserting a third between them produces an arrangement
 * nobody asked for. Stating the relationship and deriving the width means the
 * two can never disagree.
 *
 * **Twelve columns, not six.** Twelve divides by 1, 2, 3 and 4 with nothing left
 * over; six cannot express a quarter without half a column.
 *
 * A phone ignores every bit of this and stacks tiles full width in row order —
 * which is what lets one stored arrangement serve both screens.
 */

/**
 * Where a tile lives.
 *
 * Two regions of different shapes: the main grid takes up to two tiles a row,
 * and the sidebar is a single column beneath the budget panel — one tile a row,
 * always, because it is about 400px wide and two tiles in that is neither.
 */
export const OVERVIEW_REGIONS = ['main', 'sidebar'] as const;
export type OverviewRegion = (typeof OVERVIEW_REGIONS)[number];

export function isOverviewRegion(value: string): value is OverviewRegion {
  return (OVERVIEW_REGIONS as readonly string[]).includes(value);
}

/** How many tiles a row of each region can hold. */
export function maxPerRowIn(region: OverviewRegion): number {
  return region === 'sidebar' ? 1 : MAX_TILES_PER_ROW;
}

/** Columns in the desktop grid. */
export const OVERVIEW_COLUMNS = 12;

/**
 * The most tiles one row can hold.
 *
 * **Three**, and it is arithmetic rather than a preference.
 *
 * A ranked bar with a name and a figure stops being readable at about 300px.
 * The cap was four while the tiles had the whole 1200px; it fell to two when the
 * budget panel took the right-hand 398px, because a 1440px window then left
 * roughly 1000px for tiles and a third of that is 330px — only just clear.
 *
 * The page cap moved to 1600px, so a wide window leaves about 1180px beside the
 * panel: a third is 390px, comfortably over the floor, and a quarter is 295px,
 * which is not. Three.
 *
 * A tile that wants to be small can still share a row; one that wants to be
 * readable can have the row to itself.
 */
export const MAX_TILES_PER_ROW = 3;

/**
 * How many columns each tile in a row of `size` takes.
 *
 * Twelve divides by one, two, three and four with nothing left over, which is
 * why the grid is twelve columns and not ten.
 */
export function columnsForRow(size: number): number {
  const clamped = Math.min(Math.max(size, 1), MAX_TILES_PER_ROW);
  return OVERVIEW_COLUMNS / clamped;
}

export interface RowMember<T> {
  readonly row: number;
  readonly tile: T;
}

/**
 * Groups tiles into their rows, in order, renumbering as it goes.
 *
 * Renumbering rather than trusting the stored numbers: a row emptied by removing
 * its last tile leaves a gap, and a gap is not a row. The stored value orders
 * rows; it does not name them.
 */
export function groupIntoRows<T extends { readonly row: number }>(tiles: readonly T[]): T[][] {
  const rows = new Map<number, T[]>();
  for (const tile of tiles) {
    const existing = rows.get(tile.row);
    if (existing) existing.push(tile);
    else rows.set(tile.row, [tile]);
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

/**
 * Flattens rows back into storable tiles, numbering rows from zero and each
 * tile's position from zero within its row.
 *
 * The whole arrangement is written at once — see the route — so this is the one
 * place the numbers are decided, and nothing else needs to know how they work.
 */
export function flattenRows<T>(
  rows: readonly (readonly T[])[],
): { row: number; position: number; tile: T }[] {
  const flat: { row: number; position: number; tile: T }[] = [];
  rows
    .filter((row) => row.length > 0)
    .forEach((row, rowIndex) => {
      row.slice(0, MAX_TILES_PER_ROW).forEach((tile, position) => {
        flat.push({ row: rowIndex, position, tile });
      });
    });
  return flat;
}

/**
 * What the figures band shows before anybody opens its picker.
 *
 * Inflow, spent and left are the three the page exists to answer. The fourth is
 * the backlog rather than a fifth money figure, because it is the only number
 * here somebody can *act* on — and until it is worked, every other figure on the
 * page is wrong by whatever it holds.
 */
export const DEFAULT_FIGURES = ['inflow', 'spent', 'left_to_spend', 'uncategorized'] as const;
