import type { ReactNode } from 'react';

import { formatCents } from '@budget/shared';

/**
 * How fast a line is being spent, against how fast time is passing.
 *
 * One construction, used wherever a budget line appears. The reading is the
 * relationship between two marks rather than either alone:
 *
 * - **fill left of the tick** — spending slower than time. Good.
 * - **fill past the tick** — spending faster than time. Worth a look.
 * - **fill past the split** — spent more than this cycle had. Only this part is
 *   red, and only this part.
 *
 * ## What the track measures
 *
 * The cycle zone runs 0 → {@link SPLIT}% and is scaled to **what this line had
 * to spend this cycle**: the delegation plus whatever surplus or deficit it
 * carried in. That is one number because it answers one question — how much is
 * there before the next payday — and it is derived rather than stored:
 *
 * ```
 * available = spent + balance
 * ```
 *
 * which needs no assumption about whether this cycle's press has run yet. The
 * balance is what is left, the spending is what has gone, and their sum is what
 * there was.
 *
 * The remaining {@link SPLIT}–100% is overspend: past everything the line had.
 * It is only drawn when a line is actually past that point.
 *
 * ## Why the split does not move
 *
 * It is at a fixed position on every row, never proportional, and that is the
 * load-bearing part. The tick is a *time* marker — identical on every line — and
 * it must read as one straight vertical down the column, which is what makes a
 * list of bars scannable rather than twenty separate charts. Because the tick
 * only ever travels 0 → {@link SPLIT}%, it lands in the same place on every row
 * whatever the line holds.
 *
 * ## Colour
 *
 * The fill keeps the delegation's grouping colour the whole way along the cycle
 * zone, whether or not the line has run out. Only the part past the end is red.
 * Red therefore means one thing and means it precisely: **this much was spent
 * beyond what the line had**. Spending more than the delegation is not red — in
 * an envelope budget that condition is ordinary and often correct, which is what
 * carrying over is for.
 */

/** Where the cycle's money ends and overspending begins, as a % of the track. */
export const SPLIT = 80;

/**
 * How much overspending fills the zone past the split: a quarter of what the
 * cycle had. Past that it clamps, because a line 30% over and a line 300% over
 * both have to stay inside their own box, and "well past" is the whole message.
 */
const OVERSPEND_HEADROOM_DIVISOR = 4n;

/**
 * How far along the track the fill reaches, 0–100.
 *
 * Exported and pure because it is the whole semantic; everything else in this
 * file is markup. All arithmetic is on integer cents — the percentage it returns
 * is a coordinate, not money.
 */
export function paceFill({
  spentCents,
  plannedCents,
  balanceCents,
}: {
  readonly spentCents: bigint;
  readonly plannedCents: bigint;
  readonly balanceCents: bigint;
}): number {
  // A refunded line can net positive over the window. That is not negative
  // spending, it is none.
  const spent = spentCents > 0n ? spentCents : 0n;
  const available = spent + balanceCents;

  if (balanceCents >= 0n) {
    // Inside what the cycle had. Nothing available and nothing spent draws
    // nothing at all rather than a full bar.
    if (available <= 0n) return 0;
    return clamp(Number((spent * BigInt(SPLIT)) / available));
  }

  // Past it. The cycle zone is full by definition; the rest says how far past.
  const over = -balanceCents;
  const headroom = overspendHeadroom({ available, plannedCents });
  if (headroom <= 0n) return 100;
  return clamp(SPLIT + Number((over * BigInt(100 - SPLIT)) / headroom));
}

/**
 * What a full overspend zone is worth.
 *
 * Normally a quarter of what the cycle had. A line that opened the cycle already
 * underwater has nothing to scale against, so it falls back to the delegation —
 * and with neither, there is no scale at all and the zone simply fills.
 */
function overspendHeadroom({
  available,
  plannedCents,
}: {
  readonly available: bigint;
  readonly plannedCents: bigint;
}): bigint {
  const base = available > 0n ? available : plannedCents > 0n ? plannedCents : 0n;
  return base / OVERSPEND_HEADROOM_DIVISOR;
}

