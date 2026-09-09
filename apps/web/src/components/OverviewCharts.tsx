import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type {
  AllocationSliceDto,
  OutflowDayDto,
  PacePointDto,
  UpcomingBillDto,
} from '../api/overview.js';

/**
 * The cycle-shaped charts.
 *
 * All three are drawn against the pay cycle rather than the calendar month the
 * design they came from used. Every figure on this page is measured from
 * payday, and one calendar-shaped reading among them would be the one somebody
 * has to remember is different.
 */

const dayLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * One cell per day of the cycle, shaded by what went out.
 *
 * Empty days keep their cell. A band that skipped them would compress a quiet
 * fortnight into the width of a busy one and say something false about the
 * shape of the cycle — the same reason a utility chart keeps an empty month
 * between two bills.
 */
export function OutflowBand({
  days,
  todayIso,
}: {
  readonly days: readonly OutflowDayDto[];
  readonly todayIso: string;
}): ReactNode {
  const amounts = days.map((day) => BigInt(day.spentCents));
  const peak = amounts.reduce((max, value) => (value > max ? value : max), 0n);
  const total = amounts.reduce((sum, value) => sum + value, 0n);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex gap-1"
        role="img"
        aria-label={`Daily outflow, ${formatCents(total)} over ${days.length} days`}
      >
        {days.map((day, index) => {
          const value = amounts[index]!;
          // Opacity carries the amount; a zero day keeps the plain track so it
          // reads as "nothing" rather than as "a very small something".
          const share = peak > 0n && value > 0n ? Number((value * 100n) / peak) / 100 : 0;
          const today = day.date.slice(0, 10) === todayIso.slice(0, 10);

          return (
            <span
              key={day.date}
              title={`${dayLabel(day.date)}: ${formatCents(value)}`}
              className={`h-4 flex-1 rounded-sm ${today ? 'outline outline-2 outline-offset-1 outline-accent' : ''}`}
              style={{
                background:
                  value > 0n
                    ? `color-mix(in srgb, var(--color-accent) ${Math.round((0.15 + share * 0.75) * 100)}%, var(--color-surface-2))`
                    : 'var(--color-surface-2)',
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-micro text-axis">
        <span>{days[0] ? dayLabel(days[0].date) : ''}</span>
        <span className="money">{formatCents(total)} out</span>
        <span>{days.length > 0 ? dayLabel(days[days.length - 1]!.date) : ''}</span>
      </div>
    </div>
  );
}

const VIEW = { width: 320, height: 120 };
const PAD = 8;

/**
 * Money in against money out, both running totals.
 *
 * Both lines stop at today. Carrying them flat to the end of the cycle would
 * draw a fortnight of spending nothing, which is a claim about the future — and
 * on a chart whose whole subject is pace, a flat tail reads as comfortably
 * ahead.
 */
export function PaceChart({ points }: { readonly points: readonly PacePointDto[] }): ReactNode {
  const observed = points.filter((point) => point.observed);
  if (observed.length === 0) {
    return <p className="text-quiet text-muted">Nothing in this cycle yet.</p>;
  }

  const values = points.flatMap((point) => [BigInt(point.inflowCents), BigInt(point.spentCents)]);
  const peak = values.reduce((max, value) => (value > max ? value : max), 1n);

  const x = (index: number): number =>
    PAD + (index / Math.max(points.length - 1, 1)) * (VIEW.width - PAD * 2);
  const y = (value: bigint): number =>
    VIEW.height - PAD - (Number(value) / Number(peak)) * (VIEW.height - PAD * 2);

  const path = (pick: (point: PacePointDto) => bigint): string =>
    observed
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(pick(point)).toFixed(1)}`,
      )
      .join(' ');

  const inflow = path((point) => BigInt(point.inflowCents));
  const spent = path((point) => BigInt(point.spentCents));
  const last = observed[observed.length - 1]!;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`In ${formatCents(BigInt(last.inflowCents))}, out ${formatCents(BigInt(last.spentCents))} so far this cycle`}
      >
        <path
          d={`${inflow} L${x(observed.length - 1).toFixed(1)},${VIEW.height - PAD} L${x(0).toFixed(1)},${VIEW.height - PAD} Z`}
          style={{ fill: 'var(--color-accent)', fillOpacity: 0.1 }}
        />
        <path
          d={inflow}
          style={{ fill: 'none', stroke: 'var(--color-accent)' }}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={spent}
          style={{ fill: 'none', stroke: 'var(--color-warning-dot)' }}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* Today, where the record stops. */}
        <circle
          cx={x(observed.length - 1)}
          cy={y(BigInt(last.spentCents))}
          r="3"
          style={{ fill: 'var(--color-canvas)', stroke: 'var(--color-warning-dot)' }}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-quiet">
        <span className="flex items-baseline gap-2">
          <i aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-accent" />
          <span className="text-muted">In</span>
          <span className="money font-semibold text-ink">
            {formatCents(BigInt(last.inflowCents))}
          </span>
        </span>
        <span className="flex items-baseline gap-2">
          <i
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: 'var(--color-warning-dot)' }}
          />
          <span className="text-muted">Out</span>
          <span className="money font-semibold text-ink">
            {formatCents(BigInt(last.spentCents))}
          </span>
        </span>
      </figcaption>
    </figure>
  );
}

const R = 52;
const STROKE = 17;

/** Where the money is delegated, as proportions. */
export function AllocationDonut({
  slices,
  emptyMessage,
}: {
  readonly slices: readonly AllocationSliceDto[];
  readonly emptyMessage: string;
}): ReactNode {
  const amounts = slices.map((slice) => BigInt(slice.amountCents));
  const total = amounts.reduce((sum, value) => sum + value, 0n);
  if (total <= 0n) return <p className="text-quiet text-muted">{emptyMessage}</p>;

  const circumference = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        viewBox="0 0 140 140"
        className="h-32 w-32 shrink-0"
        role="img"
        aria-label={`Total ${formatCents(total)}`}
      >
        {slices.map((slice, index) => {
          const length = (Number(amounts[index]!) / Number(total)) * circumference;
          const dash = `${Math.max(length - 1.5, 0.5).toFixed(2)} ${(circumference - length + 1.5).toFixed(2)}`;
          const element = (
            <circle
              key={slice.key}
              r={R}
              cx="70"
              cy="70"
              fill="none"
              style={{ stroke: slice.color ?? 'var(--color-group-grey)' }}
              strokeWidth={STROKE}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            />
          );
          offset += length;
          return element;
        })}
        <text
          x="70"
          y="68"
          textAnchor="middle"
          fontSize="15"
          fontWeight="700"
          style={{ fill: 'var(--color-ink)' }}
        >
          {formatCents(total)}
        </text>
      </svg>

      {/* The figures as text: a proportion nobody can read is a proportion
          nobody has. */}
      <ul className="flex min-w-0 flex-1 list-none flex-col gap-1 p-0">
        {slices.map((slice, index) => (
          <li key={slice.key} className="flex items-baseline gap-2 text-quiet">
            <i
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-sm"
              style={{ background: slice.color ?? 'var(--color-group-grey)' }}
            />
            <span className="min-w-0 flex-1 truncate text-ink">{slice.name}</span>
            <span className="money shrink-0 font-semibold">{formatCents(amounts[index]!)}</span>
            <span className="money w-8 shrink-0 text-right text-micro text-muted">
              {Math.round((Number(amounts[index]!) / Number(total)) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What is coming, from Bills. Everything here is inferred from the register. */
export function UpcomingList({ bills }: { readonly bills: readonly UpcomingBillDto[] }): ReactNode {
  if (bills.length === 0) {
    return <p className="text-quiet text-muted">Nothing scheduled.</p>;
  }

  const total = bills.reduce((sum, bill) => sum + BigInt(bill.typicalAmountCents), 0n);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex list-none flex-col gap-1 p-0">
        {bills.map((bill) => (
          <li key={bill.key} className="flex items-center gap-2">
            <span className="w-10 shrink-0 rounded border border-line py-[2px] text-center text-micro text-muted">
              {new Date(bill.expectedNextAt)
                .toLocaleDateString(undefined, { month: 'short' })
                .toUpperCase()}
              <b className="block text-quiet font-semibold text-ink">
                {new Date(bill.expectedNextAt).getDate()}
              </b>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-quiet font-medium text-ink">{bill.name}</span>
              {bill.delegationName !== null && (
                <span className="block truncate text-micro text-muted">{bill.delegationName}</span>
              )}
            </span>
            <span className="money shrink-0 text-quiet font-semibold">
              {formatCents(BigInt(bill.typicalAmountCents))}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-micro text-muted">
        {bills.length} scheduled · {formatCents(total)} typical
      </p>
    </div>
  );
}
