import {
  formatCents,
  isEstimated,
  PROVENANCE_NOTES,
  type SnapshotProvenance,
} from '@budget/shared';
import type { ReactNode } from 'react';

/**
 * The time series: Batch B's one drawing primitive.
 *
 * Seven tiles on Overview are a line or a stack through the nightly snapshots.
 * SVG here rather than the boxes `RankedBars` uses, and the split is not
 * arbitrary: a ranked bar is a row of text and a filled rectangle, which HTML
 * already lays out and hands to a screen reader correctly, while a line through
 * time is not expressible in boxes at all.
 *
 * Three things it says that a plain line would not, all of them ADR 035's:
 *
 * **Where a figure came from.** A segment drawn through estimated days is dashed
 * and muted with the reason on hover. Observed, reconstructed and carried days
 * are exact and draw solid — they still say so on hover, because "this is exact"
 * is worth knowing too. A bucket takes the weakest provenance in it: a line
 * through a week is no better than its worst day.
 *
 * **That it ends on now.** Snapshots are labelled for the previous day, so every
 * series would otherwise stop a day short and read as stale. The live point is a
 * hollow marker on a dashed final segment — current state, not something
 * anybody recorded.
 *
 * **That it has nothing yet.** History starts at the first night and gains a day
 * a night, with no backfill. One sentence, not an axis drawn through a single
 * dot.
 */

export interface TimePoint {
  readonly date: string;
  readonly provenance: SnapshotProvenance;
  /** Keyed by series. Cents as bigint — parsed once, at the page edge. */
  readonly values: Readonly<Record<string, bigint>>;
}

export interface TimeSeriesDef {
  readonly key: string;
  readonly name: string;
  /** The grouping's own colour where it has one; otherwise the palette below. */
  readonly color?: string | null;
}

/** design.md's ordered multi-series palette, as tokens so a theme can lift it. */
const SERIES_TOKENS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

/** One line is the accent. A single series does not need a palette. */
function colorFor(series: TimeSeriesDef, index: number, total: number): string {
  if (series.color) return series.color;
  if (total === 1) return 'var(--color-accent)';
  return SERIES_TOKENS[index % SERIES_TOKENS.length] ?? 'var(--color-accent)';
}

const VIEW = { width: 320, height: 120 };
const PAD = { top: 6, right: 6, bottom: 6, left: 6 };

interface Scale {
  x(index: number, length: number): number;
  y(value: bigint): number;
}

/**
 * The extent, and whether zero has to be inside it.
 *
 * A drift chart is read *against* zero, so zero belongs on it even when every
 * point is above — otherwise a line hovering at $4 and one hovering at $400 draw
 * identically and the whole point of the chart is lost.
 */
function scaleFor(values: readonly bigint[], includeZero: boolean): Scale {
  let low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
  let high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);

  if (includeZero) {
    if (low > 0n) low = 0n;
    if (high < 0n) high = 0n;
  }
  // A flat line has no extent, and dividing by it would put every point at the
  // top. Give it a band so it draws through the middle, which is what flat is.
  if (high === low) {
    high = high + 1n;
    low = low - 1n;
  }

  const span = high - low;
  const plotW = VIEW.width - PAD.left - PAD.right;
  const plotH = VIEW.height - PAD.top - PAD.bottom;

  return {
    x(index, length) {
      if (length <= 1) return PAD.left + plotW / 2;
      return PAD.left + (index * plotW) / (length - 1);
    },
    y(value) {
      // Integer until the last step; the ratio is the only float and it is a
      // screen coordinate rather than money.
      const above = Number(value - low);
      return PAD.top + plotH - (above / Number(span)) * plotH;
    },
  };
}

/** A run of points sharing whether they are estimated, so a dash covers exactly it. */
interface Segment {
  readonly from: number;
  readonly to: number;
  readonly estimated: boolean;
  readonly note: string;
}

function segmentsOf(points: readonly TimePoint[]): Segment[] {
  const runs: Segment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    // A segment spans two points, so it is estimated if either end is. Drawing
    // it solid because one end was observed would overstate the weaker half.
    const estimated = isEstimated(previous.provenance) || isEstimated(current.provenance);
    const note = estimated
      ? PROVENANCE_NOTES[isEstimated(current.provenance) ? current.provenance : previous.provenance]
      : PROVENANCE_NOTES[current.provenance];
    const last = runs[runs.length - 1];
    if (last && last.estimated === estimated && last.to === index - 1) {
      runs[runs.length - 1] = { ...last, to: index };
      continue;
    }
    runs.push({ from: index - 1, to: index, estimated, note });
  }
  return runs;
}

