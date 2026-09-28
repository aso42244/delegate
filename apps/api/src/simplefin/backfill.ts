import type { FetchAccountsOptions, SimpleFinClient } from './client.js';
import type { FeedAccount, FeedResult, FeedTransaction } from './protocol.js';

/**
 * Fetching a window longer than the bridge will serve in one request.
 *
 * The bridge caps a single request's date range and says so in `errlist` rather
 * than failing:
 *
 *   "Requested date range exceeds limit of 90 days and was capped."
 *
 * A capped request still returns 200 with a plausible-looking set of
 * transactions, so asking for twelve months and trusting the answer silently
 * yields three. That matters more here than it looks: the go-live reconciliation
 * corrects delegation balances against a *categorized twelve-month backlog*, and
 * a backlog that is quietly a quarter of the intended length produces balances
 * that are wrong in a way nothing on screen would reveal.
 *
 * So a long window is split into consecutive requests and the results merged.
 */

/**
 * The bridge caps a request at 90 days but *recommends* 45, and says so:
 *
 *   "Requested date range exceeds recommended range of 45 days.
 *    In the future, this may be capped."
 *
 * Following the recommendation rather than the current hard limit costs a few
 * more requests on the one-off backfill and nothing at all afterwards, and means
 * a future tightening cannot silently truncate history.
 */
export const MAX_WINDOW_DAYS = 45;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WindowedFetchOptions extends FetchAccountsOptions {
  readonly startDate: Date;
  readonly endDate?: Date | undefined;
  /** Overridable for tests; defaults to the bridge's cap. */
  readonly maxWindowDays?: number;
}

/** Consecutive, non-overlapping windows covering `[start, end]`. */
export function planWindows(
  start: Date,
  end: Date,
  maxWindowDays: number = MAX_WINDOW_DAYS,
): { start: Date; end: Date }[] {
  if (end <= start) return [{ start, end }];

  const windows: { start: Date; end: Date }[] = [];
  const stepMs = maxWindowDays * MS_PER_DAY;

  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += stepMs) {
    windows.push({
      start: new Date(cursor),
      end: new Date(Math.min(cursor + stepMs, end.getTime())),
    });
  }

  return windows;
}

/**
 * Fetches a date range in as many requests as the cap requires, then merges.
 *
 * Windows run oldest first so that account metadata — most importantly the
 * balance — ends up taken from the most recent response rather than a stale one.
 * Transactions are keyed by id while merging, because consecutive windows can
 * legitimately return the same row at a boundary.
 */
export async function fetchAccountsInWindows(
  client: SimpleFinClient,
  options: WindowedFetchOptions,
): Promise<FeedResult> {
  const endDate = options.endDate ?? new Date();
  const windows = planWindows(options.startDate, endDate, options.maxWindowDays);

  if (windows.length === 1) {
    return client.fetchAccounts({
      startDate: options.startDate,
      endDate: options.endDate,
      ...(options.includePending === undefined ? {} : { includePending: options.includePending }),
    });
  }

  const accountsByExternalId = new Map<string, FeedAccount>();
  const transactionsByAccount = new Map<string, Map<string, FeedTransaction>>();
  const errors = new Set<string>();

  for (const [index, window] of windows.entries()) {
    const isLastWindow = index === windows.length - 1;

    const result = await client.fetchAccounts({
      startDate: window.start,
      endDate: window.end,
      // Pending transactions only exist at the leading edge, so asking for them
      // in historical windows is pointless work for the bridge.
      ...(options.includePending === undefined
        ? { includePending: isLastWindow }
        : { includePending: options.includePending && isLastWindow }),
    });

    for (const error of result.errors) errors.add(error);

    for (const account of result.accounts) {
      // Later windows overwrite earlier metadata, so the balance is the freshest.
      accountsByExternalId.set(account.externalId, account);

      let seen = transactionsByAccount.get(account.externalId);
      if (!seen) {
        seen = new Map();
        transactionsByAccount.set(account.externalId, seen);
      }
      for (const transaction of account.transactions) {
        seen.set(transaction.externalId, transaction);
      }
    }
  }

  const accounts = [...accountsByExternalId.values()].map((account): FeedAccount => ({
    ...account,
    transactions: [...(transactionsByAccount.get(account.externalId)?.values() ?? [])],
  }));

  return { accounts, errors: [...errors] };
}
