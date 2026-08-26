/**
 * The Backups card's description, built from what the deployment is actually
 * configured to do.
 *
 * It used to read "nightly at 02:30 UTC, kept for 30 days" whatever `BACKUP_CRON`,
 * `SCHEDULE_TIMEZONE` and `BACKUP_RETENTION_DAYS` were set to — a small version
 * of the problem the card itself exists to solve, which is an interface stating
 * something nothing checks against the thing it describes.
 */

/** `m h * * *` — the daily shape, and the only one worth rendering as prose. */
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/**
 * Describes a schedule in words when it is an ordinary daily one, and shows the
 * expression verbatim when it is not.
 *
 * No attempt at a general cron-to-English translation. Every one of those is
 * wrong in some corner, and a paraphrase that is subtly wrong about when your
 * only backup runs is worse than the expression a person deliberately wrote.
 */
export function describeBackupSchedule(
  cron: string,
  timezone: string,
  retentionDays: number,
): string {
  const daily = DAILY.exec(cron.trim());

  // "daily", never "nightly": the same expression with a different hour is a
  // lunchtime job, and the copy has to stay true when somebody changes it.
  const when = daily
    ? `Daily at ${daily[2]!.padStart(2, '0')}:${daily[1]!.padStart(2, '0')} ${timezone}`
    : `On the schedule ${cron} (${timezone})`;

  const kept = retentionDays === 1 ? 'kept a day' : `kept ${retentionDays} days`;

  // Two facts and a separator rather than a sentence. The sentence took two
  // lines on a phone to say the same thing.
  return `${when} · ${kept}.`;
}
