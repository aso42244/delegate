import { describe, expect, it } from 'vitest';
import { asSnapshotDate, snapshotDateFor } from './snapshots.js';

/**
 * Which day a run is labelled with.
 *
 * A run at 03:10 on the 15th produces rows dated the 14th, read as "end of day
 * the 14th". That is deliberate and is not to be changed — but it has to be the
 * previous day **in the household's zone**, and it has to survive the two
 * mornings a year that are not 24 hours long.
 */

const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('the date a snapshot is labelled with', () => {
  it('is the previous day', () => {
    // 03:10 CST on the 15th of June is 08:10 UTC.
    expect(iso(snapshotDateFor(new Date('2026-06-15T08:10:00Z'), 'America/Chicago'))).toBe(
      '2026-06-14',
    );
  });

  it('is midnight UTC, which is how every other date here is filed', () => {
    const date = snapshotDateFor(new Date('2026-06-15T08:10:00Z'), 'America/Chicago');
    expect(date.toISOString()).toBe('2026-06-14T00:00:00.000Z');
  });

  /**
   * The reason the zone is read at all. This instant is already the 15th in UTC
   * and still the 14th in Chicago, so a UTC-based answer would label the row for
   * the 14th when the household's 14th has not finished.
   */
  it('reads the calendar in the household zone, not in UTC', () => {
    const lateEvening = new Date('2026-03-15T04:10:00Z'); // 23:10 on the 14th, CDT
    expect(iso(snapshotDateFor(lateEvening, 'America/Chicago'))).toBe('2026-03-13');
    expect(iso(snapshotDateFor(lateEvening, 'UTC'))).toBe('2026-03-14');
  });

  describe('across a boundary', () => {
    it('crosses the start of a month', () => {
      expect(iso(snapshotDateFor(new Date('2026-03-01T09:10:00Z'), 'America/Chicago'))).toBe(
        '2026-02-28',
      );
    });

    it('crosses the start of a year', () => {
      expect(iso(snapshotDateFor(new Date('2026-01-01T09:10:00Z'), 'America/Chicago'))).toBe(
        '2025-12-31',
      );
    });

    it('handles a leap day', () => {
      // 2028 is a leap year, so the day before the 1st of March is the 29th.
      expect(iso(snapshotDateFor(new Date('2028-03-01T09:10:00Z'), 'America/Chicago'))).toBe(
        '2028-02-29',
      );
    });
  });

  /**
   * The two mornings a year that are not 24 hours long.
   *
   * Calendar arithmetic on the local date rather than subtracting 24 hours from
   * the instant: on the spring-forward morning the previous local day is 23
   * hours back and on the autumn one it is 25, so an instant-based answer is
   * wrong for any run close enough to midnight.
   */
  describe('across a daylight saving change', () => {
    it('labels the spring-forward morning with the day before it', () => {
      // 2026-03-08 is when US clocks go forward; 03:10 CDT is 08:10 UTC.
      expect(iso(snapshotDateFor(new Date('2026-03-08T08:10:00Z'), 'America/Chicago'))).toBe(
        '2026-03-07',
      );
    });

    it('labels the autumn morning with the day before it', () => {
      // 2026-11-01 is when they go back; 03:10 CST is 09:10 UTC.
      expect(iso(snapshotDateFor(new Date('2026-11-01T09:10:00Z'), 'America/Chicago'))).toBe(
        '2026-10-31',
      );
    });

    /**
     * The repeated hour. 01:30 happens twice on the autumn morning — once on CDT
     * and once on CST — and both readings are still the 1st of November locally,
     * so both label the 31st of October. An instant-based answer would disagree
     * with itself across the two.
     */
    it('gives the same answer for both passes of a repeated hour', () => {
      const firstPass = new Date('2026-11-01T06:30:00Z'); // 01:30 CDT
      const secondPass = new Date('2026-11-01T07:30:00Z'); // 01:30 CST

      expect(iso(snapshotDateFor(firstPass, 'America/Chicago'))).toBe('2026-10-31');
      expect(iso(snapshotDateFor(secondPass, 'America/Chicago'))).toBe('2026-10-31');
    });
  });

  it('follows whichever zone it is given', () => {
    // One instant, three households. 2026-06-15T02:10Z is still the 14th in
    // Chicago and already the 15th in London and in UTC.
    const instant = new Date('2026-06-15T02:10:00Z');
    expect(iso(snapshotDateFor(instant, 'America/Chicago'))).toBe('2026-06-13');
    expect(iso(snapshotDateFor(instant, 'Europe/London'))).toBe('2026-06-14');
    expect(iso(snapshotDateFor(instant, 'UTC'))).toBe('2026-06-14');
  });
});

describe('filing a caller-supplied date', () => {
  it('keeps the calendar day and drops the time', () => {
    expect(asSnapshotDate(new Date('2026-06-14T23:59:59Z')).toISOString()).toBe(
      '2026-06-14T00:00:00.000Z',
    );
    expect(asSnapshotDate(new Date('2026-06-14T00:00:00Z')).toISOString()).toBe(
      '2026-06-14T00:00:00.000Z',
    );
  });
});
