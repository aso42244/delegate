import {
  formatCents,
  isEstimated,
  PROVENANCE_NOTES,
  type SnapshotProvenance,
} from '@budget/shared';
import type { ReactNode } from 'react';

/**
 * The chart every snapshot-backed tile is drawn with.
 *
 * Inline SVG, like every other chart here. `docs/dependencies.md` is explicit
 * that a package earns its place when the alternative is implementing
 * cryptography or a wire protocol by hand — a line, a stacked area and a ranked
 * bar are none of those, and a charting library would be the largest thing in
 * this tree by some distance.
 *
 * Three things this does that the older tiles did not have to:
 *
 * **It says where a figure came from.** A segment built from estimated days is
 * dashed and muted, with the reason on hover. `observed`, `reconstructed` and
 * `carried` are all exact and draw normally — they still say so on hover,
 * because "exact" is worth knowing too.
 *
 * **It ends on now.** Snapshots are labelled for the previous day, so every
 * series would otherwise stop a day short and read as stale. The live point is
 * a hollow marker on a dashed final segment: current state, not something
 * anybody recorded.
 *
 * **It says when there is not enough history**, rather than drawing an axis
 * through one point. This ships with no history at all and gains a day a night.
 */

export interface ChartPoint {
  readonly date: string;
  readonly provenance: SnapshotProvenance;
  readonly valueCents: bigint;
}

export interface ChartSeries {
  readonly key: string;
  readonly name: string;
  /** The grouping's own colour where it has one; otherwise the palette below. */
  readonly color: string | null;
  readonly points: readonly ChartPoint[];
}

/** design.md's ordered multi-series palette, as tokens so dark mode can lift it. */
const SERIES_COLORS = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)',
];

/** A single series is the accent. One line does not need a palette. */
function colorFor(series: ChartSeries, index: number, total: number): string {
  if (series.color) return series.color;
  if (total === 1) return 'var(--color-accent)';
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? 'var(--color-accent)';
}

const VIEW = { width: 100, height: 100 };

interface Scale {
  readonly low: bigint;
  readonly high: bigint;
  x(index: number, length: number): number;
  y(value: bigint): number;
}

function scaleFor(values: readonly bigint[], includeZero: boolean): Scale {
  let low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
  let high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);

  // A drift chart is read against zero, so zero has to be on it even when every
  // point sits above the line.
  if (includeZero) {
    if (low > 0n) low = 0n;
    if (high < 0n) high = 0n;
  }

  const span = high - low;
  return {
    low,
    high,
    x: (index, length) => (length <= 1 ? 50 : (index / (length - 1)) * VIEW.width),
    // Percentages are layout, never money — the same rule the older tiles keep.
    y: (value) => (span === 0n ? 50 : 100 - Number(((value - low) * 100n) / span)),
  };
}

/**
 * Splits a series into runs of the same exactness, so a dashed stretch covers
 * exactly the estimated days and no more.
 *
 * Runs overlap by one point deliberately: without it the line breaks at every
 * boundary and reads as missing data rather than as a change of confidence.
 */
function runs(points: readonly ChartPoint[]): { estimated: boolean; from: number; to: number }[] {
  if (points.length === 0) return [];

  const out: { estimated: boolean; from: number; to: number }[] = [];
  let start = 0;
  let estimated = isEstimated(points[0]!.provenance);

  for (let index = 1; index < points.length; index += 1) {
    const next = isEstimated(points[index]!.provenance);
    if (next !== estimated) {
      out.push({ estimated, from: start, to: index });
      start = index;
      estimated = next;
    }
  }
  out.push({ estimated, from: start, to: points.length - 1 });
  return out;
}

function pathFor(
  points: readonly ChartPoint[],
  scale: Scale,
  from: number,
  to: number,
  length: number,
): string {
  const parts: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const point = points[index];
    if (!point) continue;
    const x = scale.x(index, length).toFixed(2);
    const y = scale.y(point.valueCents).toFixed(2);
    parts.push(`${index === from ? 'M' : 'L'}${x},${y}`);
  }
  return parts.join(' ');
}

