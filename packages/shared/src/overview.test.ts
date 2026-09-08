import { describe, expect, it } from 'vitest';
import {
  columnsForRow,
  flattenRows,
  groupIntoRows,
  MAX_TILES_PER_ROW,
  OVERVIEW_COLUMNS,
} from './overview.js';

describe('the overview grid', () => {
  it('divides evenly for every row size it allows', () => {
    // Twelve columns exist so that 1, 2, 3 and 4 all divide with nothing left
    // over. Six could not express a quarter without half a column.
    for (let size = 1; size <= MAX_TILES_PER_ROW; size += 1) {
      const columns = columnsForRow(size);
      expect(Number.isInteger(columns)).toBe(true);
      expect(columns * size).toBe(OVERVIEW_COLUMNS);
    }
  });

  it('clamps a row that somehow holds more than it should', () => {
    // A stored arrangement outlives the rule that made it. Five in a row must
    // still draw as something rather than as a division by a number the grid
    // cannot express.
    expect(columnsForRow(5)).toBe(columnsForRow(MAX_TILES_PER_ROW));
    expect(columnsForRow(0)).toBe(OVERVIEW_COLUMNS);
  });

  it('groups tiles into rows in row order', () => {
    const rows = groupIntoRows([
      { row: 1, key: 'c' },
      { row: 0, key: 'a' },
      { row: 0, key: 'b' },
    ]);
    expect(rows.map((row) => row.map((tile) => tile.key))).toEqual([['a', 'b'], ['c']]);
  });

  it('closes a gap left by an emptied row', () => {
    // Removing a row's last tile leaves a hole in the numbering, and a hole is
    // not a row. The stored value orders rows; it does not name them.
    const rows = groupIntoRows([
      { row: 0, key: 'a' },
      { row: 7, key: 'b' },
    ]);
    expect(rows).toHaveLength(2);

    const flat = flattenRows(rows);
    expect(flat.map((entry) => entry.row)).toEqual([0, 1]);
  });

  it('numbers each tile from zero within its own row', () => {
    const flat = flattenRows([['a', 'b'], ['c']]);
    expect(flat).toEqual([
      { row: 0, position: 0, tile: 'a' },
      { row: 0, position: 1, tile: 'b' },
      { row: 1, position: 0, tile: 'c' },
    ]);
  });

  it('drops an empty row rather than numbering it', () => {
    const flat = flattenRows([['a'], [], ['b']]);
    expect(flat.map((entry) => entry.row)).toEqual([0, 1]);
  });

  it('refuses to put more than four in one row', () => {
    const flat = flattenRows([['a', 'b', 'c', 'd', 'e']]);
    expect(flat).toHaveLength(MAX_TILES_PER_ROW);
  });
});
