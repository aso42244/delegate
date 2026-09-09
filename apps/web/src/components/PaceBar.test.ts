import { describe, expect, it } from 'vitest';

import { carriedIn, paceFill, paceSummary, SPLIT } from './PaceBar.jsx';

/** $ amounts as cents, so the tests read like the rows they describe. */
const d = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

/**
 * A line as the panel sees it. `balance` is what it holds now, so `spent +
 * balance` is what this cycle had — which is the number the track is scaled to.
 */
const line = (
  planned: number,
  spent: number,
  balance: number,
): { plannedCents: bigint; spentCents: bigint; balanceCents: bigint } => ({
  plannedCents: d(planned),
  spentCents: d(spent),
  balanceCents: d(balance),
});

describe('the fill', () => {
  it('starts empty', () => {
    expect(paceFill(line(300, 0, 300))).toBe(0);
  });

  it('is proportional to what the cycle had, not to the delegation', () => {
    // $300 delegated with $450 carried in is $750 to spend. Half of it is half
    // of the cycle zone — the carried money is part of the question, not beside
    // it.
    expect(paceFill(line(300, 375, 375))).toBe(SPLIT / 2);
  });

  it('reaches exactly the split when everything the cycle had is gone', () => {
    expect(paceFill(line(300, 500, 0))).toBe(SPLIT);
  });

  it('stays inside the cycle zone while a line spends past its delegation', () => {
    // $55 delegated, $146 carried, $101 spent: over the delegation and nowhere
    // near out of money. Nothing here is red.
    const fill = paceFill(line(55, 101, 100));
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThan(SPLIT);
  });

  it('runs into the overspend zone once the line is negative', () => {
    const fill = paceFill(line(300, 550, -50));
    expect(fill).toBeGreaterThan(SPLIT);
    expect(fill).toBeLessThan(100);
  });

  it('fills the overspend zone at a quarter past what the cycle had', () => {
    // $400 available, $100 over: exactly a quarter, so the zone is full.
    expect(paceFill(line(400, 500, -100))).toBe(100);
  });

  it('scales a line that opened the cycle underwater against its delegation', () => {
    // $100 delegated, $150 deficit carried in, nothing spent: $50 in the hole
    // before the first dollar, which is deep against a $100 line.
    expect(paceFill(line(100, 0, -50))).toBe(100);
  });

  it('paces an ad-hoc line against what it holds', () => {
    // No delegation, so what carried over is the whole of what there is.
    expect(paceFill(line(0, 50, 50))).toBe(SPLIT / 2);
    expect(paceFill(line(0, 0, 100))).toBe(0);
  });

  it('draws nothing for a line with nothing in it and nothing spent', () => {
    expect(paceFill(line(0, 0, 0))).toBe(0);
  });

  it('reads a refund as no spending rather than negative spending', () => {
    expect(paceFill(line(300, -20, 320))).toBe(0);
  });

  it('never leaves the track, whatever the figures', () => {
    const cases: [number, number, number][] = [
      [1, 10_000, -9_999],
      [10_000, 0, 10_000],
      [300, 500, -1_000],
      [0, 0, -500],
      [10_000, 1, 9_999],
    ];
    for (const [planned, spent, balance] of cases) {
      const fill = paceFill(line(planned, spent, balance));
      expect(fill).toBeGreaterThanOrEqual(0);
      expect(fill).toBeLessThanOrEqual(100);
    }
  });

  it('puts the tick and the fill on the same scale', () => {
    // Half the cycle's money gone at half the cycle's time is the same
    // coordinate. This is the only reason the two marks can be compared.
    const halfway = (5_000 / 10_000) * SPLIT;
    expect(paceFill(line(300, 150, 150))).toBe(halfway);
  });
});

describe('a transfer between two lines', () => {
  /*
   * The owner's own worked example, because this is the property that makes the
   * bar trustworthy day to day and it is not obvious from the formula.
   *
   * What the cycle had is `spent + balance`, which is derived rather than
   * assembled — so money moved between lines is already in it. There is no
   * transfer term to add and nothing to keep in step: a transfer moves the
   * balance, and the balance is half the sum.
   */
  it('takes a line out of the red without touching what it spent', () => {
    // $55 delegated, $59.24 carried in, $134.24 spent: $20 past what it had.
    const before = line(55, 134.24, -20);
    expect(paceFill(before)).toBeGreaterThan(SPLIT);

    // $20 transferred in. Spending is untouched; the balance is not.
    const after = { ...before, balanceCents: 0n };
    expect(paceFill(after)).toBe(SPLIT);
    expect(paceSummary(after)).toContain('$134 spent of $134');
  });

  it('takes the same money off what the other line has to spend', () => {
    const before = line(725, 565.53, 264.63);
    const after = { ...before, balanceCents: before.balanceCents - d(20) };

    // $830.16 to spend becomes $810.16 — and it moved without anything being
    // spent, which is exactly what a transfer is.
    expect(paceSummary(before)).toContain('of $830');
    expect(paceSummary(after)).toContain('of $810');
    expect(paceFill(after)).toBeGreaterThan(paceFill(before));
  });
});

describe('what carried in', () => {
  it('is what there was, less what this cycle put in', () => {
    expect(carriedIn(line(725, 565.53, 264.63))).toBe(d(105.16));
  });

  it('is negative for a line that carried a deficit', () => {
    expect(carriedIn(line(100, 0, -40))).toBe(d(-140));
  });

  it('is nothing for a line spending exactly its delegation', () => {
    expect(carriedIn(line(300, 100, 200))).toBe(0n);
  });
});

describe('the hover text', () => {
  it('states the figures and never a verdict', () => {
    const text = paceSummary(line(725, 565.53, 264.63));
    expect(text).toBe('$566 spent of $830 · $105 carried in');
    expect(text).not.toMatch(/pace|out of money|over budget/i);
  });

  it('names a deficit as a deficit', () => {
    expect(paceSummary(line(100, 0, -40))).toBe('$0 spent of -$40 · $140 deficit carried in');
  });

  it('says so when nothing carried in', () => {
    expect(paceSummary(line(300, 100, 200))).toBe('$100 spent of $300 · nothing carried in');
  });
});
