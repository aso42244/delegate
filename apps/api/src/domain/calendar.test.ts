import { describe, expect, it } from 'vitest';
import {
  addMonthsToKey,
  asDayKey,
  endOfLocalDay,
  localDayKey,
  localMonthKey,
  localYearKey,
  previousLocalDayKey,
  startOfLocalDay,
} from './calendar.js';

/**
 * Which day an instant falls in, for this household. See ADR 037.
 *
 * Chicago throughout, because it observes daylight saving and sits far enough
 * west that an ordinary evening is already tomorrow in UTC — which is the whole
 * bug this exists to fix.
 */

const CHICAGO = 'America/Chicago';
const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('which day an instant is in', () => {
  /**
   * The bug in one assertion. Eight in the evening on the 31st of August is
   * already the 1st of September in UTC, so a monthly average computed in UTC
   * counted this spend in the wrong month.
   */
  it('reads an evening as the day it is locally, not the next day in UTC', () => {
    const evening = new Date('2026-09-01T01:00:00Z'); // 20:00 on the 31st, CDT
    expect(iso(localDayKey(evening, CHICAGO))).toBe('2026-08-31');
    expect(iso(localDayKey(evening, 'UTC'))).toBe('2026-09-01');
  });

  it('reads an early morning as the same day both ways', () => {
    const morning = new Date('2026-08-31T14:00:00Z'); // 09:00, CDT
    expect(iso(localDayKey(morning, CHICAGO))).toBe('2026-08-31');
    expect(iso(localDayKey(morning, 'UTC'))).toBe('2026-08-31');
  });

  it('files the answer as midnight UTC, like every other date here', () => {
    expect(localDayKey(new Date('2026-09-01T01:00:00Z'), CHICAGO).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
  });

  it('handles midnight itself, which some runtimes render as hour 24', () => {
    // Exactly local midnight starting the 27th.
    const midnight = new Date('2026-08-27T05:00:00Z');
    expect(iso(localDayKey(midnight, CHICAGO))).toBe('2026-08-27');
  });
});

describe('the day before', () => {
  it('is the previous calendar day locally', () => {
    expect(iso(previousLocalDayKey(new Date('2026-08-27T08:10:00Z'), CHICAGO))).toBe('2026-08-26');
  });

  it('crosses a month, a year and a leap day', () => {
    expect(iso(previousLocalDayKey(new Date('2026-03-01T09:10:00Z'), CHICAGO))).toBe('2026-02-28');
    expect(iso(previousLocalDayKey(new Date('2026-01-01T09:10:00Z'), CHICAGO))).toBe('2025-12-31');
    expect(iso(previousLocalDayKey(new Date('2028-03-01T09:10:00Z'), CHICAGO))).toBe('2028-02-29');
  });

  /**
   * Two mornings a year are not 24 hours long. Calendar arithmetic on the local
   * date is right on both; subtracting 24 hours from the instant is not.
   */
  it('survives both daylight saving mornings', () => {
    // Clocks go forward on 2026-03-08; 03:10 CDT is 08:10 UTC.
    expect(iso(previousLocalDayKey(new Date('2026-03-08T08:10:00Z'), CHICAGO))).toBe('2026-03-07');
    // Clocks go back on 2026-11-01; 03:10 CST is 09:10 UTC.
    expect(iso(previousLocalDayKey(new Date('2026-11-01T09:10:00Z'), CHICAGO))).toBe('2026-10-31');
  });

  it('gives one answer for both passes of the repeated hour', () => {
    expect(iso(previousLocalDayKey(new Date('2026-11-01T06:30:00Z'), CHICAGO))).toBe('2026-10-31');
    expect(iso(previousLocalDayKey(new Date('2026-11-01T07:30:00Z'), CHICAGO))).toBe('2026-10-31');
  });
});

describe('months and years', () => {
  /** The Utilities average buckets by month, which is where this mattered. */
  it('keeps a late-evening spend in the month it happened in', () => {
    const evening = new Date('2026-09-01T02:30:00Z'); // 21:30 on the 31st, CDT
    expect(iso(localMonthKey(evening, CHICAGO))).toBe('2026-08-01');
    expect(iso(localMonthKey(evening, 'UTC'))).toBe('2026-09-01');
  });

  it('keeps New Year s Eve in the year it happened in', () => {
    const eve = new Date('2027-01-01T04:00:00Z'); // 22:00 on the 31st, CST
    expect(iso(localYearKey(eve, CHICAGO))).toBe('2026-01-01');
    expect(iso(localYearKey(eve, 'UTC'))).toBe('2027-01-01');
  });

  /** A key is a decided day, so arithmetic on it needs no zone. */
  it('steps months on a key without consulting a zone', () => {
    const august = new Date(Date.UTC(2026, 7, 1));
    expect(iso(addMonthsToKey(august, 1))).toBe('2026-09-01');
    expect(iso(addMonthsToKey(august, -11))).toBe('2025-09-01');
    expect(iso(addMonthsToKey(august, 5))).toBe('2027-01-01');
  });

  it('normalises a date to its key', () => {
    expect(asDayKey(new Date('2026-08-27T23:59:59Z')).toISOString()).toBe(
      '2026-08-27T00:00:00.000Z',
    );
  });
});

/**
 * The inverse: turning a local day back into the instants that bound it, which
 * is what a query over a timestamp column has to filter on.
 */
describe('the instants a local day spans', () => {
  it('starts at local midnight and ends at the next one', () => {
    const key = new Date(Date.UTC(2026, 7, 27));
    // CDT is UTC−5 in August.
    expect(startOfLocalDay(key, CHICAGO).toISOString()).toBe('2026-08-27T05:00:00.000Z');
    expect(endOfLocalDay(key, CHICAGO).toISOString()).toBe('2026-08-28T05:00:00.000Z');
  });

  it('uses the winter offset in winter', () => {
    const key = new Date(Date.UTC(2026, 0, 15));
    // CST is UTC−6.
    expect(startOfLocalDay(key, CHICAGO).toISOString()).toBe('2026-01-15T06:00:00.000Z');
  });

  it('is the identity in UTC', () => {
    const key = new Date(Date.UTC(2026, 7, 27));
    expect(startOfLocalDay(key, 'UTC').toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(endOfLocalDay(key, 'UTC').toISOString()).toBe('2026-08-28T00:00:00.000Z');
  });

  /**
   * The spring-forward day is 23 hours long and the autumn one 25. A day that
   * assumed 24 would leave an hour of transactions in neither day or in both.
   */
  it('spans 23 hours on the spring-forward day', () => {
    const key = new Date(Date.UTC(2026, 2, 8));
    const { start, end } = {
      start: startOfLocalDay(key, CHICAGO),
      end: endOfLocalDay(key, CHICAGO),
    };
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('spans 25 hours on the autumn day', () => {
    const key = new Date(Date.UTC(2026, 10, 1));
    const start = startOfLocalDay(key, CHICAGO);
    const end = endOfLocalDay(key, CHICAGO);
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  /**
   * Every consecutive day meets the next exactly. A gap would drop transactions
   * and an overlap would count them twice — both silent.
   */
  it('tiles the year with no gap and no overlap', () => {
    let cursor = new Date(Date.UTC(2026, 0, 1));
    for (let index = 0; index < 365; index += 1) {
      const next = new Date(Date.UTC(2026, 0, 2 + index));
      expect(endOfLocalDay(cursor, CHICAGO).getTime()).toBe(
        startOfLocalDay(next, CHICAGO).getTime(),
      );
      cursor = next;
    }
  });

  /** Round-tripping is the property everything else rests on. */
  it('round-trips every day of a year through both directions', () => {
    for (let index = 0; index < 365; index += 1) {
      const key = new Date(Date.UTC(2026, 0, 1 + index));
      const start = startOfLocalDay(key, CHICAGO);
      expect(localDayKey(start, CHICAGO).getTime()).toBe(key.getTime());
      // And a moment before the end still belongs to the same day.
      const lastMoment = new Date(endOfLocalDay(key, CHICAGO).getTime() - 1);
      expect(localDayKey(lastMoment, CHICAGO).getTime()).toBe(key.getTime());
    }
  });

  it('round-trips in a zone east of UTC too', () => {
    for (const zone of ['Europe/London', 'Australia/Sydney', 'Asia/Kolkata']) {
      for (let index = 0; index < 365; index += 10) {
        const key = new Date(Date.UTC(2026, 0, 1 + index));
        expect(localDayKey(startOfLocalDay(key, zone), zone).getTime()).toBe(key.getTime());
      }
    }
  });
});
