import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';

/**
 * The ranked bar: Batch A's one drawing primitive.
 *
 * Five tiles on Overview are the same picture of different numbers — spending by
 * grouping, spending by delegation, what net worth is made of, what a utility is
 * funded at against what it costs, and which lines moved. Insights drew each of
 * those separately, which is how one chart came to have five slightly different
 * bar heights, three ways of showing a figure and two ideas about where the
 * label goes.
 *
 * Inline SVG is not used here and would be the wrong tool. A ranked bar is a row
 * of text and a filled box; HTML already lays that out, wraps it, truncates it
 * and hands it to a screen reader correctly, and an SVG version would have to
 * reimplement all four. `SnapshotChart` is SVG because a line through time is
 * not expressible in boxes — this is.
 *
 * Two rules the whole family follows.
 *
 * **The bar is scaled to the largest row, never to the total.** A bar meant to
 * be compared against its neighbours needs the widest one to fill the track, or
 * every row on a page with one dominant line is a stub against a rail of empty
 * space. Share of the whole is a number, and where it matters it is printed.
 *
 * **A figure never wraps.** design.md is explicit: a squeezed column broke
 * `+$3,527.63` after the sign and read as two numbers. The name gives way, the
 * figure does not.
 */

export interface RankedRow {
  readonly key: string;
  readonly name: string;
  /** The grouping's own colour where it has one, so the chart and the budget agree. */
  readonly color?: string | null;
  readonly valueCents: bigint;
  /** A second figure on the same row, for a comparison rather than a ranking. */
  /**
   * A small figure before the amount — a share, a count, a percentage.
   *
   * Text rather than cents, because it is not money: the allocation tile shows
   * each grouping's share of the whole, which the bar cannot say on its own
   * since bars here are scaled to the largest row rather than to the total.
   */
  readonly aside?: string;
  readonly compare?: {
    readonly label: string;
    readonly valueCents: bigint | null;
    /**
     * Marks the comparison rather than the ranking.
     *
     * One tile asks whether a figure is *wrong* rather than how big it is —
     * Recurring's per-cycle list, where the comparison is the whole question.
     * The colour is on the compared figure because that is the number somebody
     * would change, the same reasoning that puts a target's warning on the
     * amount to delegate rather than beside the name.
     */
    readonly tone?: 'warning';
  };
  /** Replaces the formatted figure, where the row states something else. */
  readonly note?: string;
  /**
   * The whole reading, one hover away.
   *
   * A ranked row is a name, a bar and a figure; where the figures have units
   * that the tile's own heading cannot carry for both of them, the sentence
   * that names them goes here rather than into a second line per row.
   */
  readonly title?: string;
}

/** Wider is more; a row states its own share only where the share is the point. */
function widthOf(value: bigint, peak: bigint): string {
  if (peak <= 0n) return '0%';
  const magnitude = value < 0n ? -value : value;
  // Integer arithmetic until the last step: a tenth of a percent is finer than
  // any screen resolves, so nothing is lost and no float touches the money.
  const tenths = Number((magnitude * 1000n) / peak) / 10;
  // A row that is present should be visible. Below about a pixel a bar reads as
  // an empty track, which says "nothing here" about a line that has something.
  return `${Math.max(tenths, 0.8)}%`;
}

function peakOf(rows: readonly RankedRow[]): bigint {
  return rows.reduce((max, row) => {
    const magnitude = row.valueCents < 0n ? -row.valueCents : row.valueCents;
    return magnitude > max ? magnitude : max;
  }, 0n);
}

/**
 * A plain ranking: name, bar, figure.
 *
 * `signed` draws the bar from a centre line instead of from the left, for the
 * one tile whose rows go both ways. Two directions on one axis is the whole
 * content of "which lines moved", and colouring a leftward bar red rather than
 * drawing it leftward would say it in a way somebody has to already know.
 */
