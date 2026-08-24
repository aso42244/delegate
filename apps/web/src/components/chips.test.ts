import { describe, expect, it } from 'vitest';
import { CHIPS, type ChipSpec } from './chips.js';

/**
 * The vocabulary's own rules, checked rather than trusted.
 *
 * A chip is a letter, and a letter is only legible because it means exactly one
 * thing everywhere. That is the sort of invariant which survives review and then
 * quietly breaks eight months later when somebody adds a chip on a page that
 * happens not to show the other one.
 */

const entries = Object.entries(CHIPS) as [string, ChipSpec][];

describe('the chip vocabulary', () => {
  it('gives no two chips the same mark', () => {
    const byMark = new Map<string, string[]>();
    for (const [kind, spec] of entries) {
      byMark.set(spec.mark, [...(byMark.get(spec.mark) ?? []), kind]);
    }

    const collisions = [...byMark].filter(([, kinds]) => kinds.length > 1);
    expect(collisions).toEqual([]);
  });

  it('keeps every mark to one letter, or two where one would collide', () => {
    for (const [kind, spec] of entries) {
      // `btc` is the single exception, and is a word before it is an
      // abbreviation.
      const limit = spec.mark === 'btc' ? 3 : 2;
      expect(spec.mark.length, `${kind} is "${spec.mark}"`).toBeLessThanOrEqual(limit);
      expect(spec.mark, `${kind}`).toBe(spec.mark.toLowerCase());
    }
  });

  it('gives every chip a meaning that is not just its own letter', () => {
    for (const [kind, spec] of entries) {
      expect(spec.meaning.length, `${kind}`).toBeGreaterThan(spec.mark.length + 2);
    }
  });
});