/** One short sentence, no instructions — ui-system.md §3. */
export function NotEnoughHistory({ days }: { readonly days: number }): ReactNode {
  return (
    <p className="text-quiet text-muted">
      {days === 0
        ? 'No history yet — the first night records one.'
        : `Only ${days === 1 ? 'one day' : `${days} days`} of history so far.`}
    </p>
  );
}

export interface SnapshotChartProps {
  readonly series: readonly ChartSeries[];
  readonly display: string;
  /** Current state, drawn as a hollow marker beyond the stored history. */
  readonly liveCents?: bigint | null;
  /** Draws a reference line at zero. The drift chart is read against it. */
  readonly zeroLine?: boolean;
  readonly days: number;
  readonly label: string;
}

export function SnapshotChart({
  series,
  display,
  liveCents = null,
  zeroLine = false,
  days,
  label,
}: SnapshotChartProps): ReactNode {
  const drawable = series.filter((entry) => entry.points.length > 0);
  const longest = drawable.reduce((most, entry) => Math.max(most, entry.points.length), 0);

  // One point is a reading, not a trend. Saying so beats an axis through a dot.
  if (longest < 2) {
    return (
      <>
        {longest === 1 && <Latest series={drawable} liveCents={liveCents} />}
        <NotEnoughHistory days={days} />
      </>
    );
  }

  const values = drawable.flatMap((entry) => entry.points.map((point) => point.valueCents));
  if (liveCents !== null) values.push(liveCents);
  const scale = scaleFor(values, zeroLine);

  return (
    <>
      <Latest series={drawable} liveCents={liveCents} />

      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={label}
      >
        {zeroLine && (
          <line
            x1="0"
            x2="100"
            y1={scale.y(0n)}
            y2={scale.y(0n)}
            stroke="var(--color-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {drawable.map((entry, index) => {
          const color = colorFor(entry, index, drawable.length);
          const length = entry.points.length;

          return (
            <g key={entry.key}>
              {display === 'area' && drawable.length === 1 && (
                <path
                  d={`${pathFor(entry.points, scale, 0, length - 1, length)} L${VIEW.width},${VIEW.height} L0,${VIEW.height} Z`}
                  fill="var(--color-accent-soft)"
                  stroke="none"
                />
              )}

              {runs(entry.points).map((run) => (
                <path
                  key={`${run.from}-${run.to}`}
                  d={pathFor(entry.points, scale, run.from, run.to, length)}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  // Estimated stretches are dashed and muted, so a line nobody
                  // observed never reads the same as one somebody did.
                  strokeDasharray={run.estimated ? '3 2' : undefined}
                  strokeOpacity={run.estimated ? 0.55 : 1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}

              {/* The live point, on the first series only: one "now" per chart. */}
              {liveCents !== null && index === 0 && (
                <>
                  <path
                    d={`M${scale.x(length - 1, length)},${scale.y(entry.points[length - 1]!.valueCents)} L${VIEW.width},${scale.y(liveCents)}`}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.5"
                    strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={VIEW.width}
                    cy={scale.y(liveCents)}
                    r="2.5"
                    fill="var(--color-canvas)"
                    stroke={color}
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>

      <Footnote series={drawable} scale={scale} liveCents={liveCents} />
    </>
  );
}

/** The figure, which is what is actually being read. A shape is not a number. */
function Latest({
  series,
  liveCents,
}: {
  readonly series: readonly ChartSeries[];
  readonly liveCents: bigint | null;
}): ReactNode {
  if (series.length !== 1) return null;
  const points = series[0]?.points ?? [];
  const value = liveCents ?? points[points.length - 1]?.valueCents ?? 0n;
  return <p className="money mb-2 text-hero font-bold text-ink">{formatCents(value)}</p>;
}

/**
 * The range, and anything about the line that a reader would otherwise have to
 * infer from its shape.
 */
function Footnote({
  series,
  scale,
  liveCents,
}: {
  readonly series: readonly ChartSeries[];
  readonly scale: Scale;
  readonly liveCents: bigint | null;
}): ReactNode {
  const estimated = series.some((entry) =>
    entry.points.some((point) => isEstimated(point.provenance)),
  );

  return (
    <>
      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {series.slice(0, 8).map((entry, index) => (
            <li key={entry.key} className="flex items-center gap-1">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorFor(entry, index, series.length) }}
              />
              <span className="truncate text-quiet text-muted">{entry.name}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-quiet text-muted">
        {formatCents(scale.low)} to {formatCents(scale.high)}
        {liveCents !== null && <span> · the hollow point is now</span>}
      </p>

      {/* Said rather than left to be inferred from a dashed stretch. */}
      {estimated && (
        <p className="mt-1 text-quiet text-muted" title={PROVENANCE_NOTES.interpolated}>
          Dashed where a snapshot was missed and the value was estimated.
        </p>
      )}
    </>
  );
}

/**
 * A stacked area: what net worth is made of, rather than only how much.
 *
 * Debts are drawn below the baseline rather than stacked with the assets, which
 * is the only honest arrangement — stacking a debt on top of an asset would make
 * the total read as their sum.
 */
export function StackedAreaChart({
  points,
  days,
  label,
}: {
  readonly points: readonly {
    date: string;
    provenance: SnapshotProvenance;
    bitcoinCents: bigint;
    otherAssetsCents: bigint;
    debtsCents: bigint;
  }[];
  readonly days: number;
  readonly label: string;
}): ReactNode {
  if (points.length < 2) return <NotEnoughHistory days={days} />;

  const tops = points.map((point) => point.otherAssetsCents + point.bitcoinCents);
  const values = [...tops, ...points.map((point) => -point.debtsCents), 0n];
  const scale = scaleFor(values, true);

  const band = (upper: (index: number) => bigint, lower: (index: number) => bigint): string => {
    const forward = points
      .map(
        (_, index) =>
          `${index === 0 ? 'M' : 'L'}${scale.x(index, points.length).toFixed(2)},${scale.y(upper(index)).toFixed(2)}`,
      )
      .join(' ');
    const back = points
      .map((_, index) => points.length - 1 - index)
      .map(
        (index) =>
          `L${scale.x(index, points.length).toFixed(2)},${scale.y(lower(index)).toFixed(2)}`,
      )
      .join(' ');
    return `${forward} ${back} Z`;
  };

  const at = (index: number): (typeof points)[number] => points[index]!;

  return (
    <>
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={label}
      >
        <path
          d={band(
            (index) => at(index).otherAssetsCents + at(index).bitcoinCents,
            (index) => at(index).otherAssetsCents,
          )}
          fill="var(--color-series-2)"
          fillOpacity="0.7"
        />
        <path
          d={band(
            (index) => at(index).otherAssetsCents,
            () => 0n,
          )}
          fill="var(--color-accent)"
          fillOpacity="0.5"
        />
        <path
          d={band(
            () => 0n,
            (index) => -at(index).debtsCents,
          )}
          fill="var(--color-negative)"
          fillOpacity="0.4"
        />
        <line
          x1="0"
          x2="100"
          y1={scale.y(0n)}
          y2={scale.y(0n)}
          stroke="var(--color-line)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <ul className="mt-2 flex flex-wrap gap-2">
        {[
          ['Other assets', 'var(--color-accent)'],
          ['Bitcoin', 'var(--color-series-2)'],
          ['Debts', 'var(--color-negative)'],
        ].map(([name, color]) => (
          <li key={name} className="flex items-center gap-1">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <span className="text-quiet text-muted">{name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
