import type { SyncStatus } from '../api/client.js';

/**
 * What the Sync SimpleFIN button has to say about the last run.
 *
 * Two readings, and the button shows whichever applies. When the bank feed is
 * reporting something, the folded alerts are the answer (ADR 063). When it is
 * quiet — which is nearly always — the useful thing is *did it run, and did it
 * bring anything back*, and that used to be a caption under the button saying
 * "Synced 12m ago" to nobody in particular. It is on the hover now, where it
 * costs no floor space and is there when somebody wonders.
 *
 * Here rather than inside the component because it is the part worth proving:
 * "an hour ago" at 59 minutes and "1d ago" at 25 hours are exactly the
 * boundaries a hand-rolled duration gets wrong.
 */

/**
 * What the last run itself says, if it failed.
 *
 * Read from `/api/sync/status` rather than from the notifications, and kept
 * beside them, because it is the fresher of the two: the status is re-checked
 * every minute and the notifications every five, so a run that has just failed
 * shows here first. `SyncControl` folds it in only when the notification for it
 * has not caught up, so the same failure is never listed twice.
 *
 * The error is whatever the run recorded. A failed run with nothing written down
 * still has to say something, or the colour would be unexplained.
 */
export function describeSync(status: SyncStatus | undefined): string | null {
  if (status?.failing !== true) return null;
  const error = status.runs[0]?.error?.trim();
  return error ? `Last sync failed: ${error}` : 'The last sync failed.';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Coarse on purpose: nobody acts on the difference between 41 and 43 minutes,
 * and a figure that changes every time it is looked at reads as noise. Under a
 * minute is "just now" rather than a count of seconds, because by the time it is
 * read it is already wrong.
 *
 * A future timestamp — a NAS whose clock has drifted ahead of the browser's —
 * reads as "just now" rather than as a negative duration.
 */
export function agoLabel(then: Date, now: Date): string {
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes}m ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours}h ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `${days}d ago`;
}

/** What a quiet feed has to say: when it last ran, and what it brought back. */
export interface SyncReading {
  /** "Synced 12m ago", or that it has never run. */
  readonly when: string;
  /** Only when the last run actually added something. */
  readonly added: string | null;
}

/**
 * The reading for a feed with nothing to complain about.
 *
 * **Keyed on runs rather than on configuration.** A run that has happened is the
 * thing being reported, and `configured` answers a different question — whether
 * a credential is stored, which the Settings page is for. Gating on it would
 * also have meant this reading could never be staged end to end, because the
 * access URL is encrypted with the deployment's data key and a test cannot
 * write one.
 *
 * `null` when there is nothing to say at all: no run has ever finished and no
 * feed is connected, which is a fresh install. Silence is right there — the
 * button is inert until Settings has a credential.
 *
 * **The count comes from the most recent run, not from a total.** "3 new
 * transactions" means the last sync found three; a running total would be a
 * different number answering a question nobody asked of this button.
 */
export function readSync(status: SyncStatus | undefined, now: Date): SyncReading | null {
  if (status === undefined) return null;

  const last = status.lastSyncAt;
  if (last === null) return status.configured ? { when: 'Not synced yet.', added: null } : null;

  const added = status.runs[0]?.transactionsAdded ?? 0;
  return {
    when: `Synced ${agoLabel(new Date(last), now)}.`,
    added: added > 0 ? `${added} new ${added === 1 ? 'transaction' : 'transactions'}.` : null,
  };
}
