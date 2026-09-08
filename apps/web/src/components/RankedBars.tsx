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
  readonly compare?: { readonly label: string; readonly valueCents: bigint | null };
  /** Replaces the formatted figure, where the row states something else. */
  readonly note?: string;
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

  return (
    <ul className="flex list-none flex-col gap-2 p-0">
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
          <li key={row.key} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-base text-ink" title={row.name}>
                {row.name}
              </span>
              {row.compare !== undefined && (
                <span className="money shrink-0 text-quiet text-muted">
                  {row.compare.valueCents === null ? '—' : formatCents(row.compare.valueCents)}
                  <span className="sr-only"> {row.compare.label}</span>
                </span>
              )}
              <span
                className={`money shrink-0 font-semibold ${negative ? 'text-negative' : 'text-ink'}`}
              >
                {row.note ??
                  formatCents(row.valueCents, signed ? { explicitPlus: true } : undefined)}
              </span>
            </div>

            {/* The track is the axis. On a signed chart the centre is the zero
                line, so a bar's side is its sign — read before any figure is. */}
            <div
              className="h-2 overflow-hidden rounded bg-surface-2"
              // Presentational: the figure beside it already says the value, and
              // a second announcement of the same number is noise.
              aria-hidden="true"
            >
              {signed ? (
                <div className="flex h-full w-full">
                  <div className="flex h-full w-1/2 justify-end">
                    {negative && (
                      <div className="h-full rounded-l" style={{ width, background: fill }} />
                    )}
                  </div>
                  <div className="flex h-full w-1/2 justify-start">
                    {!negative && (
                      <div className="h-full rounded-r" style={{ width, background: fill }} />
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full rounded" style={{ width, background: fill }} />
              )}
            </div>
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
