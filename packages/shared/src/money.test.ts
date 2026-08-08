import { describe, expect, it } from 'vitest';
import {
  MoneyParseError,
  ZERO_CENTS,
  absCents,
  addCents,
  allocateByWeight,
  cents,
  centsFromJson,
  centsToJson,
  formatCents,
  formatCentsForInput,
  negateCents,
  parseMoney,
  splitEvenly,
  subCents,
  sumCents,
  tryParseMoney,
} from './money.js';

describe('cents', () => {
  it('accepts whole numbers and bigints', () => {
    expect(cents(1234)).toBe(1234n);
    expect(cents(-1234n)).toBe(-1234n);
    expect(cents(0)).toBe(0n);
  });

  it('rejects fractional numbers rather than rounding them', () => {
    expect(() => cents(12.5)).toThrow(TypeError);
    expect(() => cents(0.1 + 0.2)).toThrow(TypeError);
  });

  it('rejects values beyond the safe integer range', () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 2)).toThrow();
  });

  it('carries values a JS number could not hold, as bigint', () => {
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(cents(huge)).toBe(huge);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and absolutes', () => {
    expect(addCents(cents(650_00), cents(25_00))).toBe(675_00n);
    expect(subCents(cents(650_00), cents(675_00))).toBe(-25_00n);
    expect(negateCents(cents(-1))).toBe(1n);
    expect(absCents(cents(-98_76))).toBe(98_76n);
    expect(absCents(cents(98_76))).toBe(98_76n);
  });

  it('sums an empty iterable to zero', () => {
    expect(sumCents([])).toBe(ZERO_CENTS);
  });

  it('sums large collections without precision loss', () => {
    const values = Array.from({ length: 10_000 }, () => cents(1_000_000_01));
    expect(sumCents(values)).toBe(1_000_000_01n * 10_000n);
  });
});

describe('parseMoney', () => {
  it.each([
    ['0', 0n],
    ['1', 100n],
    ['1.5', 150n],
    ['1.50', 150n],
    ['.5', 50n],
    ['1.', 100n],
    ['12.34', 1234n],
    ['$12.34', 1234n],
    ['1,234.56', 123456n],
    ['$1,234,567.89', 123456789n],
    ['-12.34', -1234n],
    ['+12.34', 1234n],
    ['(12.34)', -1234n],
    ['  $1,000.00  ', 100000n],
    ['-0.01', -1n],
    ['0.00', 0n],
  ])('reads %s as %s cents', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['abc', 'not a number'],
    ['1.005', 'sub-cent precision'],
    ['1.234', 'sub-cent precision'],
    ['-(12.34)', 'double negative'],
    ['12..34', 'malformed'],
    ['1,23.45', 'malformed grouping'],
    ['$', 'no digits'],
    ['--5', 'double sign'],
    ['1 234', 'space separator'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseMoney(input)).toThrow(MoneyParseError);
  });

  it('reports failures without throwing when asked', () => {
    const bad = tryParseMoney('1.005');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('finer than one cent');

    const good = tryParseMoney('$40.00');
    expect(good).toEqual({ ok: true, value: 4000n });
  });

  it('round-trips through the input formatter', () => {
    for (const value of [0n, 1n, -1n, 99n, 100n, -123456789n, 500n]) {
      expect(parseMoney(formatCentsForInput(cents(value)))).toBe(value);
    }
  });
});

describe('formatCents', () => {
  it.each([
    [0n, '$0.00'],
    [1n, '$0.01'],
    [-1n, '-$0.01'],
    [100n, '$1.00'],
    [123456n, '$1,234.56'],
    [-123456n, '-$1,234.56'],
    [489000n, '$4,890.00'],
    [-21200n, '-$212.00'],
    [100000000n, '$1,000,000.00'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatCents(cents(value))).toBe(expected);
  });

  it('supports accounting negatives, plain output and explicit plus', () => {
    expect(formatCents(cents(-1234), { accountingNegative: true })).toBe('($12.34)');
    expect(formatCents(cents(1234), { currencySymbol: false })).toBe('12.34');
    expect(formatCents(cents(1234567), { grouping: false })).toBe('$12345.67');
    expect(formatCents(cents(1234), { explicitPlus: true })).toBe('+$12.34');
    expect(formatCents(cents(0), { explicitPlus: true })).toBe('$0.00');
  });

  it('always shows exactly two decimal places', () => {
    expect(formatCents(cents(1005))).toBe('$10.05');
    expect(formatCents(cents(1050))).toBe('$10.50');
    expect(formatCents(cents(1000))).toBe('$10.00');
  });
});

