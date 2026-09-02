import { formatCents, isBalanceStale } from '@budget/shared';
import type { Db } from '../db/client.js';
import { latestPrice } from './bitcoin.js';
import { newestBackupAt } from './backup.js';
import { proposeCheckMatches } from './checks.js';
import { localDayKey } from './calendar.js';
import { findRecurringBills, overdueBills } from './recurring.js';
import { findBehindTargets } from './targets.js';
import { getBudgetSettings } from './settings.js';

/**
 * The banners the application raises about itself.
 *
 * Every one of these is a condition the owner would otherwise only discover by
 * noticing a number was wrong. A sync that has been failing for three days looks
 * exactly like a quiet week; a cash balance nobody has confirmed since March
 * looks exactly like a cash balance.
 *
 * They are computed on read rather than stored. A stored notification has to be
 * cleared by something, and the something is always missed — a condition that
 * has resolved should stop being reported because it resolved, not because
 * anybody dismissed it.
 */

/**
 * `confirm` is not a fault and not merely information: it is something the
 * application has worked out and will not act on until a person says so. Purple,
 * because blue, yellow and red already mean "here is a fact", "this needs
 * attention" and "this is wrong", and none of those is what a proposal is.
 */
export type NotificationSeverity = 'info' | 'confirm' | 'warning' | 'danger';

export interface Notification {
  /** Stable, so the UI can key and test on it rather than on prose. */
  readonly kind:
    | 'sync_failing'
    | 'sync_warning'
    | 'stale_balances'
    | 'uncategorized_backlog'
    | 'bitcoin_price_stale'
    | 'accounts_need_review'
    | 'checks_awaiting_confirmation'
    | 'recurring_bill_overdue'
    | 'targets_behind'
    | 'backup_failing';
  readonly severity: NotificationSeverity;
  /**
   * The whole of it, in a sentence. On a `danger` this is the bar's text; on
   * everything else it is what the pill says when it is hovered or focused.
   */
  readonly message: string;
  /**
   * The pill's face: two or three words that name the condition, never the
   * detail. It is a control roughly the width of "Balanced", so a count is the
   * most it can carry — the message says which bank, which accounts, how old.
   */
  readonly pill: string;
  /** Where to go to do something about it. */
  readonly actionPath: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * How old the newest dump may be before the backup counts as failing.
 *
 * The dump is nightly, so one missed run is a hiccup and two is a pattern. Set
 * lower and a slow first dump of a year's transactions on a Celeron raises a
 * false alarm; set higher and a fortnight can pass unnoticed.
 */
const BACKUP_STALE_HOURS = 48;
const STALE_MS = BACKUP_STALE_HOURS * 60 * 60 * 1000;

export interface NotificationOptions {
  /**
   * Where the dumps land. Omitted, the backup check does not run at all — which
   * is what the integration tests want, and what any caller without the
   * deployment's configuration should get rather than a false alarm.
   */
  readonly backupDir?: string;
}

export async function buildNotifications(
  db: Db,
  timeZone: string,
  now: Date = new Date(),
  options: NotificationOptions = {},
): Promise<Notification[]> {
  const notifications: Notification[] = [];
  const settings = await getBudgetSettings(db);

  const [latestRun, accounts, uncategorized, oldestUncategorized, price, checkMatches, oldestUser] =
    await Promise.all([
      db.syncRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: { status: true, error: true, startedAt: true },
      }),
      db.account.findMany({
        where: { archivedAt: null },
        select: { name: true, balanceAsOf: true, stalenessIntervalDays: true, needsReview: true },
      }),
      db.transaction.count({
        where: { archivedAt: null, allocations: { none: {} }, kind: 'normal' },
      }),
      db.transaction.findFirst({
        where: { archivedAt: null, allocations: { none: {} }, kind: 'normal' },
        orderBy: { postedAt: 'asc' },
        select: { postedAt: true },
      }),
      latestPrice(db, timeZone, now),
      proposeCheckMatches(db),
      // The first account created, as a stand-in for when this deployment began.
      db.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);