export function RankedBars({
  rows,
  signed = false,
  emptyMessage,
}: {
  readonly rows: readonly RankedRow[];
  readonly signed?: boolean;
  readonly emptyMessage: string;
}): ReactNode {
  if (rows.length === 0) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  const peak = peakOf(rows);

  /*
   * The percentage column exists only where there are percentages.
   *
   * Reserved unconditionally it is 2.5rem of nothing on every tile that has no
   * share to show, pushing the figures in from the edge they should be sitting
   * on — and the tiles without one are most of them.
   */
  const hasAside = rows.some((row) => row.aside !== undefined);

  /*
   * The name gives, the figure never does.
   *
   * The name column was a flat 8rem, which is more than a third of a tile at
   * three to a row on a laptop — so the grid overflowed and the *amount* was
   * what got cut, leaving rows reading "$1,91". A truncated name is a name
   * somebody can still recognise; a truncated figure is a wrong number.
   *
   * `minmax(0, 6rem)` lets the name shrink before anything else moves, and
   * `max-content` on the figure means it is never the thing that gives. The bar
   * keeps a floor of its own: at three tiles to a row on a laptop the name and
   * the figure between them left it about sixty pixels, which is a bar nobody
   * can read a length off — so the name truncates further instead.
   */
  const columns = hasAside
    ? '[grid-template-columns:minmax(0,6rem)_minmax(2.5rem,1fr)_2rem_max-content]'
    : '[grid-template-columns:minmax(0,6rem)_minmax(2.5rem,1fr)_max-content]';

  return (
    /*
     * One grid for the whole list, not one per row.
     *
     * Every row used to carry its own `grid`, so `max-content` on the figure was
     * resolved against *that row's* figure — and the columns before it landed
     * wherever that left them. A list of percentages was ragged by up to eight
     * pixels down the column, which is the whole reason the share is in a column
     * of its own.
     *
     * `min-h-0` so it can be shorter than its rows, and scroll rather than
     * pushing the tile past the height somebody dragged it to.
     */
    <ul className={`grid min-h-0 list-none content-start overflow-y-auto p-0 gap-x-2 ${columns}`}>
      {rows.map((row) => {
        const negative = row.valueCents < 0n;
        const width = widthOf(row.valueCents, peak);
        // A grouping colour where there is one. Otherwise the semantic colour
        // carries the direction, and only where direction is part of the answer.
        const fill =
          row.color ??
          (signed
            ? negative
              ? 'var(--color-negative)'
              : 'var(--color-positive)'
            : 'var(--color-accent)');

        return (
          /*
           * Name, bar, figure — on one line.
           *
           * It was a name and a figure with the bar on a second line beneath
           * them, which is two rows of chrome per reading and about 44px a line.
           * The budget panel has always drawn the same thing at 28px on one
           * line, and it is the densest, most-read list in the application — so
           * this is that shape, and a tile now shows nine lines where it showed
           * five.
           *
           * A grid rather than flex: the bars have to start at the same x down
           * the column, which is what makes them comparable at a glance, and
           * that is a column definition rather than whatever each name happens
           * to be wide.
           */
          <li
            key={row.key}
            /* `subgrid` rather than `display: contents`, which drops the list
               semantics a screen reader needs. The row takes the list's tracks
               instead of computing its own. */
            className="row-cell col-span-full grid grid-cols-subgrid items-center gap-x-2"
            {...(row.title === undefined ? {} : { title: row.title })}
          >
            <span className="truncate text-quiet text-ink" title={row.name}>
              {row.name}
            </span>

            {/*
              A coloured bar inside a grey track, inset — the budget panel's
              construction, which is the one people read every day.

              The fill used to be the full height of the track, so a bar and its
              remainder were two blocks meeting at a hard edge and the eye read
              the *boundary* rather than the length. Inset, the track stays a
              track and the bar sits in it.

              Presentational: the figure beside it already says the value, and a
              second announcement of the same number is noise.
            */}
            <span className="relative block h-2 rounded bg-surface-2" aria-hidden="true">
              {signed ? (
                <span className="absolute inset-x-[2px] top-[2.5px] flex h-[3px]">
                  <span className="flex h-full w-1/2 justify-end">
                    {negative && (
                      <span className="block h-full rounded" style={{ width, background: fill }} />
                    )}
                  </span>
                  <span className="flex h-full w-1/2 justify-start">
                    {!negative && (
                      <span className="block h-full rounded" style={{ width, background: fill }} />
                    )}
                  </span>
                </span>
              ) : (
                <span
                  className="absolute top-[2.5px] left-[2px] block h-[3px] rounded"
                  style={{ width: `calc(${width} - 4px)`, minWidth: '2px', background: fill }}
                />
              )}
            </span>

            {/*
              A column of its own, fixed width and right-aligned.

              Beside the amount it moved with whatever the amount happened to be
              wide, so a column of percentages was ragged — 35% sat somewhere
              different from 3%. A grid column cannot do that.
            */}
            {hasAside && <span className="money text-micro text-muted">{row.aside ?? ''}</span>}

            {/*
              `justify-end`, because the column is now wider than most of what
              goes in it.

              While every row had its own grid, the figure's column was exactly
              as wide as that row's figure and there was nothing to align within.
              Shared across the list it is as wide as the *longest* figure, and a
              flex row lays its children out from the start — so `$153.00` sat
              against the left edge of a column sized for `$2,201.00`, with the
              `text-align: right` on the figure itself doing nothing, the span
              being only as wide as its own text.
            */}
            <span className="flex shrink-0 items-baseline justify-end gap-2">
              {row.compare !== undefined && (
                <span
                  className={`money text-micro ${
                    row.compare.tone === 'warning' ? 'font-semibold text-warning' : 'text-muted'
                  }`}
                >
                  {row.compare.valueCents === null ? '—' : formatCents(row.compare.valueCents)}
                  <span className="sr-only"> {row.compare.label}</span>
                </span>
              )}
              <span
                className={`money text-quiet font-semibold ${negative ? 'text-negative' : 'text-ink'}`}
              >
                {row.note ??
                  formatCents(row.valueCents, signed ? { explicitPlus: true } : undefined)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Two rankings under one heading, with the figure that reconciles them.
 *
 * Assets and debts are one question — what is this household worth — and
 * splitting them across two tiles put the answer nowhere. The net figure sits at
 * the foot rather than the head because it is the conclusion of the two lists
 * above it, and reading it first makes the lists look like supporting evidence
 * for a number rather than the thing being read.
 */
export function CompositionBars({
  assets,
  debts,
  netCents,
  emptyMessage,
}: {
  readonly assets: readonly RankedRow[];
  readonly debts: readonly RankedRow[];
  readonly netCents: bigint;
  readonly emptyMessage: string;
}): ReactNode {
  if (assets.length === 0 && debts.length === 0) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {assets.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-label uppercase tracking-[0.05em] text-muted">Assets</h3>
          <RankedBars rows={assets} emptyMessage={emptyMessage} />
        </div>
      )}
      {debts.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-label uppercase tracking-[0.05em] text-muted">Debts</h3>
          <RankedBars rows={debts} emptyMessage={emptyMessage} />
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2 border-t border-line pt-2">
        <span className="text-label uppercase tracking-[0.05em] text-muted">Net</span>
        <span
          className={`money text-hero font-bold ${netCents < 0n ? 'text-negative' : 'text-ink'}`}
        >
          {formatCents(netCents)}
        </span>
      </div>
    </div>
  );
}
