import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERVIEW_SPAN,
  isOverviewSpan,
  nextOverviewSpan,
  OVERVIEW_SPAN_COLUMNS,
  OVERVIEW_SPANS,
} from './overview.js';

describe('overview spans', () => {
  it('recognises exactly the four widths', () => {
    for (const span of OVERVIEW_SPANS) expect(isOverviewSpan(span)).toBe(true);
    // The names a second scale would have used, refused rather than coerced.
    for (const wrong of ['sm', 'md', 'lg', 'quarter', 'FULL', '']) {
      expect(isOverviewSpan(wrong)).toBe(false);
    }
  });

  it('defaults to the width every card always had', () => {
    expect(DEFAULT_OVERVIEW_SPAN).toBe('full');
    expect(OVERVIEW_SPAN_COLUMNS[DEFAULT_OVERVIEW_SPAN]).toBe(6);
  });

  it('divides the six columns exactly, so no span needs rounding', () => {
    for (const span of OVERVIEW_SPANS) {
      const columns = OVERVIEW_SPAN_COLUMNS[span];
      expect(Number.isInteger(columns)).toBe(true);
      expect(columns).toBeGreaterThan(0);
      expect(columns).toBeLessThanOrEqual(6);
    }
    // Three columns could not express "two side by side"; six can.
    expect(OVERVIEW_SPAN_COLUMNS.half * 2).toBe(6);
    expect(OVERVIEW_SPAN_COLUMNS.third * 3).toBe(6);
    expect(OVERVIEW_SPAN_COLUMNS.third + OVERVIEW_SPAN_COLUMNS['two-thirds']).toBe(6);
  });

  it('cycles through every width and returns to the start', () => {
    let span = DEFAULT_OVERVIEW_SPAN;
    const seen = new Set([span]);
    for (let step = 0; step < OVERVIEW_SPANS.length - 1; step += 1) {
      span = nextOverviewSpan(span);
      seen.add(span);
    }
    expect(seen.size).toBe(OVERVIEW_SPANS.length);
    expect(nextOverviewSpan(span)).toBe(DEFAULT_OVERVIEW_SPAN);
  });
});