  /*
   * The backup, first, because it is the only condition here that can cost the
   * household its data rather than its accuracy.
   *
   * Age of the newest dump rather than the outcome of the last attempt. Those
   * differ exactly where it matters: this deployment's nightly dump failed with
   * a permission error every night from go-live, logged at error level each
   * time, and nothing read the log. "Did it throw" was being answered correctly
   * and nobody was listening; "is there a recent backup" is the question whose
   * answer nobody could have got wrong.
   */
  if (options.backupDir !== undefined) {
    const newest = await newestBackupAt(options.backupDir);
    const hours = newest === null ? null : (now.getTime() - newest.getTime()) / (60 * 60 * 1000);

    /*
     * A deployment younger than one backup cycle is not failing, it is new.
     *
     * The first account's creation is the closest thing to a deployment date
     * without a column for one: first-run setup is the moment this stopped
     * being an empty database. Without this an install raises a red banner on
     * its first evening, before the nightly dump has had a chance to run at
     * all — and a banner that is wrong on day one is one nobody trusts on day
     * ninety, which is the day it matters.
     */
    const settledIn =
      oldestUser === null ? false : now.getTime() - oldestUser.createdAt.getTime() > STALE_MS;

    if (settledIn && (hours === null || hours > BACKUP_STALE_HOURS)) {
      const days = newest === null ? 0 : daysBetween(newest, now);
      notifications.push({
        kind: 'backup_failing',
        pill: 'Backup failing',
        severity: 'danger',
        message:
          newest === null
            ? 'No database backup has ever completed. Everything in this budget exists in one place.'
            : `The newest database backup is ${days === 1 ? 'a day' : `${days} days`} old. The nightly dump is failing.`,
        actionPath: '/settings/sync',
      });
    }
  }

  // A failed sync must be visible in the UI, not only in the logs — §13.
  if (latestRun?.status === 'failed') {
    const days = daysBetween(latestRun.startedAt, now);
    notifications.push({
      kind: 'sync_failing',
      pill: 'Sync failing',
      severity: 'danger',
      message:
        days >= 1
          ? `The last sync failed ${days === 1 ? 'yesterday' : `${days} days ago`}. Balances and transactions are not up to date.`
          : 'The last sync failed. Balances and transactions are not up to date.',
      actionPath: '/settings/sync',
    });
  }

  /*
   * A run that *succeeded* while carrying feed errors.
   *
   * SimpleFIN reports a per-institution problem — an expired login, a bank
   * refusing the connection — without failing the whole run, because the other
   * institutions synced fine. Recorded on the run since the beginning, but until
   * now it was only legible on the Settings page, so an account quietly stopped
   * updating and everything else looked healthy. The feed's own words are used:
   * it names the institution, and paraphrasing would lose that.
   */
  if (latestRun?.status === 'succeeded' && latestRun.error) {
    notifications.push({
      kind: 'sync_warning',
      // Not 'Auth issue': the feed reports any per-institution problem this
      // way, and an expired login is only the commonest of them.
      pill: 'Sync issue',
      severity: 'warning',
      // Multiple institutions can complain in one run.
      message: latestRun.error.split('\n').filter(Boolean).join(' · '),
      actionPath: '/settings/sync',
    });
  }

  // One mechanism serves physical cash, the hardware wallet and the house alike.
  const stale = accounts.filter((account) =>
    isBalanceStale(account.balanceAsOf, account.stalenessIntervalDays, now),
  );
  if (stale.length > 0) {
    const names = stale
      .slice(0, 3)
      .map((account) => account.name)
      .join(', ');
    notifications.push({
      kind: 'stale_balances',
      pill: stale.length === 1 ? '1 stale balance' : `${stale.length} stale balances`,
      severity: 'warning',
      message:
        stale.length <= 3
          ? `${names} ${stale.length === 1 ? 'has' : 'have'} not been confirmed recently.`
          : `${names} and ${stale.length - 3} more have not been confirmed recently.`,
      actionPath: '/settings/accounts',
    });
  }

  const needReview = accounts.filter((account) => account.needsReview);
  if (needReview.length > 0) {
    notifications.push({
      kind: 'accounts_need_review',
      pill: needReview.length === 1 ? '1 new account' : `${needReview.length} new accounts`,
      severity: 'warning',
      message: `${needReview.length} ${needReview.length === 1 ? 'account was' : 'accounts were'} discovered by a sync and ${needReview.length === 1 ? 'its type is' : 'their types are'} a guess.`,
      actionPath: '/settings/accounts',
    });
  }

