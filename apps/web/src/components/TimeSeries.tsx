import {
  formatCents,
  isEstimated,
  PROVENANCE_NOTES,
  type SnapshotProvenance,
} from '@budget/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

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
 * series would otherwise stop a day short and read as stale. The live figure is
 * the line's last point, drawn like any other, and the axis names it Today. It
 * was a hollow marker on a dashed segment, which read as a fault rather than as
 * the present.
 *
 * **What it is measuring.** Two quiet axes: round figures up the left with a
 * hairline at each, and the first, middle and last dates along the bottom. Small
 * and muted — enough to say "$240k to $270k since July", no more.
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

/** Until the box has been measured, and the floor below which it never draws. */
const FALLBACK = { width: 320, height: 128 };

/** Room for the date labels under the plot, and breathing room above it. */
const BOTTOM = 18;
const TOP = 6;
const RIGHT = 6;
/** Roughly one character of `text-micro` figures, for the left gutter. */
const CHAR = 6;

interface Scale {
  x(index: number, length: number): number;
  y(value: bigint): number;
  readonly ticks: readonly bigint[];
  readonly labels: readonly string[];
  readonly left: number;
  readonly bottom: number;
}

/**
 * A round step for about `count` gaps across `span` cents: 1, 2 or 5 of a power
 * of ten. In cents and in bigint, so an axis label is a whole number of dollars
 * that money arithmetic produced rather than a float that happened to land there.
 */
function niceStep(span: bigint, count: bigint): bigint {
  const rough = span / count > 0n ? span / count : 1n;
  let power = 1n;
  while (power * 10n <= rough) power *= 10n;
  for (const multiple of [1n, 2n, 5n]) {
    if (multiple * power >= rough) return multiple * power;
  }
  return 10n * power;
}

function floorTo(value: bigint, step: bigint): bigint {
  const remainder = value % step;
  return remainder === 0n ? value : value < 0n ? value - remainder - step : value - remainder;
}

function ceilTo(value: bigint, step: bigint): bigint {
  const floored = floorTo(value, step);
  return floored === value ? value : floored + step;
}

/**
 * `$265k`, `$1.2M`, `-$480` — a figure short enough for an axis.
 *
 * `decimals` is how many places after the unit, for an axis whose step is finer
 * than the unit: $11.5k and $12k are different labels, and rounding both to
 * "$12k" says the axis is flat. Integer arithmetic throughout — the decimals are
 * a remainder, not a float.
 */
export function compactCents(cents: bigint, decimals = 0): string {
  const sign = cents < 0n ? '-' : '';
  const dollars = (cents < 0n ? -cents : cents) / 100n;
  const scaled = (unit: bigint, suffix: string): string => {
    const whole = dollars / unit;
    if (decimals === 0) return `${sign}$${whole}${suffix}`;
    const places = 10n ** BigInt(decimals);
    const fraction = ((dollars % unit) * places) / unit;
    const text = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return text === '' ? `${sign}$${whole}${suffix}` : `${sign}$${whole}.${text}${suffix}`;
  };
  if (dollars >= 1_000_000n) return scaled(1_000_000n, 'M');
  if (dollars >= 1_000n) return scaled(1_000n, 'k');
  return `${sign}$${dollars}`;
}

/** The fewest decimals at which every tick reads differently. */
function tickLabels(ticks: readonly bigint[]): string[] {
  for (const decimals of [0, 1, 2]) {
    const labels = ticks.map((tick) => compactCents(tick, decimals));
    if (new Set(labels).size === labels.length) return labels;
  }
  return ticks.map((tick) => formatCents(tick, { cents: false }));
}

/**
 * The extent, rounded out to whole steps so the axis can label it, and whether
 * zero has to be inside it.
 *
 * A drift chart is read *against* zero, so zero belongs on it even when every
 * point is above — otherwise a line hovering at $4 and one hovering at $400 draw
 * identically and the whole point of the chart is lost.
 */
function scaleFor(
  values: readonly bigint[],
  includeZero: boolean,
  size: { readonly width: number; readonly height: number },
): Scale {
  let low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
  let high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);

  if (includeZero) {
    if (low > 0n) low = 0n;
    if (high < 0n) high = 0n;
  }
  // A flat line has no extent. Give it a dollar either side, so it draws through
  // the middle, which is what flat is.
  if (high === low) {
    high = high + 100n;
    low = low - 100n;
  }

  // Two gaps, three labels: top, middle, bottom. Whole dollars at the least.
  const step = niceStep(high - low, 2n) < 100n ? 100n : niceStep(high - low, 2n);
  low = floorTo(low, step);
  high = ceilTo(high, step);
  const ticks: bigint[] = [];
  for (let tick = low; tick <= high; tick += step) ticks.push(tick);

  const span = high - low;
  const labels = tickLabels(ticks);
  const left = Math.max(...labels.map((text) => text.length)) * CHAR + 8;
  const bottom = size.height - BOTTOM;
  const plotW = size.width - left - RIGHT;
  const plotH = bottom - TOP;

  return {
    ticks,
    labels,
    left,
    bottom,
    x(index, length) {
      if (length <= 1) return left + plotW / 2;
      return left + (index * plotW) / (length - 1);
    },
    y(value) {
      // Integer until the last step; the ratio is the only float and it is a
      // screen coordinate rather than money.
      const above = Number(value - low);
      return TOP + plotH - (above / Number(span)) * plotH;
    },
  };
}

