import { DEFAULT_PAY_CADENCE, isKnownTimeZone, type Cents, type PayCadence } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ValidationError } from './errors.js';

/**
 * The budget's own settings: how long Delegate stays undoable, how far the
 * identity may drift before it stops reading "Balanced", and when go-live
 * happened.
 *
 * The row is a pinned singleton at id 1. Reads go through here rather than
 * touching the table directly so a missing row produces the documented defaults
 * once, in one place, instead of every caller inventing its own.
 */

export const DEFAULT_UNDO_WINDOW_HOURS = 12;
export const DEFAULT_IDENTITY_TOLERANCE_CENTS = 500n;

export interface BudgetSettings {
  readonly undoWindowHours: number;
  readonly identityToleranceCents: Cents;
  readonly goLiveAt: Date | null;
  /**
   * How often the household is paid. The Utilities page divides a monthly
   * average by this many payments a year; nothing else reads it, and nothing
   * about it schedules a Delegate run.
   */
  readonly payCadence: PayCadence;
  readonly remoteOverTorEnabled: boolean;
  readonly remoteOverTorEnabledAt: Date | null;
  /**
   * The IANA zone the scheduled jobs are read in, or null for "whatever
   * `SCHEDULE_TIMEZONE` says". See ADR 036.
   *
   * Null rather than the environment's value resolved eagerly, because the two
   * are genuinely different states: "nobody has chosen" and "somebody chose the
   * same thing the environment says" should not be indistinguishable, and only
   * the first should follow the environment if it later changes.
   */
  readonly scheduleTimezone: string | null;
  /**
   * Whether an overdue recurring bill puts a pill in the page header.
   *
   * Only the telling. The Bills page is always there — a switch that hid the
   * list as well would make "I turned the noise off" and "there are no bills"
   * indistinguishable, which is the state this application keeps refusing to
   * create.
   */
  readonly recurringAlertsEnabled: boolean;
}

export async function getBudgetSettings(db: Db): Promise<BudgetSettings> {
  const settings = await db.budgetSettings.findUnique({
    where: { id: 1 },
    select: {
      undoWindowHours: true,
      identityToleranceCents: true,
      goLiveAt: true,
      payCadence: true,
      remoteOverTorEnabled: true,
      remoteOverTorEnabledAt: true,
      scheduleTimezone: true,
      recurringAlertsEnabled: true,
    },
  });

  return {
    undoWindowHours: settings?.undoWindowHours ?? DEFAULT_UNDO_WINDOW_HOURS,
    identityToleranceCents: settings?.identityToleranceCents ?? DEFAULT_IDENTITY_TOLERANCE_CENTS,
    goLiveAt: settings?.goLiveAt ?? null,
    payCadence: settings?.payCadence ?? DEFAULT_PAY_CADENCE,
    // Off unless a row says otherwise. A missing settings row must not be a way
    // in from the internet.
    remoteOverTorEnabled: settings?.remoteOverTorEnabled ?? false,
    remoteOverTorEnabledAt: settings?.remoteOverTorEnabledAt ?? null,
    scheduleTimezone: settings?.scheduleTimezone ?? null,
    // On unless a row says otherwise: a bill that stopped arriving is the reason
    // to detect one at all.
    recurringAlertsEnabled: settings?.recurringAlertsEnabled ?? true,
  };
}

/**
 * The zone the schedules actually run in: the setting when one is chosen, the
 * environment otherwise.
 *
 * One function so the scheduler and the page that reports the schedule cannot
 * answer differently. Settings → Sync claimed "nightly at 02:30 UTC" whatever
 * the deployment was configured with for months, which is the shape of bug this
 * exists to prevent a second time.
 */
export function resolveScheduleTimezone(
  settings: Pick<BudgetSettings, 'scheduleTimezone'>,
  fallback: string,
): string {
  return settings.scheduleTimezone ?? fallback;
}

/**
 * The household's zone, resolved: the setting when one is chosen, the
 * environment otherwise.
 *
 * The convenience form of `resolveScheduleTimezone` for the many callers that
 * only want the answer. Note what it governs: since ADR 037 this is not only
 * *when jobs fire* but *which day an instant belongs to* — which month a spend
 * lands in, which day a chart point covers.
 *
 * The column is still called `schedule_timezone` and the variable still
 * `SCHEDULE_TIMEZONE`. Both names are narrower than the meaning now is, and both
 * are deliberately left alone: renaming the environment variable would silently
 * revert a deployment to UTC the first time it booted without the new name, and
 * that class of quiet failure has cost this project more than a slightly narrow
 * name ever will. ADR 037 records the widened scope.
 */
export async function householdTimezone(db: Db, fallback: string): Promise<string> {
  return resolveScheduleTimezone(await getBudgetSettings(db), fallback);
}

