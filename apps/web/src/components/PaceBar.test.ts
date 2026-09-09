import { describe, expect, it } from 'vitest';
import { paceFill, SPLIT } from './PaceBar.jsx';

/** $ amounts as cents, so the tests read like the rows they describe. */
const d = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

describe('the fill', () => {
  it('reaches exactly the split when the plan is spent and no more', () => {
    // The boundary is the whole point: at the split you have spent this cycle's
    // money and not a penny of what carried over.
    expect(paceFill({ spentCents: d(300), plannedCents: d(300), balanceCents: d(0) })).toBe(SPLIT);
  });

  it('is proportional inside the plan', () => {
    expect(paceFill({ spentCents: d(100), plannedCents: d(300), balanceCents: d(450) })).toBe(25);
    expect(paceFill({ spentCents: d(150), plannedCents: d(300), balanceCents: d(400) })).toBe(37);
  });

  it('starts empty', () => {
    expect(paceFill({ spentCents: 0n, plannedCents: d(300), balanceCents: d(300) })).toBe(0);
  });

  it('runs into the reserve zone once the plan is gone', () => {
    // $300 planned, $400 spent, $200 still held: past the split, not at the end.
    const fill = paceFill({ spentCents: d(400), plannedCents: d(300), balanceCents: d(200) });
    expect(fill).toBeGreaterThan(SPLIT);
    expect(fill).toBeLessThan(100);
  });

  it('reaches the end exactly when the envelope is empty', () => {
    // Everything spent and nothing held: there is no more to spend, and the bar
    // says so without needing a colour to carry it.
    expect(paceFill({ spentCents: d(500), plannedCents: d(300), balanceCents: 0n })).toBe(100);
  });

  it('stays at the end when the line is overspent', () => {
    // A negative balance cannot draw past the track, and clamping here is what
    // keeps the bar inside its own box.
    expect(paceFill({ spentCents: d(500), plannedCents: d(300), balanceCents: d(-50) })).toBe(100);
  });

  it('paces an ad-hoc line against what it holds', () => {
    // No standing amount, so there is no plan to be paced against — the track
    // becomes what the line holds, and the fill is how much of it has gone.
    expect(paceFill({ spentCents: d(50), plannedCents: 0n, balanceCents: d(50) })).toBe(50);
    expect(paceFill({ spentCents: 0n, plannedCents: 0n, balanceCents: d(100) })).toBe(0);
  });

  it('draws nothing for a line with nothing in it and nothing spent', () => {
    expect(paceFill({ spentCents: 0n, plannedCents: 0n, balanceCents: 0n })).toBe(0);
  });

  it('never leaves the track, whatever the figures', () => {
    const cases: [number, number, number][] = [
      [10_000, 1, 0],
      [0, 1, 10_000],
      [500, 300, -1_000],
      [1, 10_000, 10_000],
    ];
    for (const [spent, planned, balance] of cases) {
      const fill = paceFill({
        spentCents: d(spent),
        plannedCents: d(planned),
        balanceCents: d(balance),
      });
      expect(fill).toBeGreaterThanOrEqual(0);
      expect(fill).toBeLessThanOrEqual(100);
    }
  });
});
