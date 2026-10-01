import { describe, expect, it } from 'vitest';
import { compactCents } from './TimeSeries.js';

describe('compactCents', () => {
  it('shortens to the largest unit, in whole units by default', () => {
    expect(compactCents(26_500_000n)).toBe('$265k');
    expect(compactCents(120_000_000n)).toBe('$1M');
    expect(compactCents(48_000n)).toBe('$480');
    expect(compactCents(0n)).toBe('$0');
  });

  it('shows the decimals an axis needs to tell its ticks apart', () => {
    expect(compactCents(1_150_000n, 1)).toBe('$11.5k');
    expect(compactCents(1_200_000n, 1)).toBe('$12k');
    expect(compactCents(125_000_000n, 2)).toBe('$1.25M');
  });

  it('keeps the sign on a negative figure', () => {
    expect(compactCents(-48_000n)).toBe('-$480');
    expect(compactCents(-250_000n, 1)).toBe('-$2.5k');
  });
});
