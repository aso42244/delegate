import { DEFAULT_PAY_CADENCE, type Cents, type PayCadence } from '@budget/shared';
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
  };
}

export interface UpdateBudgetSettingsInput {
  readonly undoWindowHours?: number | undefined;
  readonly identityToleranceCents?: Cents | undefined;
  readonly payCadence?: PayCadence | undefined;
  readonly remoteOverTorEnabled?: boolean | undefined;
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
    },
    update: {
      ...(input.undoWindowHours === undefined ? {} : { undoWindowHours: input.undoWindowHours }),
      ...(input.identityToleranceCents === undefined
        ? {}
        : { identityToleranceCents: input.identityToleranceCents }),
      ...(input.payCadence === undefined ? {} : { payCadence: input.payCadence }),
      ...(input.remoteOverTorEnabled === undefined
        ? {}
        : {
            remoteOverTorEnabled: input.remoteOverTorEnabled,
            // Stamped only when switched on, so the interface can say since when.
            remoteOverTorEnabledAt: input.remoteOverTorEnabled ? new Date() : null,
          }),
    },
    select: {
      undoWindowHours: true,
      identityToleranceCents: true,
      goLiveAt: true,
      payCadence: true,
      remoteOverTorEnabled: true,
      remoteOverTorEnabledAt: true,
    },
  });

  return updated;
}