function pathFor(
  points: readonly TimePoint[],
  key: string,
  scale: Scale,
  from: number,
  to: number,
): string {
  const parts: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const value = points[index]?.values[key] ?? 0n;
    parts.push(
      `${index === from ? 'M' : 'L'}${scale.x(index, points.length).toFixed(2)},${scale
        .y(value)
        .toFixed(2)}`,
    );
  }
  return parts.join(' ');
}

/**
 * One or more lines through time.
 *
 * `live` is the figure as it is right now, appended as a hollow marker on a
 * dashed final segment — kept visually apart from the stored points because it
 * is not one of them.
 */
export function TimeSeriesChart({
  points,
  series,
  live,
  includeZero = false,
  emptyMessage,
  label,
}: {
  readonly points: readonly TimePoint[];
  readonly series: readonly TimeSeriesDef[];
  readonly live?: Readonly<Record<string, bigint>> | null;
  /** For a chart read against zero — drift, or anything that can go negative. */
  readonly includeZero?: boolean;
  readonly emptyMessage: string;
  /** What the chart is, for a screen reader. */
  readonly label: string;
}): ReactNode {
  if (points.length === 0) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  // The live point extends the series, so it has to be inside the extent or the
  // marker lands outside the box.
  const withLive: TimePoint[] =
    live == null ? [...points] : [...points, { date: 'now', provenance: 'observed', values: live }];

  const every = withLive.flatMap((point) => series.map((entry) => point.values[entry.key] ?? 0n));
  const scale = scaleFor(every, includeZero);
  const segments = segmentsOf(points);

  const first = points[0];
  const last = withLive[withLive.length - 1];
  const summary = series
    .map((entry) => {
      const from = first?.values[entry.key] ?? 0n;
      const to = last?.values[entry.key] ?? 0n;
      return `${entry.name} from ${formatCents(from)} to ${formatCents(to)}`;
    })
    .join('; ');

  const zeroY = scale.y(0n);
  const showZero = includeZero;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`${label}. ${summary}.`}
      >
        {showZero && (
          <line
            x1={PAD.left}
            x2={VIEW.width - PAD.right}
            y1={zeroY}
            y2={zeroY}
            style={{ stroke: 'var(--color-line)' }}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {series.map((entry, index) => {
          const stroke = colorFor(entry, index, series.length);
          const single = series.length === 1;
          const area =
            single && !includeZero
              ? `${pathFor(points, entry.key, scale, 0, points.length - 1)} L${scale
                  .x(points.length - 1, points.length)
                  .toFixed(2)},${(VIEW.height - PAD.bottom).toFixed(2)} L${scale
                  .x(0, points.length)
                  .toFixed(2)},${(VIEW.height - PAD.bottom).toFixed(2)} Z`
              : null;

          return (
            <g key={entry.key}>
              {area !== null && (
                <path d={area} style={{ fill: stroke, fillOpacity: 0.1 }} stroke="none" />
              )}
              {segments.map((segment) => (
                <path
                  key={`${entry.key}-${segment.from}`}
                  d={pathFor(points, entry.key, scale, segment.from, segment.to)}
                  style={{ fill: 'none', stroke, strokeOpacity: segment.estimated ? 0.55 : 1 }}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  {...(segment.estimated ? { strokeDasharray: '4 3' } : {})}
                >
                  <title>{segment.note}</title>
                </path>
              ))}
              {live != null && points.length > 0 && (
                <>
                  <path
                    d={`M${scale.x(points.length - 1, withLive.length).toFixed(2)},${scale
                      .y(points[points.length - 1]?.values[entry.key] ?? 0n)
                      .toFixed(2)} L${scale
                      .x(withLive.length - 1, withLive.length)
                      .toFixed(2)},${scale.y(live[entry.key] ?? 0n).toFixed(2)}`}
                    style={{ fill: 'none', stroke }}
                    strokeWidth="2"
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={scale.x(withLive.length - 1, withLive.length)}
                    cy={scale.y(live[entry.key] ?? 0n)}
                    r="3"
                    style={{ fill: 'var(--color-canvas)', stroke }}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>Today, not yet recorded</title>
                  </circle>
                </>
              )}
            </g>
          );
        })}
      </svg>

      {/* The figures as text. §9: never by colour alone, and never by shape
          alone either — a line nobody can read is a line that says nothing. */}
      <figcaption className="flex flex-wrap items-baseline gap-4">
        {series.map((entry, index) => (
          <span key={entry.key} className="flex items-baseline gap-2 text-quiet">
            <i
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ background: colorFor(entry, index, series.length) }}
            />
            <span className="text-muted">{entry.name}</span>
            <span className="money font-semibold text-ink">
              {formatCents(last?.values[entry.key] ?? 0n)}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
