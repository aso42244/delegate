import { isBalanceStale } from '@budget/shared';
import type { Db } from '../db/client.js';
import { latestPrice } from './bitcoin.js';
import { proposeCheckMatches } from './checks.js';

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
    | 'checks_awaiting_confirmation';
  readonly severity: NotificationSeverity;
  readonly message: string;
  /** Where to go to do something about it. */
  readonly actionPath: string;
  readonly actionLabel: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export async function buildNotifications(db: Db, now: Date = new Date()): Promise<Notification[]> {
  const notifications: Notification[] = [];

  const [latestRun, accounts, uncategorized, oldestUncategorized, price, checkMatches] =
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
      latestPrice(db, now),
      proposeCheckMatches(db),
    ]);

  // A failed sync must be visible in the UI, not only in the logs — §13.
  if (latestRun?.status === 'failed') {
    const days = daysBetween(latestRun.startedAt, now);
    notifications.push({
      kind: 'sync_failing',
      severity: 'danger',
      message:
        days >= 1
          ? `The last sync failed ${days === 1 ? 'yesterday' : `${days} days ago`}. Balances and transactions are not up to date.`
          : 'The last sync failed. Balances and transactions are not up to date.',
      actionPath: '/settings/sync',
      actionLabel: 'Sync',
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
      severity: 'warning',
      // Multiple institutions can complain in one run.
      message: latestRun.error.split('\n').filter(Boolean).join(' · '),
      actionPath: '/settings/sync',
      actionLabel: 'Sync',
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
      severity: 'warning',
      message:
        stale.length <= 3
          ? `${names} ${stale.length === 1 ? 'has' : 'have'} not been confirmed recently.`
          : `${names} and ${stale.length - 3} more have not been confirmed recently.`,
      actionPath: '/settings/accounts',
      actionLabel: 'Accounts',
    });
  }

  const needReview = accounts.filter((account) => account.needsReview);
  if (needReview.length > 0) {
    notifications.push({
      kind: 'accounts_need_review',
      severity: 'warning',
      message: `${needReview.length} ${needReview.length === 1 ? 'account was' : 'accounts were'} discovered by a sync and ${needReview.length === 1 ? 'its type is' : 'their types are'} a guess.`,
      actionPath: '/settings/accounts',
      actionLabel: 'Review',
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
      severity: 'confirm',
      message:
        checkMatches.length === 1
          ? `Check ${numbers} looks like it has been cashed. Confirm the match to settle it.`
          : checkMatches.length <= 3
            ? `Checks ${numbers} look like they have been cashed. Confirm each match to settle it.`
            : `${checkMatches.length} checks look like they have been cashed, including ${numbers}.`,
      actionPath: '/',
      actionLabel: 'Confirm',
    });
  }

  // Informational, not a fault: a backlog is the normal state before go-live.
  if (uncategorized > 0) {
    const age = oldestUncategorized ? daysBetween(oldestUncategorized.postedAt, now) : 0;
    notifications.push({
      kind: 'uncategorized_backlog',
      severity: 'info',
      message:
        age >= 1
          ? `${uncategorized} ${uncategorized === 1 ? 'transaction is' : 'transactions are'} waiting to be categorized, the oldest from ${age} ${age === 1 ? 'day' : 'days'} ago.`
          : `${uncategorized} ${uncategorized === 1 ? 'transaction is' : 'transactions are'} waiting to be categorized.`,
      actionPath: '/transactions',
      actionLabel: 'Categorize',
    });
  }

  // §8: a holding is never shown as zero or blank when the feed is unreachable —
  // the last price is held and flagged. This is the flag.
  if (price?.stale) {
    const days = daysBetween(price.priceDate, now);
    notifications.push({
      kind: 'bitcoin_price_stale',
      severity: 'warning',
      message: `The Bitcoin price is from ${days === 1 ? 'yesterday' : `${days} days ago`}. Holdings are valued at that price.`,
      actionPath: '/settings/bitcoin',
      actionLabel: 'Bitcoin',
    });
  }

  return notifications;
}
