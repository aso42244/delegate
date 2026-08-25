import { describe, expect, it } from 'vitest';
import { describeBackupSchedule } from './backup-schedule.js';

/**
 * The card's own description of the schedule.
 *
 * Worth a test for one reason: a cron expression puts the minute first and the
 * hour second, and rendering them the way they are written produces a card that
 * confidently states the wrong time for the only backup this household has.
 */
describe('describing a backup schedule', () => {
  it('reads the minute and the hour in the right order', () => {
    expect(describeBackupSchedule('30 2 * * *', 'America/Chicago', 30)).toBe(
      'A dump of the whole budget, daily at 02:30 America/Chicago, kept for 30 days.',
    );
  });

  it('pads a single-digit hour', () => {
    expect(describeBackupSchedule('5 3 * * *', 'UTC', 30)).toBe(
      'A dump of the whole budget, daily at 03:05 UTC, kept for 30 days.',
    );
  });

  it('tolerates surrounding whitespace', () => {
    expect(describeBackupSchedule('  30 2 * * *  ', 'UTC', 7)).toContain('daily at 02:30 UTC');
  });

  /**
   * "nightly" was the old wording and it is only true for some hours. The copy
   * has to stay true when somebody moves the job to the afternoon.
   */
  it('does not call an afternoon job nightly', () => {
    const described = describeBackupSchedule('0 14 * * *', 'UTC', 30);
    expect(described).toContain('daily at 14:00 UTC');
    expect(described).not.toContain('nightly');
  });

  /**
   * Anything that is not a plain daily schedule is shown as written. A
   * paraphrase that is subtly wrong about when the only backup runs is worse
   * than the expression somebody deliberately typed.
   */
  it('shows an unusual schedule verbatim rather than paraphrasing it', () => {
    expect(describeBackupSchedule('0 */6 * * *', 'UTC', 30)).toBe(
      'A dump of the whole budget, on the schedule 0 */6 * * * (UTC), kept for 30 days.',
    );
    expect(describeBackupSchedule('30 2 * * 1', 'UTC', 30)).toContain('on the schedule 30 2 * * 1');
  });

  it('does not say "1 days"', () => {
    expect(describeBackupSchedule('30 2 * * *', 'UTC', 1)).toContain('kept for a day');
  });
});
