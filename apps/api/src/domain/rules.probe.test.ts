import { describe, expect, it } from 'vitest';
import { assertPatternAcceptable } from './rules.js';

/**
 * Catastrophic backtracking, refused by measurement rather than by reading.
 *
 * The shape check catches `(a+)+` and explains itself, which is worth keeping.
 * It is still only a heuristic over syntax, and the standard counter-example has
 * no nested quantifier at all: `(a|a)+$` is exponential and looks harmless. On
 * this machine it took **213 seconds** against a 120-character input, which is
 * also why the probe climbs and stops rather than testing one long string — the
 * check would otherwise be a worse denial of service than the pattern.
 */

describe('patterns that would hang a sync', () => {
  it('refuses the ones the shape check catches', () => {
    for (const pattern of ['(a+)+$', '(a*)*$', '([a-z]+)+$']) {
      expect(() => assertPatternAcceptable('regex', pattern), pattern).toThrow(/hang|too long/i);
    }
  });

  it('refuses the ones it does not', () => {
    // No nested quantifier in either. Alternation whose branches overlap is
    // exponential and looks entirely reasonable, which is the gap the timing
    // closes and the shape check cannot.
    for (const pattern of ['(a|a)+$', '(a|aa)+$']) {
      expect(() => assertPatternAcceptable('regex', pattern), pattern).toThrow(/too long/i);
    }
  });

  it('refuses `^(\\w+\\s?)*$` too, by whichever check gets there first', () => {
    // This one has both problems. Asserting the specific message would be
    // asserting which check ran, which is not the behaviour anybody depends on.
    expect(() => assertPatternAcceptable('regex', '^(\\w+\\s?)*$')).toThrow();
  });

  it('takes an ordinary rule without complaint', () => {
    for (const pattern of [
      '^ACH DEPOSIT .*PAYROLL',
      'COSTCO|TARGET|AMAZON',
      '(ELO|PROF)\\s+L\\s+PAYROLL',
      '^\\d{4}-\\d{2}-\\d{2} ',
      'WHOLE ?FOODS',
    ]) {
      expect(() => assertPatternAcceptable('regex', pattern), pattern).not.toThrow();
    }
  });

  it('returns quickly even when refusing', () => {
    // The check is bounded. Before this it was not: the same decision took over
    // three minutes.
    const started = Date.now();
    expect(() => assertPatternAcceptable('regex', '(a|a)+$')).toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('leaves the other match modes alone', () => {
    // `contains` is not a pattern and never compiled.
    expect(() => assertPatternAcceptable('contains', '(a|a)+$')).not.toThrow();
  });
});
