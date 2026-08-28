import { describe, expect, it } from 'vitest';
import {
  CYCLES_PER_YEAR,
  PAY_CADENCES,
  PAY_CADENCE_LABELS,
  isPayCadence,
  type PayCadence,
  canManageUsers,
  canModifyUser,
  isBalanceStale,
  isEstimated,
  isFeedBalanceStale,
  isKnownTimeZone,
  knownTimeZones,
  PROVENANCE_NOTES,
  SNAPSHOT_PROVENANCES,
  weakestProvenance,
  type SnapshotProvenance,
  suggestedPerCycleCents,
  groupingTint,
  isGroupingColor,
} from './domain.js';

describe('permissions', () => {
  it('gates only user management', () => {
    expect(canManageUsers('user')).toBe(false);
    expect(canManageUsers('admin')).toBe(true);
    expect(canManageUsers('super_admin')).toBe(true);
  });

  it('makes the Super Admin immune to everyone but themselves', () => {
    expect(canModifyUser('admin', 'super_admin')).toBe(false);
    expect(canModifyUser('super_admin', 'super_admin')).toBe(true);
    expect(canModifyUser('admin', 'user')).toBe(true);
    expect(canModifyUser('admin', 'admin')).toBe(true);
    expect(canModifyUser('user', 'user')).toBe(false);
  });
});

