import { describe, expect, it } from 'vitest';
import { cyclesUntil, targetProgress } from './targets.js';

/**
 * A target's arithmetic.
 *
 * The property that matters most is the one that is not arithmetic at all: none
 * of this touches the amount to delegate. It reads that figure and compares
 * against it, and every function here is pure — a target cannot move money by
 * existing.
 */

const DEC_27 = new Date('2026-12-27T00:00:00.000Z');
const SEP_02 = new Date('2026-09-02T00:00:00.000Z');

describe('paychecks left', () => {
  it('counts whole cycles, and never rounds one up', () => {
    // 116 days at 14 a cycle is 8.28 — eight paychecks, not nine. Rounding up
    // reports a per-cycle figure no actual payday delivers.
    expect(cyclesUntil(DEC_27, SEP_02, 'biweekly')).toBe(8);
  });

  it('is one while the date is still ahead, however close', () => {
    // Four days out there is still one more chance to fund it, and the figure
    // wanted is the whole shortfall rather than a fraction of it.
    expect(cyclesUntil(DEC_27, new Date('2026-12-23T00:00:00.000Z'), 'biweekly')).toBe(1);
  });

  it('is zero once the day has passed', () => {
    expect(cyclesUntil(DEC_27, new Date('2026-12-28T00:00:00.000Z'), 'biweekly')).toBe(0);
  });

  it('follows the cadence', () => {
    expect(cyclesUntil(DEC_27, SEP_02, 'monthly')).toBe(3);
    expect(cyclesUntil(DEC_27, SEP_02, 'weekly')).toBe(16);
  });
});

describe('a target with a date', () => {
  const line = {
    balanceCents: 40000n,
    amountToDelegateCents: 10000n,
    targetCents: 220000n,
    targetDate: DEC_27,
  };

  it('says what each remaining paycheck has to carry', () => {
    const progress = targetProgress(line, 'biweekly', SEP_02);

    expect(progress?.shortfallCents).toBe(180000n);
    expect(progress?.cyclesRemaining).toBe(8);
    // $1,800 over eight paychecks.
    expect(progress?.neededPerCycleCents).toBe(22500n);
  });

  it('is behind when the line delegates less than that', () => {
    expect(targetProgress(line, 'biweekly', SEP_02)?.status).toBe('behind');
  });

  it('is on course when it delegates at least that', () => {
    const funded = { ...line, amountToDelegateCents: 22500n };
    expect(targetProgress(funded, 'biweekly', SEP_02)?.status).toBe('on_track');
  });

  it('rounds the per-cycle figure up, so the last paycheck is not short', () => {
    // $101 over two: $50.50 each, and a line funded at $50 misses by a cent on
    // the day it matters — the quiet miss this exists to surface, not create.
    const odd = {
      balanceCents: 0n,
      amountToDelegateCents: 5000n,
      targetCents: 10100n,
      targetDate: new Date('2026-10-02T00:00:00.000Z'),
    };
    const progress = targetProgress(odd, 'monthly', SEP_02);
    expect(progress?.cyclesRemaining).toBe(1);
    expect(progress?.neededPerCycleCents).toBe(10100n);
  });

  it('asks for the whole shortfall once the date has gone', () => {
    const late = targetProgress(line, 'biweekly', new Date('2027-01-05T00:00:00.000Z'));
    expect(late?.cyclesRemaining).toBe(0);
    expect(late?.neededPerCycleCents).toBe(180000n);
    expect(late?.status).toBe('behind');
  });

  it('is met once the balance reaches it, whatever the date says', () => {
    const done = { ...line, balanceCents: 220000n };
    const progress = targetProgress(done, 'biweekly', SEP_02);
    expect(progress?.status).toBe('met');
    expect(progress?.shortfallCents).toBe(0n);
  });

  it('treats an ad-hoc line as delegating nothing', () => {
    // Null is not zero on the amount to delegate — it means "add nothing when
    // Delegate is pressed" — and for this comparison both put nothing in.
    const adhoc = { ...line, amountToDelegateCents: null };
    expect(targetProgress(adhoc, 'biweekly', SEP_02)?.status).toBe('behind');
  });
});

describe('a target with no date', () => {
  it('reports a shortfall and no schedule', () => {
    const progress = targetProgress(
      {
        balanceCents: 20000n,
        amountToDelegateCents: 5000n,
        targetCents: 50000n,
        targetDate: null,
      },
      'biweekly',
      SEP_02,
    );

    // Not "behind": nothing was due, so nothing is late. There is simply less
    // in the envelope than the household wants kept there.
    expect(progress?.status).toBe('standing');
    expect(progress?.shortfallCents).toBe(30000n);
    expect(progress?.neededPerCycleCents).toBeNull();
  });
});

describe('no target', () => {
  it('reads as nothing at all', () => {
    expect(
      targetProgress(
        {
          balanceCents: 20000n,
          amountToDelegateCents: 5000n,
          targetCents: null,
          targetDate: null,
        },
        'biweekly',
        SEP_02,
      ),
    ).toBeNull();
  });
});