describe('splitEvenly', () => {
  it('divides evenly when it can', () => {
    expect(splitEvenly(cents(900), 3)).toEqual([300n, 300n, 300n]);
  });

  it('hands the remainder out one cent at a time', () => {
    expect(splitEvenly(cents(1000), 3)).toEqual([334n, 333n, 333n]);
    expect(splitEvenly(cents(1), 3)).toEqual([1n, 0n, 0n]);
    expect(splitEvenly(cents(2), 3)).toEqual([1n, 1n, 0n]);
  });

  it('keeps negatives summing to the original', () => {
    expect(splitEvenly(cents(-1000), 3)).toEqual([-334n, -333n, -333n]);
  });

  it('sums to exactly the total for every total and part count', () => {
    for (let total = -250; total <= 250; total += 1) {
      for (let parts = 1; parts <= 13; parts += 1) {
        const shares = splitEvenly(cents(total), parts);
        expect(shares).toHaveLength(parts);
        expect(sumCents(shares)).toBe(BigInt(total));
      }
    }
  });

  it('rejects nonsensical part counts', () => {
    expect(() => splitEvenly(cents(100), 0)).toThrow(RangeError);
    expect(() => splitEvenly(cents(100), -1)).toThrow(RangeError);
    expect(() => splitEvenly(cents(100), 1.5)).toThrow(RangeError);
  });
});

describe('allocateByWeight', () => {
  it('allocates proportionally', () => {
    expect(allocateByWeight(cents(10000), [1n, 1n])).toEqual([5000n, 5000n]);
    expect(allocateByWeight(cents(10000), [3n, 1n])).toEqual([7500n, 2500n]);
  });

  it('gives the leftover cent to the largest remainder, earliest index on a tie', () => {
    // 100 / 3 → 33.33 each, one cent left over.
    expect(allocateByWeight(cents(100), [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    // Weights 1:1:1:1 over 10 → 2.5 each, two cents left.
    expect(allocateByWeight(cents(10), [1n, 1n, 1n, 1n])).toEqual([3n, 3n, 2n, 2n]);
  });

  it('gives zero to zero weights', () => {
    expect(allocateByWeight(cents(10000), [1n, 0n])).toEqual([10000n, 0n]);
  });

  it('sums to exactly the total across a wide sweep', () => {
    const weightSets: bigint[][] = [
      [1n, 2n, 3n],
      [7n, 11n, 13n, 17n],
      [1n],
      [1n, 0n, 0n, 5n],
      [100n, 1n],
    ];
    for (const weights of weightSets) {
      for (let total = -137; total <= 137; total += 1) {
        const shares = allocateByWeight(cents(total), weights);
        expect(shares).toHaveLength(weights.length);
        expect(sumCents(shares)).toBe(BigInt(total));
      }
    }
  });

  it('rejects impossible weightings', () => {
    expect(() => allocateByWeight(cents(100), [])).toThrow(RangeError);
    expect(() => allocateByWeight(cents(100), [0n, 0n])).toThrow(RangeError);
    expect(() => allocateByWeight(cents(100), [1n, -1n])).toThrow(RangeError);
  });
});

describe('JSON serialization', () => {
  it('carries cents as a decimal string, because JSON.stringify throws on bigint', () => {
    expect(() => JSON.stringify({ balance: 1234n })).toThrow(TypeError);
    expect(centsToJson(cents(-1234))).toBe('-1234');
    expect(JSON.stringify({ balance: centsToJson(cents(-1234)) })).toBe('{"balance":"-1234"}');
  });

  it('round-trips exactly, including values beyond Number.MAX_SAFE_INTEGER', () => {
    for (const value of [0n, -1n, 1n, 123456789n, 9_007_199_254_740_993n]) {
      expect(centsFromJson(centsToJson(cents(value)))).toBe(value);
    }
  });

  it('rejects anything that is not a whole number of cents', () => {
    expect(() => centsFromJson('12.34')).toThrow(TypeError);
    expect(() => centsFromJson('')).toThrow(TypeError);
    expect(() => centsFromJson('1e3')).toThrow(TypeError);
    expect(() => centsFromJson('abc')).toThrow(TypeError);
  });
});