describe('isBalanceStale', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('is never stale without an interval configured', () => {
    expect(isBalanceStale(new Date('2020-01-01T00:00:00Z'), null, now)).toBe(false);
  });

  it('is never stale without a confirmed date', () => {
    expect(isBalanceStale(null, 30, now)).toBe(false);
  });

  it('flags a balance older than its own interval', () => {
    expect(isBalanceStale(new Date('2026-08-01T12:00:00Z'), 30, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-06-01T12:00:00Z'), 30, now)).toBe(true);
  });

  it('is not stale exactly on the boundary', () => {
    expect(isBalanceStale(new Date('2026-07-09T12:00:00Z'), 30, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-07-09T11:59:59Z'), 30, now)).toBe(true);
  });

  it('supports the long intervals the owner named for property', () => {
    // 2026-05-20 → 2026-08-08 is 80 days; 2026-05-08 would be 92 and stale.
    expect(isBalanceStale(new Date('2026-05-20T12:00:00Z'), 90, now)).toBe(false);
    expect(isBalanceStale(new Date('2026-05-08T12:00:00Z'), 90, now)).toBe(true);
    expect(isBalanceStale(new Date('2026-01-08T12:00:00Z'), 180, now)).toBe(true);
  });
});

describe('suggestedPerCycleCents', () => {
  /**
   * The biweekly cases are the ones this function shipped with, kept verbatim.
   * Every budget in existence was computed at 26 before the cadence became a
   * setting, so these are the regression: if they move, an upgrade moves a
   * number somebody was reading.
   */
  it('spreads a monthly average across 26 cycles, as it always did', () => {
    expect(CYCLES_PER_YEAR.biweekly).toBe(26);
    // $120/mo × 12 ÷ 26 = $55.3846… → $55.38
    expect(suggestedPerCycleCents(120_00n, 26)).toBe(55_38n);
    // $260/mo × 12 ÷ 26 = exactly $120.00
    expect(suggestedPerCycleCents(260_00n, 26)).toBe(120_00n);
  });

  it('rounds half away from zero', () => {
    // 13 cents × 12 = 156; 156 / 26 = exactly 6.
    expect(suggestedPerCycleCents(13n, 26)).toBe(6n);
    // 1 cent × 12 = 12; 12 / 26 = 0.46 → 0.
    expect(suggestedPerCycleCents(1n, 26)).toBe(0n);
    // 2 cents × 12 = 24; 24 / 26 = 0.92 → 1.
    expect(suggestedPerCycleCents(2n, 26)).toBe(1n);
  });

  it('handles zero and negatives symmetrically', () => {
    expect(suggestedPerCycleCents(0n, 26)).toBe(0n);
    expect(suggestedPerCycleCents(-120_00n, 26)).toBe(-55_38n);
    expect(suggestedPerCycleCents(-2n, 26)).toBe(-1n);
  });

  /**
   * $120 a month is $1,440 a year however it is sliced, so each cadence is
   * that divided by its own number of paychecks. Worked by hand rather than
   * from the implementation, which is the only way a test of arithmetic is
   * worth anything.
   */
  it.each([
    ['weekly', 52, 27_69n],
    ['biweekly', 26, 55_38n],
    ['semimonthly', 24, 60_00n],
    ['monthly', 12, 120_00n],
  ])('spreads $120 a month over %s', (cadence, cycles, expected) => {
    expect(CYCLES_PER_YEAR[cadence as PayCadence]).toBe(cycles);
    expect(suggestedPerCycleCents(120_00n, cycles)).toBe(expected);
  });

  /** Twice a month and monthly divide evenly, so they are exact. */
  it('is exact where the arithmetic is exact', () => {
    expect(suggestedPerCycleCents(100_00n, 24)).toBe(50_00n);
    expect(suggestedPerCycleCents(100_00n, 12)).toBe(100_00n);
  });

  it('rounds half away from zero at every cadence', () => {
    // 1 cent a month is 12 a year. Over 52 that is 0.2307… → 0.
    expect(suggestedPerCycleCents(1n, 52)).toBe(0n);
    // 5 cents a month is 60 a year. Over 52 that is 1.1538… → 1.
    expect(suggestedPerCycleCents(5n, 52)).toBe(1n);
    // 13 cents a month is 156 a year. Over 24 that is 6.5 → 7, away from zero.
    expect(suggestedPerCycleCents(13n, 24)).toBe(7n);
    expect(suggestedPerCycleCents(-13n, 24)).toBe(-7n);
  });

  it('covers every cadence the interface offers', () => {
    for (const cadence of PAY_CADENCES) {
      expect(CYCLES_PER_YEAR[cadence]).toBeGreaterThan(0);
      expect(PAY_CADENCE_LABELS[cadence]).toContain(String(CYCLES_PER_YEAR[cadence]));
    }
  });
});

describe('isPayCadence', () => {
  it('accepts what the interface offers and nothing else', () => {
    for (const cadence of PAY_CADENCES) expect(isPayCadence(cadence)).toBe(true);
    for (const other of ['', 'fortnightly', 'BIWEEKLY', 'every_four_weeks', 'daily']) {
      expect(isPayCadence(other), other).toBe(false);
    }
  });
});

describe('grouping colours', () => {
  it('accepts only the curated palette', () => {
    expect(isGroupingColor('#46A171')).toBe(true);
    // An arbitrary colour is how a dense financial table ends up with a magenta row.
    expect(isGroupingColor('#FF00FF')).toBe(false);
    expect(isGroupingColor('red')).toBe(false);
  });

  it('tints a header more strongly than a row, and both faintly', () => {
    expect(groupingTint('#2783DE', 'header')).toBe('rgb(39 131 222 / 0.1)');
    expect(groupingTint('#2783DE', 'row')).toBe('rgb(39 131 222 / 0.04)');
  });

  /**
   * Any valid hex tints, not only the five presets — the palette is a shortcut
   * rather than the vocabulary. What is still refused is a string the tint
   * function cannot read three channels out of by position.
   */
  it('tints any valid hex, and nothing that is not one', () => {
    expect(groupingTint('#FF00FF', 'header')).toBe('rgb(255 0 255 / 0.1)');
    expect(groupingTint(null, 'header')).toBeUndefined();
    expect(groupingTint('#FFF', 'header')).toBeUndefined();
    expect(groupingTint('rebeccapurple', 'header')).toBeUndefined();
    expect(groupingTint('2783DE', 'header')).toBeUndefined();
  });
});

/**
 * How old a feed's own answer is, which is not the same question as when
 * somebody last confirmed a balance by hand.
 */
describe('feed balance staleness', () => {
  const now = new Date('2026-08-25T12:00:00Z');

  it('is not stale within the threshold', () => {
    expect(isFeedBalanceStale(new Date('2026-08-24T12:00:00Z'), now)).toBe(false);
    expect(isFeedBalanceStale(new Date('2026-08-23T13:00:00Z'), now)).toBe(false);
  });

  it('is stale once the feed date has aged past it', () => {
    expect(isFeedBalanceStale(new Date('2026-08-23T11:00:00Z'), now)).toBe(true);
    expect(isFeedBalanceStale(new Date('2026-08-20T12:00:00Z'), now)).toBe(true);
  });

  /**
   * Silence is not evidence. A bridge that sends no `balance-date` says nothing
   * about the age of its answer, and inventing a warning out of that would be
   * the same mistake as inventing freshness — which is the one this replaced.
   */
  it('treats an absent date as unknown rather than stale', () => {
    expect(isFeedBalanceStale(null, now)).toBe(false);
  });

  it('does not call a date in the future stale', () => {
    expect(isFeedBalanceStale(new Date('2026-08-26T12:00:00Z'), now)).toBe(false);
  });
});

/**
 * Provenance, and the rule that an aggregate is only as good as its weakest
 * input. See ADR 035.
 */
describe('snapshot provenance', () => {
  it('is ordered strongest first, which weakestProvenance depends on', () => {
    expect(SNAPSHOT_PROVENANCES).toEqual(['observed', 'reconstructed', 'carried', 'interpolated']);
  });

  it('takes the weakest of several', () => {
    expect(weakestProvenance(['observed', 'observed'])).toBe('observed');
    expect(weakestProvenance(['observed', 'reconstructed'])).toBe('reconstructed');
    expect(weakestProvenance(['observed', 'carried', 'reconstructed'])).toBe('carried');
    expect(weakestProvenance(['carried', 'interpolated', 'observed'])).toBe('interpolated');
  });

  /**
   * One estimated account makes the whole day's aggregate an estimate, however
   * many exact rows sat beside it. That is the point of the rule.
   */
  it('lets a single interpolated row decide a day of forty', () => {
    const rows: SnapshotProvenance[] = Array.from({ length: 40 }, () => 'observed');
    rows[17] = 'interpolated';
    expect(weakestProvenance(rows)).toBe('interpolated');
  });

  /**
   * A day with nothing to record is not a day that estimated something. Reading
   * an empty list as the weakest value would paint an honest blank as a guess.
   */
  it('calls an empty day observed rather than estimated', () => {
    expect(weakestProvenance([])).toBe('observed');
  });

  /**
   * `carried` is exact: a property worth $400,000 until somebody typed $420,000
   * was worth $400,000 the whole time. Only interpolation is a guess, and only
   * it renders as one.
   */
  it('counts only interpolation as an estimate', () => {
    expect(isEstimated('observed')).toBe(false);
    expect(isEstimated('reconstructed')).toBe(false);
    expect(isEstimated('carried')).toBe(false);
    expect(isEstimated('interpolated')).toBe(true);
  });

  it('has a note for every provenance, so no row hovers blank', () => {
    for (const provenance of SNAPSHOT_PROVENANCES) {
      expect(PROVENANCE_NOTES[provenance].length).toBeGreaterThan(0);
    }
  });
});

/**
 * Zone validation moved here from the API's config when the zone became a
 * setting (ADR 036), so the picker offers exactly what the server accepts.
 */
describe('time zones', () => {
  it('accepts IANA names, including UTC which Intl omits', () => {
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('America/Chicago')).toBe(true);
    expect(isKnownTimeZone('America/Detroit')).toBe(true);
    expect(isKnownTimeZone('Europe/London')).toBe(true);
  });

  /**
   * Neither carries daylight saving rules, so a job set for half past two in the
   * morning against an offset runs at half past one for half the year — and
   * `CST` names two different zones on two different continents.
   */
  it('refuses abbreviations and fixed offsets', () => {
    expect(isKnownTimeZone('CST')).toBe(false);
    expect(isKnownTimeZone('EST5EDT')).toBe(false);
    expect(isKnownTimeZone('-05:00')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
  });

  it('offers a list that validates, so the picker cannot suggest a refusal', () => {
    const zones = knownTimeZones();
    expect(zones).toContain('UTC');
    expect(zones.length).toBeGreaterThan(100);
    for (const zone of zones) expect(isKnownTimeZone(zone)).toBe(true);
  });
});