  /*
   * A check the bank appears to have cashed, waiting to be confirmed.
   *
   * Above the backlog and below the faults: it is not something that has gone
   * wrong, but it is money sitting in the wrong place until somebody looks. The
   * check line still holds the funds and the payment is still uncategorized, so
   * nothing is lost by leaving it — it is simply not finished.
   */
  if (checkMatches.length > 0) {
    const numbers = checkMatches
      .slice(0, 3)
      .map((match) => match.checkNumber)
      .join(', ');
    notifications.push({
      kind: 'checks_awaiting_confirmation',
      pill:
        checkMatches.length === 1
          ? '1 check to confirm'
          : `${checkMatches.length} checks to confirm`,
      severity: 'confirm',
      message:
        checkMatches.length === 1
          ? `Check ${numbers} looks like it has been cashed. Confirm the match to settle it.`
          : checkMatches.length <= 3
            ? `Checks ${numbers} look like they have been cashed. Confirm each match to settle it.`
            : `${checkMatches.length} checks look like they have been cashed, including ${numbers}.`,
      actionPath: '/',
    });
  }

  // Informational, not a fault: a backlog is the normal state before go-live.
  if (uncategorized > 0) {
    const age = oldestUncategorized ? daysBetween(oldestUncategorized.postedAt, now) : 0;
    notifications.push({
      kind: 'uncategorized_backlog',
      pill: uncategorized === 1 ? '1 new transaction' : `${uncategorized} new transactions`,
      severity: 'info',
      message:
        age >= 1
          ? `${uncategorized} ${uncategorized === 1 ? 'transaction is' : 'transactions are'} waiting to be categorized, the oldest from ${age} ${age === 1 ? 'day' : 'days'} ago.`
          : `${uncategorized} ${uncategorized === 1 ? 'transaction is' : 'transactions are'} waiting to be categorized.`,
      // The filtered queue, not the whole register: this is a link for somebody
      // who came to clear a backlog. Reaching Transactions any other way still
      // opens on everything, which is the right default for looking something
      // up.
      actionPath: '/transactions?uncategorized=true',
    });
  }

  /*
   * A bill that has not arrived.
   *
   * The only condition here that is about something *not* happening, which is
   * why nothing else could raise it: a failed autopay and a cancelled service
   * both look like an ordinary quiet week from the inside.
   *
   * The one notification with a switch, on Settings → Budget. It is a reading of
   * a schedule inferred from history rather than a fact the application knows,
   * so a household that finds it noisy can turn it off — and the page stays
   * either way, because turning off the telling should not hide the list.
   */
  if (settings.recurringAlertsEnabled) {
    const overdue = overdueBills(await findRecurringBills(db, timeZone, now));
    if (overdue.length > 0) {
      const first = overdue[0]!;
      notifications.push({
        kind: 'recurring_bill_overdue',
        pill: overdue.length === 1 ? '1 bill overdue' : `${overdue.length} bills overdue`,
        severity: 'warning',
        message:
          overdue.length === 1
            ? `${first.name} usually arrives every ${first.intervalDays} days and is ${first.daysLate} days late.`
            : `${overdue.length} bills have not arrived on time, the latest being ${first.name} at ${first.daysLate} days.`,
        actionPath: '/bills',
      });
    }
  }

  /*
   * A line that will not make its date at the amount it is set to.
   *
   * No switch, unlike the overdue bill above, and the difference is worth
   * stating: a bill is a schedule this application *inferred* and can be wrong
   * about, while a target is a number the household typed. Being behind on it is
   * arithmetic on their own figures, and turning off arithmetic is not a
   * preference — it is hiding the answer to the question they asked.
   */
  const behind = await findBehindTargets(db, localDayKey(now, timeZone), settings.payCadence);
  if (behind.length > 0) {
    const first = behind[0]!;
    notifications.push({
      kind: 'targets_behind',
      pill: behind.length === 1 ? '1 line behind' : `${behind.length} lines behind`,
      severity: 'warning',
      message:
        behind.length === 1
          ? `${first.name} needs ${formatCents(first.progress.neededPerCycleCents ?? 0n)} a paycheck to make its date.`
          : `${behind.length} lines will not make their date at the amount they are set to, the soonest being ${first.name}.`,
      // The Budget page: the amount that is wrong is a cell on that row, and
      // fixing it is typing over it.
      actionPath: '/',
    });
  }

  // §8: a holding is never shown as zero or blank when the feed is unreachable —
  // the last price is held and flagged. This is the flag.
  if (price?.stale) {
    const days = daysBetween(price.priceDate, now);
    notifications.push({
      kind: 'bitcoin_price_stale',
      pill: 'Stale price',
      severity: 'warning',
      message: `The Bitcoin price is from ${days === 1 ? 'yesterday' : `${days} days ago`}. Holdings are valued at that price.`,
      actionPath: '/settings/bitcoin',
    });
  }

  return notifications;
}
