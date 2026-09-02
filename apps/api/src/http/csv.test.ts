import { describe, expect, it } from 'vitest';
import { csvField, csvFile, csvMoney, raw } from './csv.js';

/**
 * The two things about a CSV that are not obvious, and one that is.
 *
 * A spreadsheet is not a text file with commas in it: it evaluates some cells
 * and adds up others, and both of those are decided by the first character.
 */

describe('money', () => {
  it('writes cents as a decimal a spreadsheet can add up', () => {
    expect(csvMoney(-4210n)).toBe('-42.10');
    expect(csvMoney(0n)).toBe('0.00');
    expect(csvMoney(5n)).toBe('0.05');
  });

  it('never passes a large value through a float', () => {
    // Beyond Number.MAX_SAFE_INTEGER: the whole reason money is BIGINT.
    expect(csvMoney(90071992547409910n)).toBe('900719925474099.10');
  });
});

describe('fields', () => {
  it('quotes and escapes what the bank wrote', () => {
    expect(csvField('SQ *JIM"S, DINER')).toBe('"SQ *JIM""S, DINER"');
  });

  it('defuses a description that a spreadsheet would run', () => {
    // `=HYPERLINK(...)` in a merchant name is a real way to hand somebody a
    // document that does something when they open it.
    expect(csvField('=HYPERLINK("http://example.test")')).toBe(
      '"\'=HYPERLINK(""http://example.test"")"',
    );
  });

  it('leaves a negative amount alone, because it is a number', () => {
    // The guard applied to everything would turn every debit into text, which
    // breaks the column somebody came to the export to sum.
    expect(csvField(raw('-42.10'))).toBe('"-42.10"');
  });
});

describe('a file', () => {
  it('is a header row and then the rows', () => {
    expect(csvFile(['date', 'amount'], [[raw('2026-08-05'), raw('-42.10')]])).toBe(
      '"date","amount"\n"2026-08-05","-42.10"\n',
    );
  });
});
