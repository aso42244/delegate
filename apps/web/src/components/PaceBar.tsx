import type { ReactNode } from 'react';

/**
 * How fast a line is being spent, against how fast time is passing.
 *
 * One construction, used wherever a budget appears. The reading is the
 * relationship between two marks rather than either alone:
 *
 * - **fill left of the tick** — spending slower than time. Good.
 * - **fill past the tick** — spending faster than time. Worth a look.
 * - **fill past the split** — into reserve: this cycle's plan is gone and what
 *   is being spent carried over from before.
 * - **fill to the end** — the envelope is empty.
 *
 * ## The split, and why the track is not simply the plan
 *
 * Delegate's envelopes carry over, so a line can have spent $100 of a $300 plan
 * while still holding $450. A bar drawn as spent-over-plan says 33% and says
 * nothing about the $450; a bar drawn over everything available says the line is
 * comfortable and hides that this cycle's money is going quickly.
 *
 * Both are true and neither is enough, so the track carries both: a fixed split
 * at 75%, plan to the left of it, reserve to the right. The fill counts up from
 * the left through the plan and on into the reserve, so crossing the split is
 * visible without a word.
 *
 * **The split is at a fixed position on every row, not proportional.** That is
 * deliberate and it is the whole reason the bar is legible in a column: the tick
 * is a *time* marker, identical on every line, and it must read as one straight
 * vertical down the page. Scaling each track to its own plan-plus-reserve would
 * put the tick somewhere different on every row and destroy that.
 *
 * The cost is that the reserve zone's width says nothing about how much reserve
 * there is — only that there is some. The figure beside the bar says how much.
 *
 * ## Red
 *
 * Red is **not** spent-exceeds-plan, which is what the design this came from
 * specified. In an envelope budget that condition is ordinary and often correct:
 * it is what carrying over is for. The fault is a line that has run out, so red
 * is a negative balance and nothing else.
 */

/** Where the plan ends and reserve begins, as a percentage of the track. */
export const SPLIT = 75;

/**
 * How far along the track the fill reaches, 0–100.
 *
 * Exported and pure because it is the whole semantic: everything else in this
 * file is markup. Three regimes, and the boundaries between them are what the
 * reader is actually looking at.
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
  const planned = plannedCents > 0n ? plannedCents : 0n;
  const reserve = balanceCents > 0n ? balanceCents : 0n;

  let fill: number;
  if (planned === 0n) {
    // An ad-hoc line with no standing amount. There is no plan to be paced
    // against, so the whole track is what it holds and the fill says how much
    // of that has gone.
    const available = spentCents + reserve;
    fill = available > 0n ? Number((spentCents * 100n) / available) : 0;
  } else if (spentCents <= planned) {
    // Inside the plan: the split is 100% of it, so spending the whole plan
    // fills exactly to the boundary.
    fill = Number((spentCents * BigInt(SPLIT)) / planned);
  } else {
    // Into reserve. Scaled by the reserve actually available, so a line with
    // little behind it reaches the end quickly — which is the honest picture.
    const over = spentCents - planned;
    const beyond = over + reserve;
    fill = SPLIT + (beyond > 0n ? Number((over * BigInt(100 - SPLIT)) / beyond) : 100 - SPLIT);
  }

  return Math.max(0, Math.min(fill, 100));
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
  /** What this cycle's Delegate press puts in — the plan. */
  readonly plannedCents: bigint;
  /** What the line actually holds now. Negative means overspent. */
  readonly balanceCents: bigint;
  readonly color: string | null;
  readonly cycleProgressBasisPoints: number | null;
  /** Names the bar for a screen reader; the figures are stated beside it too. */
  readonly label: string;
}): ReactNode {
  const empty = balanceCents <= 0n;

  const reserve = balanceCents > 0n ? balanceCents : 0n;
  const fill = paceFill({ spentCents, plannedCents, balanceCents });

  const tone = empty ? 'var(--color-negative)' : (color ?? 'var(--color-accent)');

  return (
    <span className="relative block h-2 w-full rounded bg-surface-2" role="img" aria-label={label}>
      {/* The reserve zone. Drawn only when there is reserve, so its presence is
          the signal — its width is fixed and says nothing about the amount. */}
      {reserve > 0n && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-0 rounded-r bg-surface-2"
          style={{ width: `${100 - SPLIT}%`, background: tone, opacity: 0.16 }}
        />
      )}

      {/* Spent, counting up from the left. */}
      <span
        aria-hidden="true"
        className="absolute top-[2.5px] left-[2px] h-[3px] rounded"
        style={{
          width: `calc(${fill}% - 4px)`,
          minWidth: fill > 0 ? '2px' : '0',
          background: tone,
        }}
      />

      {/* The boundary between plan and reserve. */}
      {reserve > 0n && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-line"
          style={{ left: `${SPLIT}%` }}
        />
      )}

      {/* Time. Inside the plan zone, so it lands identically on every row and
          reads as one straight line down the column. */}
      {cycleProgressBasisPoints !== null && (
        <span
          aria-hidden="true"
          className="absolute top-[1px] h-[6px] w-[1.5px] rounded-[1px] bg-axis"
          style={{ left: `${(cycleProgressBasisPoints / 10_000) * SPLIT}%` }}
        />
      )}
    </span>
  );
}