/** `Jul 3`, with the year when the series crosses one. */
function dateLabel(date: string, withYear: boolean): string {
  if (date === 'now') return 'Today';
  // A snapshot's date is a day already decided (ADR 037), sent as midnight UTC.
  // Read the day itself rather than the instant, or a household west of UTC
  // sees every label a day early.
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/**
 * The box the chart has to fill, measured.
 *
 * The SVG is positioned absolutely inside it, so the drawing never feeds back
 * into the box's own size — the trap `Sankey` describes, where a taller chart
 * makes a taller box makes a taller chart. The box takes its height from the
 * tile, and the chart draws to it at one user unit per pixel, so labels stay
 * the size they were set at however the row is dragged.
 */
function useBox(): [RefObject<HTMLDivElement | null>, { width: number; height: number }] {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(FALLBACK);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // Rounded, so a sub-pixel reflow does not redraw the whole chart.
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === 0 || height === 0) return;
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [box, size];
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
 * One or more lines through time, filling the room it is given.
 *
 * `live` is the figure as it is right now. It is the line's last point, and the
 * axis calls it Today: snapshots are labelled for the previous day, so without it
 * every chart would end a day stale.
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
  const [box, size] = useBox();

  if (points.length === 0) {
    return <p className="text-quiet text-muted">{emptyMessage}</p>;
  }

  // Today extends the series as an ordinary point. It is current state, and
  // exact — the institution's balance as of this sync, not an estimate.
  const line: TimePoint[] =
    live == null ? [...points] : [...points, { date: 'now', provenance: 'observed', values: live }];

  const every = line.flatMap((point) => series.map((entry) => point.values[entry.key] ?? 0n));
  const scale = scaleFor(every, includeZero, size);
  const segments = segmentsOf(line);

  const first = line[0];
  const last = line[line.length - 1];
  const summary = series
    .map((entry) => {
      const from = first?.values[entry.key] ?? 0n;
      const to = last?.values[entry.key] ?? 0n;
      return `${entry.name} from ${formatCents(from)} to ${formatCents(to)}`;
    })
    .join('; ');

  // First, middle and last, by position in the series. The year only when the
  // series crosses one, because "Jul 3, 2026" three times is noise.
  const dated = line.filter((point) => point.date !== 'now');
  const withYear =
    dated.length > 1 && dated[0]!.date.slice(0, 4) !== dated[dated.length - 1]!.date.slice(0, 4);
  const xLabels = (
    line.length > 2 ? [0, Math.floor((line.length - 1) / 2), line.length - 1] : [0, line.length - 1]
  )
    .filter((index, position, all) => all.indexOf(index) === position)
    .map((index): { x: number; text: string; anchor: 'start' | 'end' | 'middle' } => ({
      x: scale.x(index, line.length),
      text: dateLabel(line[index]!.date, withYear),
      anchor: index === 0 ? 'start' : index === line.length - 1 ? 'end' : 'middle',
    }));

  const zeroY = scale.y(0n);
  const labelStyle = { fill: 'var(--color-muted)', fontSize: 10 };

  return (
    <figure className="m-0 flex min-h-0 flex-1 flex-col gap-2">
      <div ref={box} className="relative min-h-32 flex-1">
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`${label}. ${summary}.`}
        >
          {/* The value axis: a hairline at each round figure, and the figure. */}
          {scale.ticks.map((tick, index) => (
            <g key={tick.toString()}>
              <line
                x1={scale.left}
                x2={size.width - RIGHT}
                y1={scale.y(tick)}
                y2={scale.y(tick)}
                style={{ stroke: 'var(--color-line)' }}
                strokeWidth="1"
              />
              <text
                x={scale.left - 6}
                y={scale.y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="money"
                style={labelStyle}
              >
                {scale.labels[index]}
              </text>
            </g>
          ))}

          {/* Zero is read against on a drift chart, so it is drawn firmer. */}
          {includeZero && (
            <line
              x1={scale.left}
              x2={size.width - RIGHT}
              y1={zeroY}
              y2={zeroY}
              style={{ stroke: 'var(--color-axis)' }}
              strokeWidth="1"
            />
          )}

          {/* The time axis: first, middle and last. */}
          {xLabels.map((entry) => (
            <text
              key={`${entry.text}-${entry.x}`}
              x={entry.x}
              y={size.height - 4}
              textAnchor={entry.anchor}
              style={labelStyle}
            >
              {entry.text}
            </text>
          ))}

          {series.map((entry, index) => {
            const stroke = colorFor(entry, index, series.length);
            const single = series.length === 1;
            const area =
              single && !includeZero
                ? `${pathFor(line, entry.key, scale, 0, line.length - 1)} L${scale
                    .x(line.length - 1, line.length)
                    .toFixed(2)},${scale.bottom.toFixed(2)} L${scale
                    .x(0, line.length)
                    .toFixed(2)},${scale.bottom.toFixed(2)} Z`
                : null;

            return (
              <g key={entry.key}>
                {area !== null && (
                  <path d={area} style={{ fill: stroke, fillOpacity: 0.1 }} stroke="none" />
                )}
                {segments.length === 0 ? (
                  // A single point has no segment to draw. A dot says it is there.
                  <circle
                    cx={scale.x(0, 1)}
                    cy={scale.y(line[0]?.values[entry.key] ?? 0n)}
                    r="2.5"
                    style={{ fill: stroke }}
                  />
                ) : (
                  segments.map((segment) => (
                    <path
                      key={`${entry.key}-${segment.from}`}
                      d={pathFor(line, entry.key, scale, segment.from, segment.to)}
                      style={{ fill: 'none', stroke, strokeOpacity: segment.estimated ? 0.55 : 1 }}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      {...(segment.estimated ? { strokeDasharray: '4 3' } : {})}
                    >
                      <title>{segment.note}</title>
                    </path>
                  ))
                )}
              </g>
            );
          })}
        </svg>
      </div>

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
