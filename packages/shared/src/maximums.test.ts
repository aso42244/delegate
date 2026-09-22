import { describe, expect, it } from 'vitest';
import { amountThatFits, maximumProgress } from './maximums.js';

/**
 * A maximum's arithmetic.
 *
 * The case this exists for is the owner's own: a line capped at $400, set to
 * receive $200 a paycheck, already holding $275. The next press puts $125 in and
 * leaves $75 undelegated — available at the top of the page rather than pushed
 * anywhere.
 *
 * Everything here is pure, and the property worth holding is that
 * `amountThatFits` is the only answer: the run and every reading of it go
 * through this one function, so a dialog cannot promise a figure the ledger then
 * disagrees with.
 */

const line = {
  balanceCents: 27_500n,
  amountToDelegateCents: 20_000n,
  maxBalanceCents: 40_000n,
};

describe('the owner’s case', () => {
  it('delegates only what fits and holds the rest back', () => {
    expect(amountThatFits(line)).toBe(12_500n);

    const reading = maximumProgress(line);
    expect(reading).toEqual({
      maxBalanceCents: 40_000n,
      roomCents: 12_500n,
      delegatingCents: 12_500n,
      withheldCents: 7_500n,
      status: 'partial',
    });
  });
});

describe('a maximum that is not in the way', () => {
  it('passes the whole amount through', () => {
    const room = { ...line, balanceCents: 5_000n };
    expect(amountThatFits(room)).toBe(20_000n);
    expect(maximumProgress(room)?.status).toBe('room');
    expect(maximumProgress(room)?.withheldCents).toBe(0n);
  });

  it('is not there at all when the column is null', () => {
    const uncapped = { ...line, maxBalanceCents: null };
    expect(amountThatFits(uncapped)).toBe(20_000n);
    expect(maximumProgress(uncapped)).toBeNull();
  });
});

describe('a line that is already full', () => {
  it('receives nothing, and the whole amount is held back', () => {
    const full = { ...line, balanceCents: 40_000n };
    expect(amountThatFits(full)).toBe(0n);
    expect(maximumProgress(full)).toMatchObject({
      roomCents: 0n,
      delegatingCents: 0n,
      withheldCents: 20_000n,
      status: 'full',
    });
  });

  it('reports no room rather than negative room when it is over', () => {
    // A transfer, a refund or an adjustment may take a line past its maximum;
    // none of those is refused. Room is what still fits, and nothing does.
    const over = { ...line, balanceCents: 55_000n };
    expect(amountThatFits(over)).toBe(0n);
    expect(maximumProgress(over)?.roomCents).toBe(0n);
  });
});

describe('what a maximum has nothing to say about', () => {
  it('leaves an ad-hoc line alone', () => {
    // Null is not zero, but both move nothing here — and nothing is held back,
    // because nothing was going in.
    const adHoc = { ...line, amountToDelegateCents: null };
    expect(amountThatFits(adHoc)).toBe(0n);
    expect(maximumProgress(adHoc)).toMatchObject({ withheldCents: 0n, status: 'room' });
  });

  it('lets a negative amount take money out of a full line', () => {
    // A cap is about not putting too much in. Refusing a withdrawal because the
    // line is already full would be the opposite of what it says.
    const draining = { ...line, balanceCents: 40_000n, amountToDelegateCents: -5_000n };
    expect(amountThatFits(draining)).toBe(-5_000n);
    expect(maximumProgress(draining)?.withheldCents).toBe(0n);
  });

  it('funds a negative line up to the maximum, not up to zero', () => {
    // An over-spent line has more room than its maximum, not less.
    const overspent = { ...line, balanceCents: -10_000n };
    expect(amountThatFits(overspent)).toBe(20_000n);
    expect(maximumProgress(overspent)?.roomCents).toBe(50_000n);
  });
});
