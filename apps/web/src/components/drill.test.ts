import { describe, expect, it } from 'vitest';
import { reconciles, registerHref } from './drill.js';

describe('registerHref', () => {
  it('writes only the filters given, in one order, and the figure it came from', () => {
    const href = registerHref(
      {
        kind: 'normal',
        groupingId: 'none',
        dateFrom: '2026-09-25T05:00:00.000Z',
        dateBefore: null,
      },
      { label: 'No grouping on Spending by grouping', cents: 21904n },
    );
    expect(href).toBe(
      '/transactions?groupingId=none&kind=normal&dateFrom=2026-09-25T05%3A00%3A00.000Z' +
        '&figure=No+grouping+on+Spending+by+grouping&expect=21904',
    );
  });

  it('leaves out a window of "ever"', () => {
    expect(registerHref({ kind: 'income', dateFrom: null })).toBe('/transactions?kind=income');
  });
});

describe('reconciles', () => {
  it('compares magnitudes, because spending is drawn positive and stored negative', () => {
    expect(reconciles(-21904n, 21904n)).toBe(true);
    expect(reconciles(21904n, 21904n)).toBe(true);
    expect(reconciles(-21903n, 21904n)).toBe(false);
  });
});
