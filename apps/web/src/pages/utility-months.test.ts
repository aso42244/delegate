import { describe, expect, it } from 'vitest';
import { visibleMonths } from './utility-months.js';

/** `[spend, complete]`, in window order. */
function months(
  ...entries: readonly (readonly [string, boolean])[]
): { month: string; spendCents: string; complete: boolean }[] {
  return entries.map(([spendCents, complete], index) => ({
    month: `2026-${String(index + 1).padStart(2, '0')}`,
    spendCents,
    complete,
  }));
}

describe('which months a utility charts', () => {
  it('drops the months before the first bill', () => {
    const shown = visibleMonths(months(['0', true], ['0', true], ['2100', true], ['1900', true]));
    expect(shown.map((m) => m.spendCents)).toEqual(['2100', '1900']);
  });

  /**
   * The rule this function exists for. Compressing a gap out of the series
   * would quietly redraw the history as though the bills were consecutive.
   */
  it('keeps an empty month between two bills', () => {
    const shown = visibleMonths(months(['2100', true], ['0', true], ['1900', true]));
    expect(shown.map((m) => m.spendCents)).toEqual(['2100', '0', '1900']);
  });

  it('drops a trailing empty month that has not finished', () => {
    const shown = visibleMonths(months(['2100', true], ['1900', true], ['0', false]));
    expect(shown.map((m) => m.spendCents)).toEqual(['2100', '1900']);
  });

  /** A finished month with no bill is a fact, not an absence of one. */
  it('keeps a trailing empty month that has finished', () => {
    const shown = visibleMonths(months(['2100', true], ['1900', true], ['0', true]));
    expect(shown.map((m) => m.spendCents)).toEqual(['2100', '1900', '0']);
  });

  it('keeps a trailing month that has a bill, finished or not', () => {
    const shown = visibleMonths(months(['2100', true], ['1900', false]));
    expect(shown.map((m) => m.spendCents)).toEqual(['2100', '1900']);
  });

  it('is empty when nothing was ever spent', () => {
    expect(visibleMonths(months(['0', true], ['0', false]))).toEqual([]);
    expect(visibleMonths([])).toEqual([]);
  });

  it('keeps one bill on its own', () => {
    expect(visibleMonths(months(['2100', true])).map((m) => m.spendCents)).toEqual(['2100']);
  });
});
