import { describe, expect, it } from 'vitest';
import { merchantKey, merchantTokens, suggestedMatchValue } from './merchants.js';

/**
 * The two pure halves of the suggestion: what makes two charges the same
 * merchant, and what a rule built from one of them should match on.
 *
 * The descriptions here are the shapes real feeds send — a reference fragment
 * glued to a name, a store number in the middle, a payment processor in front —
 * because every one of them breaks a different naive version of this.
 */

describe('merchantTokens', () => {
  it('drops digits, punctuation and the short fragments left behind', () => {
    expect(merchantTokens('AMAZON MKTPL*RT4G93')).toEqual(['amazon', 'mktpl']);
  });

  it('keeps the words of a plain description', () => {
    expect(merchantTokens('Whole Foods Market')).toEqual(['whole', 'foods', 'market']);
  });

  it('finds nothing in a bare reference number', () => {
    expect(merchantTokens('4829-1102-88')).toEqual([]);
  });
});

describe('merchantKey', () => {
  it('groups two charges from one merchant whose references differ', () => {
    expect(merchantKey('AMAZON MKTPL*RT4G93')).toBe(merchantKey('AMAZON MKTPL*ZX9WK1'));
  });

  it('groups two visits to one shop whose store numbers differ', () => {
    expect(merchantKey('KROGER #123 CINCINNATI')).toBe(merchantKey('KROGER #4471 CINCINNATI'));
  });

  it('keeps two different things at one brand apart', () => {
    expect(merchantKey('KROGER FUEL #12')).not.toBe(merchantKey('KROGER #12 CINCINNATI'));
  });

  it('falls back to the text itself when there is nothing to tokenize', () => {
    expect(merchantKey('4829-1102-88')).toBe('4829-1102-88');
  });
});

describe('suggestedMatchValue', () => {
  /*
   * The property that matters, on every shape: whatever comes back has to
   * actually match the description it came from. A needle that does not is a
   * rule that silently never fires.
   */
  const descriptions = [
    'AMAZON MKTPL*RT4G93',
    'KROGER #123 CINCINNATI OH',
    'SQ *BLUE BOTTLE COFFEE',
    'Whole Foods Market',
    '4829-1102-88',
  ];

  it('always returns text the description contains', () => {
    for (const description of descriptions) {
      expect(description.toLowerCase()).toContain(suggestedMatchValue(description).toLowerCase());
    }
  });

  it('takes the whole merchant name where the words are adjacent', () => {
    expect(suggestedMatchValue('AMAZON MKTPL*RT4G93')).toBe('AMAZON MKTPL');
  });

  it('stops at the first word when a store number interrupts the rest', () => {
    // "kroger cincinnati" is the key, and it appears nowhere in the description
    // — the number sits between the two words. A key is for grouping; only text
    // that is really there can be matched on.
    expect(suggestedMatchValue('KROGER #123 CINCINNATI OH')).toBe('KROGER');
  });

  it('keeps the casing of the description it came from', () => {
    expect(suggestedMatchValue('Whole Foods Market')).toBe('Whole Foods Market');
  });
});
