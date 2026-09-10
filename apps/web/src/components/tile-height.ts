import { createContext, useContext } from 'react';

/**
 * How tall this tile's row is, in pixels — or `undefined` where nothing has set
 * a height and the tile is as tall as its content.
 *
 * **This is a stored number, never a measurement.** A chart that lays itself out
 * to the room available must not read that room back off the page: the box it is
 * drawn into is as tall as the drawing, so the answer depends on the question,
 * and each pass adds whatever slack the last one left. The Cashflow chart did
 * exactly that twice — measuring its own container, then measuring the tile body
 * around it — and both times ran past 3,800px from a row somebody had just
 * dragged *shorter*.
 *
 * So the figure comes from the layout the household saved. It cannot feed back,
 * because nothing about the drawing can change it.
 */
export const TileRowHeight = createContext<number | undefined>(undefined);

/** The room a tile's content has, allowing for the shell drawn around it. */
export function useTileRoom(): number | undefined {
  const row = useContext(TileRowHeight);
  return row === undefined ? undefined : Math.max(0, row - TILE_CHROME);
}

/**
 * The tile's own furniture: 16px of padding top and bottom, a heading of about
 * 24, and the 16px gap under it.
 *
 * A constant rather than a measurement, and deliberately so — see above. It is
 * approximate, and being a few pixels out costs a few pixels of chart.
 */
const TILE_CHROME = 72;
