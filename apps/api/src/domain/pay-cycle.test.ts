import { describe, expect, it } from 'vitest';
import { currentPaydayStart, nextPayday, payCycleAt } from './pay-cycle.js';

/** Date keys are UTC midnight — the shape `asDayKey` produces. */
const key = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const ZONE = 'America/Chicago';

describe('stepping', () => {
  it('walks fortnightly in both directions from the anchor', () => {
    const anchor = key('2026-09-11');

    // Before the anchor, and long after it: the anchor is a date somebody named,
    // not necessarily one in the future.
    expect(nextPayday(anchor, 'biweekly', key('2026-09-01'))).toEqual(key('2026-09-11'));
    expect(nextPayday(anchor, 'biweekly', key('2026-09-11'))).toEqual(key('2026-09-25'));
    expect(nextPayday(anchor, 'biweekly', key('2026-10-20'))).toEqual(key('2026-10-23'));
    expect(currentPaydayStart(anchor, 'biweekly', key('2026-09-20'))).toEqual(key('2026-09-11'));
  });

  it('treats payday itself as the start of a cycle, never the end', () => {
    const anchor = key('2026-09-11');
    // On payday the cycle is 0% through, not 100% of the previous one. A page
    // that read payday as the end would show every line fully spent that morning.
    expect(currentPaydayStart(anchor, 'biweekly', key('2026-09-11'))).toEqual(key('2026-09-11'));
    const cycle = payCycleAt(anchor, 'biweekly', new Date('2026-09-11T12:00:00Z'), 'UTC');
    expect(cycle?.elapsedDays).toBe(0);
    expect(cycle?.progress).toBe(0);
  });

  it('walks weekly', () => {
    const anchor = key('2026-09-04');
    expect(nextPayday(anchor, 'weekly', key('2026-09-05'))).toEqual(key('2026-09-11'));
    expect(currentPaydayStart(anchor, 'weekly', key('2026-09-05'))).toEqual(key('2026-09-04'));
  });

  it('walks monthly, clamping a day the next month does not have', () => {
    const anchor = key('2026-01-31');
    // February has no 31st. Clamped rather than spilling into March.
    expect(nextPayday(anchor, 'monthly', key('2026-02-01'))).toEqual(key('2026-02-28'));
    expect(nextPayday(anchor, 'monthly', key('2026-03-01'))).toEqual(key('2026-03-31'));
  });

  it('gives semi-monthly exactly two paydays a month, with no drift', () => {
    const anchor = key('2026-09-15');
    // 15th and 30th, derived from the anchor's own day plus its partner.
    expect(nextPayday(anchor, 'semimonthly', key('2026-09-16'))).toEqual(key('2026-09-30'));
    expect(nextPayday(anchor, 'semimonthly', key('2026-10-01'))).toEqual(key('2026-10-15'));

    // Twenty-four a year, counted rather than assumed: fifteen-day stepping
    // would drift five days over the same span.
    let count = 0;
    let cursor = key('2026-01-01');
    const stop = key('2027-01-01');
    while (cursor.getTime() < stop.getTime()) {
      cursor = nextPayday(anchor, 'semimonthly', cursor);
      if (cursor.getTime() < stop.getTime()) count += 1;
    }
    expect(count).toBe(24);
  });

  it('clamps a semi-monthly partner day into a short month', () => {
    const anchor = key('2026-01-15');
    // Partner is the 30th; February has no 30th.
    expect(nextPayday(anchor, 'semimonthly', key('2026-02-16'))).toEqual(key('2026-02-28'));
  });
});

describe('the cycle reading', () => {
  it('reports how far through, in whole days', () => {
    const anchor = key('2026-09-11');
    const cycle = payCycleAt(anchor, 'biweekly', new Date('2026-09-18T18:00:00Z'), 'UTC');

    expect(cycle?.start).toEqual(key('2026-09-11'));
    expect(cycle?.end).toEqual(key('2026-09-25'));
    expect(cycle?.lengthDays).toBe(14);
    expect(cycle?.elapsedDays).toBe(7);
    expect(cycle?.progress).toBe(0.5);
  });

  it('places the day in the household zone, not in UTC', () => {
    const anchor = key('2026-09-11');
    // 8pm in Chicago on the 17th is already the 18th in UTC. ADR 037: an
    // instant needs a zone to be placed in a day, and this is the arithmetic
    // that made an evening charge land in the wrong month once already.
    const evening = new Date('2026-09-18T01:00:00Z');
    expect(payCycleAt(anchor, 'biweekly', evening, ZONE)?.elapsedDays).toBe(6);
    expect(payCycleAt(anchor, 'biweekly', evening, 'UTC')?.elapsedDays).toBe(7);
  });

  it('is null with no anchor rather than guessing one', () => {
    // A tick drawn from a guessed schedule is a confident marker in the wrong
    // place, and every reading on the page is judged against it.
    expect(payCycleAt(null, 'biweekly', new Date(), ZONE)).toBeNull();
  });

  it('never reports past the end of the cycle', () => {
    const anchor = key('2026-09-11');
    const cycle = payCycleAt(anchor, 'biweekly', new Date('2026-09-24T23:00:00Z'), 'UTC');
    expect(cycle?.elapsedDays).toBeLessThanOrEqual(cycle!.lengthDays);
    expect(cycle?.progress).toBeLessThanOrEqual(1);
  });
});