const clamp = (value: number): number => Math.max(0, Math.min(value, 100));

/**
 * What a line carried into this cycle: surplus, deficit, or nothing.
 *
 * Derived the same way as the track, so the words and the drawing can never
 * disagree: what there was, less what this cycle's press put in.
 */
export function carriedIn({
  spentCents,
  plannedCents,
  balanceCents,
}: {
  readonly spentCents: bigint;
  readonly plannedCents: bigint;
  readonly balanceCents: bigint;
}): bigint {
  const spent = spentCents > 0n ? spentCents : 0n;
  return spent + balanceCents - plannedCents;
}

/**
 * The hover text: figures, never a verdict.
 *
 * "On pace" and "Out of money" were both proposed and refused. The bar already
 * says the shape of it, and a household reading its own budget wants the amount
 * rather than an opinion about the amount.
 */
export function paceSummary(line: {
  readonly spentCents: bigint;
  readonly plannedCents: bigint;
  readonly balanceCents: bigint;
}): string {
  const spent = line.spentCents > 0n ? line.spentCents : 0n;
  const available = spent + line.balanceCents;
  const carried = carriedIn(line);

  const carriedPhrase =
    carried === 0n
      ? 'nothing carried in'
      : carried > 0n
        ? `${formatCents(carried, { cents: false })} carried in`
        : `${formatCents(-carried, { cents: false })} deficit carried in`;

  return `${formatCents(spent, { cents: false })} spent of ${formatCents(available, {
    cents: false,
  })} · ${carriedPhrase}`;
}

export function PaceBar({
  spentCents,
  plannedCents,
  balanceCents,
  color,
  /** 0–10,000. Null when no payday anchor is set, and then no tick is drawn. */
  cycleProgressBasisPoints,
  label,
}: {
  readonly spentCents: bigint;
  /** What this cycle's Delegate press puts in — the delegation. */
  readonly plannedCents: bigint;
  /** What the line actually holds now. Negative means overspent. */
  readonly balanceCents: bigint;
  readonly color: string | null;
  readonly cycleProgressBasisPoints: number | null;
  /** Names the bar for a screen reader; the figures are stated beside it too. */
  readonly label: string;
}): ReactNode {
  const fill = paceFill({ spentCents, plannedCents, balanceCents });
  const tone = color ?? 'var(--color-accent)';
  const overspent = fill > SPLIT;

  return (
    <span className="relative block h-2 w-full rounded bg-surface-2" role="img" aria-label={label}>
      {/* The overspend zone, always drawn so the split reads at a glance and
          lands in the same place on every row. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 right-0 rounded-r"
        style={{
          left: `${SPLIT}%`,
          background: 'var(--color-negative)',
          opacity: 0.08,
        }}
      />

      {/* Spent, in the grouping's colour, counting up from the left. */}
      <span
        aria-hidden="true"
        className="absolute top-[2.5px] left-[2px] h-[3px] rounded"
        style={{
          width: `calc(${Math.min(fill, SPLIT)}% - 4px)`,
          minWidth: fill > 0 ? '2px' : '0',
          background: tone,
        }}
      />

      {/* The part past everything the line had. This, and only this, is red. */}
      {overspent && (
        <span
          aria-hidden="true"
          className="absolute top-[2.5px] h-[3px] rounded"
          style={{
            left: `${SPLIT}%`,
            width: `calc(${fill - SPLIT}% - 2px)`,
            minWidth: '2px',
            background: 'var(--color-negative)',
          }}
        />
      )}

      {/* The boundary. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-line"
        style={{ left: `${SPLIT}%` }}
      />

      {/* Time. It only ever travels the cycle zone, so it reads as one straight
          vertical down the column. */}
      {cycleProgressBasisPoints !== null && (
        <span
          aria-hidden="true"
          className="absolute top-[1px] z-10 h-[6px] w-[1.5px] rounded-[1px] bg-axis"
          style={{ left: `${(cycleProgressBasisPoints / 10_000) * SPLIT}%` }}
        />
      )}
    </span>
  );
}
