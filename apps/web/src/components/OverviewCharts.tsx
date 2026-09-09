import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type {
  BillAttentionDto,
  BillStatusDto,
  BillsThisCycleDto,
  OutflowMonthDto,
  OutstandingCheckDto,
  PacePointDto,
  UpcomingBillDto,
  UtilityComparisonDto,
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
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
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
        // Room under the row for today's mark.
        className="flex gap-[2px] pb-[3px]"
        role="img"
        aria-label={`${monthLabel(month.month)}: ${formatCents(total)} over ${month.days.length} days`}
      >
        {month.days.map((day, index) => {
          const value = amounts[index]!;
          // Opacity carries the amount; a zero day keeps the plain track so it
          // reads as "nothing" rather than as "a very small something".
          const share = peak > 0n && value > 0n ? Number((value * 100n) / peak) / 100 : 0;
          const isToday = day.date.slice(0, 10) === today;
          /*
           * A day that has not happened yet is an outline, not a filled cell.
           *
           * Drawn in the same grey as a day that cost nothing, the rest of the
           * month read as three weeks of spending nothing — a claim about the
           * future rather than a record of the past, and the same mistake the
           * pace chart avoids by stopping its lines at today.
           */
          const isFuture = day.date.slice(0, 10) > today;

          return (
            /*
             * Today is marked *under* the cell, not around it.
             *
             * It was an outline, and so is a day that has not happened yet —
             * one accent, one grey, but the same idiom, so on the row where
             * today meets the future they read as two shades of the same thing.
             * A border now means one thing only, "not yet", and today is a rule
             * beneath the cell it belongs to.
             */
            <span
              key={day.date}
              className="relative block"
              // A fixed share of 31, so a short month stops early instead of
              // stretching and taking the 1st out from over the 1st.
              style={{ width: `calc(${100 / DAYS_IN_LONGEST_MONTH}% - 2px)` }}
            >
              <button
                type="button"
                /*
                 * A button rather than a span, so a day is openable by keyboard
                 * as well as by pointer. A day with nothing on it is disabled
                 * rather than hidden: it keeps its cell — the shape of the month
                 * depends on it — and pressing it would open an empty list.
                 */
                disabled={value === 0n}
                onClick={() => onPickDay(day.date)}
                // Every cell says its own date and figure. The band shows the
                // shape; this is how somebody reads one column off it.
                title={
                  isFuture
                    ? `${dayLabel(day.date)} · not yet`
                    : `${dayLabel(day.date)} · ${formatCents(value)}`
                }
                aria-label={
                  isFuture
                    ? `${dayLabel(day.date)}, not yet`
                    : `${dayLabel(day.date)}, ${formatCents(value)}`
                }
                className="block h-4 w-full rounded-sm p-0 enabled:cursor-pointer enabled:hover:outline enabled:hover:outline-1 enabled:hover:outline-offset-1 enabled:hover:outline-axis"
                style={{
                  background: isFuture
                    ? 'transparent'
                    : value > 0n
                      ? `color-mix(in srgb, var(--color-accent) ${Math.round((0.15 + share * 0.75) * 100)}%, var(--color-surface-2))`
                      : 'var(--color-surface-2)',
                  ...(isFuture ? { border: '1px solid var(--color-line)' } : {}),
                }}
              />
              {isToday && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-[3px] h-[2px] rounded-full bg-accent"
                />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Words as well as colour — `design.md` §9, and the same map the Bills page
 * uses. A chip says what a state is; the colour is how fast it is read.
 */
const BILL_CHIP: Record<BillStatusDto, { readonly text: string; readonly tone: string }> = {
  overdue: { text: 'Overdue', tone: 'bg-negative-soft text-negative' },
  due: { text: 'Due now', tone: 'bg-accent-soft text-accent' },
  // The money has gone and the bank has not finished with it.
  arrived: { text: 'Paid', tone: 'bg-surface-2 text-positive' },
  expected: { text: 'Expected', tone: 'bg-surface-2 text-muted' },
  lapsed: { text: 'Stopped?', tone: 'bg-surface-2 text-muted' },
};

function BillChip({ status }: { readonly status: BillStatusDto }): ReactNode {
  const chip = BILL_CHIP[status];
  return (
    <span
      className={`shrink-0 rounded-full px-[6px] text-micro font-semibold ${chip.tone}`}
      style={{ lineHeight: '18px' }}
    >
      {chip.text}
    </span>
  );
}

/**
 * What is late, apparently stopped, or newly dearer.
 *
 * Usually empty, and that is the point: a tile saying "everything arrived" most
 * weeks and naming three things on the week something slipped is worth more of a
 * dashboard than one saying the same thing every day.
 *
 * The note sits **on the row** rather than under it. A second line per bill
 * doubled the tile's height to carry three words, and at sidebar width the tile
 * is competing for space with everything else in the column.
 */
export function BillAttentionList({
  bills,
  onOpenAll,
}: {
  readonly bills: readonly BillAttentionDto[];
  readonly onOpenAll: () => void;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {bills.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-5 text-center">
          <span className="text-quiet font-semibold text-ink">Everything arrived</span>
          <span className="text-micro text-muted">
            Nothing late, nothing stopped, no new prices
          </span>
        </div>
      ) : (
        <ul className="min-h-0 list-none overflow-y-auto p-0">
          {bills.map((bill) => (
            <li
              key={bill.key}
              className="row-cell flex items-center gap-2 border-b border-line last:border-b-0"
              title={`${bill.name} · ${formatCents(BigInt(bill.amountCents))} · ${bill.note}`}
            >
              <span className="min-w-0 flex-1 truncate text-quiet text-ink">{bill.name}</span>
              <BillChip status={bill.status} />
              {/* On the row, not beneath it: the reason is three words and a
                  line of its own per bill doubled the tile. */}
              <span className="shrink-0 truncate text-micro text-muted">{bill.note}</span>
              <span className="money shrink-0 text-quiet font-semibold text-ink">
                {formatCents(BigInt(bill.amountCents))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line pt-2">
        <button type="button" className="linkish" onClick={onOpenAll}>
          All bills →
        </button>
      </p>
    </div>
  );
}

/**
 * What this cycle's recurring charges come to, and how much has gone.
 *
 * Two figures and a bar rather than a list: the question is whether the rest of
 * the cycle is already spoken for, and a list of eleven bills answers it more
 * slowly than one proportion does.
 */
export function BillsThisCycle({ summary }: { readonly summary: BillsThisCycleDto }): ReactNode {
  const paid = BigInt(summary.paidCents);
  const toCome = BigInt(summary.toComeCents);
  const total = paid + toCome;
  const share = total > 0n ? Number((paid * 100n) / total) : 0;

  if (summary.totalCount === 0) {
    return <p className="text-quiet text-muted">No recurring charges this cycle.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between gap-2 text-quiet text-muted">
        <span>
          <b className="money block text-base font-bold text-ink">
            {formatCents(paid, { cents: false })}
          </b>
          paid so far
        </span>
        <span className="text-right">
          <b className="money block text-base font-bold text-ink">
            {formatCents(toCome, { cents: false })}
          </b>
          still to come
        </span>
      </div>

      <span
        className="relative block h-2 overflow-hidden rounded bg-surface-2"
        role="img"
        aria-label={`${formatCents(paid)} of ${formatCents(total)} paid`}
        title={`${formatCents(paid)} of ${formatCents(total)} paid`}
      >
        <span
          className="absolute inset-y-0 left-0 rounded bg-accent"
          style={{ width: `${share}%` }}
        />
      </span>

      <p className="text-micro text-muted">
        {summary.paidCount} of {summary.totalCount} bills paid
        {summary.largestDue && (
          <>
            {' · the largest still due is '}
            {summary.largestDue.name},{' '}
            <span className="money">
              {formatCents(BigInt(summary.largestDue.amountCents), { cents: false })}
            </span>{' '}
            on {dayLabel(summary.largestDue.expectedNextAt)}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Each utility's twelve months, and which way it is going.
 *
 * Twelve against the twelve before rather than six against six, because these
 * bills are seasonal: July's electricity against January's is weather, not a
 * trend. A line without two years behind it says so instead of claiming to be
 * flat.
 */
export function UtilityTrends({
  entries,
}: {
  readonly entries: readonly UtilityComparisonDto[];
}): ReactNode {
  if (entries.length === 0) {
    return <p className="text-quiet text-muted">No utilities tracked yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
      {entries.map((entry) => {
        const values = entry.months.map((month) => Number(BigInt(month)));
        const low = Math.min(...values);
        const high = Math.max(...values);
        const span = high - low || 1;
        const points = values
          .map((value, index) => {
            const x = (index / Math.max(values.length - 1, 1)) * 100;
            const y = 22 - ((value - low) / span) * 20;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');

        const trend = entry.trendBasisPoints;
        const percent = trend === null ? null : Math.round(trend / 100);

        return (
          <div
            key={entry.delegationId}
            className="grid items-center gap-2"
            style={{ gridTemplateColumns: '5.5rem 1fr 3.5rem' }}
            title={
              trend === null
                ? `${entry.name}: not enough history to compare years yet`
                : `${entry.name}: the last twelve months cost ${Math.abs(percent!)}% ${
                    trend >= 0 ? 'more' : 'less'
                  } than the twelve before`
            }
          >
            <span className="truncate text-quiet text-ink">{entry.name}</span>
            <svg
              viewBox="0 0 100 24"
              preserveAspectRatio="none"
              className="block h-6 w-full"
              aria-hidden="true"
            >
              <polyline
                points={points}
                fill="none"
                stroke={entry.color ?? 'var(--color-accent)'}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            {/* A dash rather than 0%: not knowing and not moving are different
                answers, and only one of them is a fact about the bill. */}
            <span
              className={`money text-right text-quiet font-semibold ${
                percent === null ? 'text-muted' : percent > 0 ? 'text-negative' : 'text-positive'
              }`}
            >
              {percent === null ? '—' : `${percent > 0 ? '+' : ''}${percent}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** How far out a line has to be before it is worth saying anything: a fifth. */
const ADJUST_THRESHOLD = 0.2;

/**
 * Only the utilities funded more than a fifth away from what they cost.
 *
 * The other exception list. A line funded within a fifth of its own average is
 * one nobody needs to think about, and listing it would bury the two that are
 * out by forty dollars a cycle.
 */
export function UtilitiesToAdjust({
  entries,
}: {
  readonly entries: readonly UtilityComparisonDto[];
}): ReactNode {
  const worth = entries
    .filter((entry) => entry.amountToDelegateCents !== null)
    .map((entry) => {
      const funded = BigInt(entry.amountToDelegateCents!);
      const actual = BigInt(entry.suggestedPerCycleCents);
      return { entry, funded, actual, gap: funded - actual };
    })
    .filter(({ actual, gap }) => {
      // Integer arithmetic on cents: |gap| * 5 > actual is |gap| > actual / 5.
      const magnitude = gap < 0n ? -gap : gap;
      return actual > 0n && magnitude * BigInt(Math.round(1 / ADJUST_THRESHOLD)) > actual;
    })
    .sort((a, b) => {
      const left = a.gap < 0n ? -a.gap : a.gap;
      const right = b.gap < 0n ? -b.gap : b.gap;
      return right > left ? 1 : right < left ? -1 : 0;
    });

  if (worth.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-5 text-center">
        <span className="text-quiet font-semibold text-ink">Nothing to change</span>
        <span className="text-micro text-muted">
          Every utility is funded within a fifth of what it costs
        </span>
      </div>
    );
  }

  return (
    <ul className="min-h-0 list-none overflow-y-auto p-0">
      {worth.map(({ entry, funded, actual, gap }) => (
        <li
          key={entry.delegationId}
          className="row-cell flex items-center gap-2 border-b border-line last:border-b-0"
          title={`${entry.name}: funded at ${formatCents(funded)}, costs ${formatCents(actual)} per cycle`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-quiet font-semibold text-ink">{entry.name}</span>
            <span className="money block truncate text-micro text-muted">
              {formatCents(funded, { cents: false })} funded ·{' '}
              {formatCents(actual, { cents: false })} actual
            </span>
          </span>
          {/* Signed from the household's side: a positive gap is money going in
              that does not need to. */}
          <span
            className={`money shrink-0 text-base font-semibold ${
              gap >= 0n ? 'text-positive' : 'text-negative'
            }`}
          >
            {gap >= 0n ? '+' : ''}
            {formatCents(gap, { cents: false })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What has been written and not yet cleared.
 *
 * A check is money that has left the budget but not the bank, so it is the one
 * figure a statement and this application legitimately disagree about — and the
 * disagreement is exactly this list. Number, what it was for, and how much.
 */
export function OutstandingChecks({
  checks,
}: {
  readonly checks: readonly OutstandingCheckDto[];
}): ReactNode {
  if (checks.length === 0) {
    return <p className="text-quiet text-muted">Nothing outstanding.</p>;
  }

  const total = checks.reduce((sum, check) => sum + BigInt(check.amountCents), 0n);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <ul className="min-h-0 list-none overflow-y-auto p-0">
        {checks.map((check) => (
          <li
            key={check.id}
            className="row-cell flex items-center gap-2 border-b border-line last:border-b-0"
            title={`Check ${check.checkNumber} · written ${dayLabel(check.issuedAt)}${
              check.memo ? ` · ${check.memo}` : ''
            }`}
          >
            {/* The number first and in figures: it is what somebody is reading
                off a statement or a stub when they come to this list. */}
            <span className="money w-16 shrink-0 text-quiet font-semibold text-ink">
              {check.checkNumber}
            </span>
            <span className="min-w-0 flex-1 truncate text-quiet text-muted">
              {check.memo ?? dayLabel(check.issuedAt)}
            </span>
            <span className="money shrink-0 text-quiet font-semibold text-ink">
              {formatCents(BigInt(check.amountCents))}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line pt-2 text-micro text-muted">
        {checks.length} outstanding · <span className="money">{formatCents(total)}</span>
      </p>
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

/*
 * The allocation donut that stood here is gone with the tile it drew.
 *
 * A donut answers "what share" and nothing else, and the legend beside it was
 * already carrying every figure anybody read — in a column half the tile wide,
 * on a page where a tile is a third of the width. The same rows as ranked bars
 * are the shape every other tile here uses, sort largest first without a colour
 * key, and read at the density the budget panel reads at.
 */

/** What is coming, from Bills. Everything here is inferred from the register. */
export function UpcomingList({
  bills,
  onOpenAll,
}: {
  readonly bills: readonly UpcomingBillDto[];
  readonly onOpenAll: () => void;
}): ReactNode {
  const total = bills.reduce((sum, bill) => sum + BigInt(bill.typicalAmountCents), 0n);

  return (
    <div className="flex flex-col gap-2">
      {bills.length === 0 ? (
        <p className="text-quiet text-muted">Nothing scheduled.</p>
      ) : (
        <ul className="list-none p-0">
          {bills.map((bill) => (
            <li
              key={bill.key}
              className="row-cell flex items-center gap-2 border-b border-line last:border-b-0"
              title={`${bill.name} · ${formatCents(BigInt(bill.typicalAmountCents))} · ${dayLabel(bill.expectedNextAt)}`}
            >
              {/* The grouping's colour, so a bill is the same colour here as the
                  money it comes out of is everywhere else on the page. */}
              <span
                aria-hidden="true"
                className="size-[6px] shrink-0 rounded-full"
                style={{ background: bill.color ?? 'var(--color-accent)' }}
              />
              <span className="min-w-0 flex-1 truncate text-quiet text-ink">{bill.name}</span>
              {/* Only where it means something. "Expected" on every row is a
                  column of the same word. */}
              {(bill.status === 'due' || bill.status === 'overdue') && (
                <BillChip status={bill.status} />
              )}
              <span className="money shrink-0 text-quiet font-semibold text-ink">
                {formatCents(BigInt(bill.typicalAmountCents))}
              </span>
              <span className="w-14 shrink-0 text-right text-micro text-muted">
                {dayLabel(bill.expectedNextAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-center justify-between gap-2 border-t border-line pt-2 text-micro text-muted">
        <span>
          {bills.length} scheduled · <span className="money">{formatCents(total)}</span> typical
        </span>
        <button type="button" className="linkish" onClick={onOpenAll}>
          All bills →
        </button>
      </p>
    </div>
  );
}