export interface UpdateBudgetSettingsInput {
  readonly undoWindowHours?: number | undefined;
  readonly identityToleranceCents?: Cents | undefined;
  readonly payCadence?: PayCadence | undefined;
  readonly remoteOverTorEnabled?: boolean | undefined;
  readonly recurringAlertsEnabled?: boolean | undefined;
  /** Null clears the choice and returns to following `SCHEDULE_TIMEZONE`. */
  readonly scheduleTimezone?: string | null | undefined;
}

/**
 * Both values are bounded rather than free.
 *
 * A negative tolerance would make every reading "over-delegated"; an undo window
 * of zero would silently remove undo altogether, and one of a year would keep a
 * batch reversible long after the money it moved had been spent.
 */
export async function updateBudgetSettings(
  db: Db,
  input: UpdateBudgetSettingsInput,
): Promise<BudgetSettings> {
  if (input.undoWindowHours !== undefined) {
    if (!Number.isInteger(input.undoWindowHours)) {
      throw new ValidationError('undo_window_not_integer', 'The undo window must be whole hours.');
    }
    if (input.undoWindowHours < 1 || input.undoWindowHours > 168) {
      throw new ValidationError(
        'undo_window_out_of_range',
        'The undo window must be between 1 hour and 168 hours (one week).',
      );
    }
  }

  if (input.identityToleranceCents !== undefined && input.identityToleranceCents < 0n) {
    throw new ValidationError(
      'tolerance_negative',
      'The tolerance is a distance from zero, so it cannot be negative.',
    );
  }

  /**
   * Refused at save time rather than at the next fire.
   *
   * An unknown zone does not throw when a job is scheduled with it — it falls
   * back to the process default — so a typo here would leave every schedule
   * running at an hour nobody chose, with nothing on screen saying so.
   */
  if (
    input.scheduleTimezone !== undefined &&
    input.scheduleTimezone !== null &&
    !isKnownTimeZone(input.scheduleTimezone)
  ) {
    throw new ValidationError(
      'schedule_timezone_unknown',
      'That is not an IANA time zone name. Abbreviations ("CST") and fixed offsets ("-05:00") are refused: neither observes daylight saving, so a job set for a civil hour would drift.',
    );
  }

  /**
   * Turning the requirement on is refused while any active account would be
   * locked out by it. The alternative is a setting that bricks the other
   * household member's access at the moment it is saved, recoverable only from
   * a database prompt.
   */
  // Turning the requirement on used to be refused while any active account
  // lacked a second factor, because it locked that account out of every route
  // — including the settings page offering enrolment. It no longer does: an
  // un-enrolled account is routed to `/set-up-two-factor`, which is reachable
  // precisely because `/api/auth/me` sits outside the guard. So this is now a
  // requirement to enrol rather than a door closing, and it is allowed.

  const updated = await db.budgetSettings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      undoWindowHours: input.undoWindowHours ?? DEFAULT_UNDO_WINDOW_HOURS,
      identityToleranceCents: input.identityToleranceCents ?? DEFAULT_IDENTITY_TOLERANCE_CENTS,
      payCadence: input.payCadence ?? DEFAULT_PAY_CADENCE,
      remoteOverTorEnabled: input.remoteOverTorEnabled ?? false,
      scheduleTimezone: input.scheduleTimezone ?? null,
      recurringAlertsEnabled: input.recurringAlertsEnabled ?? true,
    },
    update: {
      ...(input.undoWindowHours === undefined ? {} : { undoWindowHours: input.undoWindowHours }),
      ...(input.identityToleranceCents === undefined
        ? {}
        : { identityToleranceCents: input.identityToleranceCents }),
      ...(input.payCadence === undefined ? {} : { payCadence: input.payCadence }),
      // Null is a value here, not an absence: it clears the choice and returns
      // to following the environment variable.
      ...(input.scheduleTimezone === undefined ? {} : { scheduleTimezone: input.scheduleTimezone }),
      ...(input.remoteOverTorEnabled === undefined
        ? {}
        : {
            remoteOverTorEnabled: input.remoteOverTorEnabled,
            // Stamped only when switched on, so the interface can say since when.
            remoteOverTorEnabledAt: input.remoteOverTorEnabled ? new Date() : null,
          }),
      ...(input.recurringAlertsEnabled === undefined
        ? {}
        : { recurringAlertsEnabled: input.recurringAlertsEnabled }),
    },
    select: {
      undoWindowHours: true,
      identityToleranceCents: true,
      goLiveAt: true,
      payCadence: true,
      remoteOverTorEnabled: true,
      remoteOverTorEnabledAt: true,
      scheduleTimezone: true,
      recurringAlertsEnabled: true,
    },
  });

  return updated;
}
