import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type {
  AllocationSliceDto,
  OutflowMonthDto,
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

/**
 * A day key, read as a calendar date rather than as an instant.
 *
 * The API's day keys are UTC midnight standing for a local calendar day. Handing
 * one to `new Date(iso)` and formatting it renders it in the *browser's* zone,
 * so 2026-09-01 comes out "Aug 31" anywhere west of UTC — which is exactly how a
 * band of September came to be labelled Aug 31 – Sep 29. The parts are the date;
 * the zone is not part of it.
 */
const dayLabel = (iso: string): string => {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(year!, month! - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
};

/** The same reading, for a month key: "September", "August". */
const monthLabel = (iso: string): string => {
  const [year, month] = iso.slice(0, 7).split('-').map(Number);
  return new Date(year!, month! - 1, 1).toLocaleDateString(undefined, { month: 'long' });
};

/** The longest a month can be, and so the number of columns the band reserves. */
const DAYS_IN_LONGEST_MONTH = 31;

/**
 * One cell per day, for this calendar month and the two before it.
 *
 * Empty days keep their cell. A band that skipped them would compress a quiet
 * fortnight into the width of a busy one and say something false about the shape
 * of the month — the same reason a utility chart keeps an empty month between
 * two bills.
 *
 * **One scale across all three rows.** The darkest cell anywhere is the worst
 * day of the quarter, wherever it falls, which is what makes the three rows a
 * comparison rather than three charts stacked up. Shading each row against its
 * own peak would make every month look equally bad.
 *
 * **Columns are days of the month, so the 1st sits over the 1st.** Every row
 * reserves 31 columns and a shorter month simply stops — February ends two or
 * three columns early rather than being stretched to the full width, which would
 * put its 28th under March's 31st and quietly break the comparison the rows
 * exist for.
 *
 * **A day opens what was in it.** The band says a Tuesday cost $412 and the next
 * question is always which $412 — so pressing a cell lists that day's rows,
 * bounded server-side in the household's own zone so the list can never disagree
 * with the cell it came from.
 */
export function OutflowBand({
  months,
  todayIso,
  onPickDay,
}: {
  readonly months: readonly OutflowMonthDto[];
  readonly todayIso: string;
  /** A day key, `YYYY-MM-DDT…`. Opens what was spent that day. */
  readonly onPickDay: (dayIso: string) => void;
}): ReactNode {
  if (months.length === 0) return null;

  const today = todayIso.slice(0, 10);
  const all = months.flatMap((month) => month.days.map((day) => BigInt(day.spentCents)));
  // The scale every row is shaded against.
  const peak = all.reduce((max, value) => (value > max ? value : max), 0n);

  return (
    <div className="flex flex-col gap-3">
      {months.map((month, index) => (
        <MonthRow
          key={month.month}
          month={month}
          peak={peak}
          today={today}
          // Only this month has a running total to summarise; the two below it
          // are complete, and their totals are the row's own figure.
          current={index === 0}
          onPickDay={onPickDay}
        />
      ))}
    </div>
  );
}

function MonthRow({
  month,
  peak,
  today,
  current,
  onPickDay,
}: {
  readonly month: OutflowMonthDto;
  readonly peak: bigint;
  readonly today: string;
  readonly current: boolean;
  readonly onPickDay: (dayIso: string) => void;
}): ReactNode {
  const amounts = month.days.map((day) => BigInt(day.spentCents));
  const total = amounts.reduce((sum, value) => sum + value, 0n);

  /*
   * The average is over the days **elapsed**, not the days in the month.
   *
   * Dividing a month's spending by thirty on the 8th reports a figure nobody has
   * spent at — it would read as comfortably low all month and correct itself
   * only on the last day, which is the shape of a number that teaches people to
   * ignore it. A month that is over has elapsed entirely.
   */
  const elapsed = current
    ? Math.max(month.days.filter((day) => day.date.slice(0, 10) <= today).length, 1)
    : Math.max(month.days.length, 1);
  const average = total / BigInt(elapsed);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-micro font-semibold tracking-[0.06em] text-muted uppercase">
          {monthLabel(month.month)}
        </span>
        <span className="text-micro text-muted">
          <span className="money text-ink">{formatCents(total, { cents: false })}</span> out · avg{' '}
          <span className="money">{formatCents(average, { cents: false })}</span>/day
        </span>
      </div>

      <div
        className="flex gap-[2px]"
        role="img"
        aria-label={`${monthLabel(month.month)}: ${formatCents(total)} over ${month.days.length} days`}
      >
        {month.days.map((day, index) => {
          const value = amounts[index]!;
          // Opacity carries the amount; a zero day keeps the plain track so it
          // reads as "nothing" rather than as "a very small something".
          const share = peak > 0n && value > 0n ? Number((value * 100n) / peak) / 100 : 0;
          const isToday = day.date.slice(0, 10) === today;

          return (
            <button
              key={day.date}
              type="button"
              /*
               * A button rather than a span, so a day is openable by keyboard as
               * well as by pointer. A day with nothing on it is disabled rather
               * than hidden: it keeps its cell — the shape of the month depends
               * on it — and pressing it would open an empty list.
               */
              disabled={value === 0n}
              onClick={() => onPickDay(day.date)}
              // Every cell says its own date and figure. The band shows the
              // shape; this is how somebody reads one column off it.
              title={`${dayLabel(day.date)} · ${formatCents(value)}`}
              aria-label={`${dayLabel(day.date)}, ${formatCents(value)}`}
              className={`h-4 rounded-sm p-0 enabled:cursor-pointer enabled:hover:outline enabled:hover:outline-1 enabled:hover:outline-offset-1 enabled:hover:outline-axis ${
                isToday ? 'outline outline-2 outline-offset-1 outline-accent' : ''
              }`}
              style={{
                // A fixed share of 31, so a short month stops early instead of
                // stretching and taking the 1st out from over the 1st.
                width: `calc(${100 / DAYS_IN_LONGEST_MONTH}% - 2px)`,
                background:
                  value > 0n
                    ? `color-mix(in srgb, var(--color-accent) ${Math.round((0.15 + share * 0.75) * 100)}%, var(--color-surface-2))`
                    : 'var(--color-surface-2)',
              }}
            />
          );
        })}
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
