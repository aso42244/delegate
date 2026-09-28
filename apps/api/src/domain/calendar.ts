/**
 * Which day, month or year an instant falls in — for this household.
 *
 * See [ADR 037](../../../docs/decisions/037-a-day-is-the-households-day.md).
 *
 * The distinction this module exists to keep straight:
 *
 * **An instant** is a moment — `transactions.posted_at`, `now`. It is the same
 * moment everywhere and carries no day of its own; asking which day it is in is
 * a question that needs a zone to answer.
 *
 * **A date key** is a calendar day already decided — `account_valuations.as_of`,
 * `bitcoin_prices.price_date`, `snapshot_date`, a date somebody typed. Stored as
 * midnight UTC because a `DATE` column has no zone, and needing none: the zone
 * question was answered when the key was made. Arithmetic on a key is plain
 * calendar arithmetic and does **not** belong here.
 *
 * Conflating the two is how a charge at eight in the evening lands in next
 * month's average.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock reading in a zone at an instant. */
function wallClock(instant: Date, timeZone: string): Parts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const value = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value;
    return found === undefined ? 0 : Number(found);
  };

  return {
    year: value('year'),
    // `hour12: false` renders midnight as 24 in some runtimes. Both mean the
    // same instant; 24 would push the arithmetic below into the next day.
    hour: value('hour') % 24,
    month: value('month'),
    day: value('day'),
    minute: value('minute'),
    second: value('second'),
  };
}

/**
 * How far the zone is from UTC at an instant, in milliseconds.
 *
 * Read from the wall clock rather than from a table, so it is right across
 * daylight saving without this module knowing any rules.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = wallClock(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Second precision is all `formatToParts` gives; the milliseconds are the
  // instant's own and must not be counted into the offset.
  return asIfUtc - (instant.getTime() - instant.getMilliseconds());
}

/**
 * The calendar day an instant falls in, as a date key.
 *
 * Midnight UTC, which is how every date in this schema is filed.
 */
export function localDayKey(instant: Date, timeZone: string): Date {
  const { year, month, day } = wallClock(instant, timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

/** The day before the one an instant falls in. What a nightly run is labelled. */
export function previousLocalDayKey(instant: Date, timeZone: string): Date {
  const { year, month, day } = wallClock(instant, timeZone);
  /*
   * Calendar arithmetic on the local date, never 24 hours off the instant. Two
   * mornings a year are not 24 hours long, so an instant-based answer is wrong
   * for any run close enough to midnight. `Date.UTC` normalises day 0 and month
   * -1 itself, so the first of a month and of January need no special case.
   */
  return new Date(Date.UTC(year, month - 1, day - 1));
}

/** The first day of the month an instant falls in. */
export function localMonthKey(instant: Date, timeZone: string): Date {
  const { year, month } = wallClock(instant, timeZone);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** The first day of the year an instant falls in. */
export function localYearKey(instant: Date, timeZone: string): Date {
  return new Date(Date.UTC(wallClock(instant, timeZone).year, 0, 1));
}

/**
 * Plain calendar arithmetic on a date key.
 *
 * No zone, deliberately: a key is a decided day, and "three months after the
 * first of March" is the first of June wherever you are standing.
 */
export function addMonthsToKey(key: Date, count: number): Date {
  return new Date(Date.UTC(key.getUTCFullYear(), key.getUTCMonth() + count, 1));
}

/** Normalises a date to its key, discarding any time on it. */
export function asDayKey(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The instants that bound a local day — the inverse of `localDayKey`.
 *
 * This is what turns "the 27th of August, here" into a range a timestamp column
 * can be filtered on. Without it a query over `posted_at` silently means the UTC
 * day, and a chart labelled with local days would be filled with transactions
 * cut on different boundaries.
 *
 * Resolved by probing rather than by arithmetic. The offset at midnight UTC is
 * not necessarily the offset at local midnight — on a spring-forward morning
 * they differ — so the first guess is corrected by the offset actually in force
 * where it lands.
 */
export function localDayBounds(key: Date, timeZone: string): { start: Date; end: Date } {
  const startKey = asDayKey(key);
  // Keys are midnight UTC, so a day is exactly `DAY_MS` of key arithmetic.
  const endKey = new Date(startKey.getTime() + DAY_MS);

  /**
   * `expected` is the day this probe is resolving, and it must be passed rather
   * than assumed. The end bound resolves the *following* midnight, so a check
   * written against `key` can never pass for it — the correction would always be
   * discarded and the uncorrected guess returned. In a zone that shifts at two in
   * the morning that is the same answer; in one that shifts at midnight it is an
   * hour out, and a day's window then ends an hour early or late.
   */
  const resolve = (target: number, expected: Date): Date => {
    const firstGuess = new Date(target - offsetAt(new Date(target), timeZone));
    const corrected = new Date(target - offsetAt(firstGuess, timeZone));
    /*
     * On the spring-forward morning local midnight may not exist — where the
     * clocks jump at midnight rather than at two, the day starts an hour later.
     * The correction then lands before the day begins, and the guess that did
     * not need correcting is the honest one.
     */
    return localDayKey(corrected, timeZone).getTime() === expected.getTime()
      ? corrected
      : firstGuess;
  };

  return {
    start: resolve(startKey.getTime(), startKey),
    end: resolve(endKey.getTime(), endKey),
  };
}

/** The instant a local day begins. */
export function startOfLocalDay(key: Date, timeZone: string): Date {
  return localDayBounds(key, timeZone).start;
}

/** The instant a local day ends, exclusive — the start of the next one. */
export function endOfLocalDay(key: Date, timeZone: string): Date {
  return localDayBounds(key, timeZone).end;
}
