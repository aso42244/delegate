import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useIsDemo } from '../useDemo.js';
import type { PillTone } from './AlertTag.jsx';

/**
 * What the application has to say about itself, and how loud each of it is.
 *
 * Split out of `Alerts` because there are two readers now. The sidebar still
 * draws a column of tags; the **Sync SimpleFIN button** draws the ones that are
 * about the bank feed, folded into itself. Two components asking the same
 * question needed the question to live somewhere neither of them owns.
 */

export interface NotificationDto {
  readonly kind: string;
  readonly severity: PillTone;
  readonly message: string;
  /** Two or three words for the tag's face; `message` is its detail. */
  readonly pill: string;
  readonly actionPath: string;
}

/**
 * How loud each one is.
 *
 * The order down the sidebar's column is by this, and that column reads
 * **upwards**: the most urgent thing sits at the bottom, nearest the budget's
 * reading and nearest the eye, with the quieter ones stacked above it. A list
 * that grows and shrinks from the top leaves the thing that matters most in the
 * same place.
 */
const URGENCY: Record<PillTone, number> = {
  positive: 0,
  info: 1,
  confirm: 2,
  warning: 3,
  danger: 4,
};

/**
 * Quietest first, so the rendered column ends at the loudest.
 *
 * A function rather than a sort inlined into the component, because it is the
 * part worth proving and it cannot be staged end to end: the API reports the
 * worst sync condition rather than all of them, and it suppresses "not
 * reporting" while a sync is failing outright — both correct, and between them
 * they make two severities at once hard to arrange in a fixture.
 */
export function byUrgency<T extends { readonly severity: PillTone }>(
  rows: readonly T[],
): readonly T[] {
  return [...rows].sort((a, b) => URGENCY[a.severity] - URGENCY[b.severity]);
}

/** The loudest of them, or `null` for nothing to say. */
export function loudest<T extends { readonly severity: PillTone }>(
  rows: readonly T[],
): PillTone | null {
  const sorted = byUrgency(rows);
  return sorted.length === 0 ? null : (sorted[sorted.length - 1]?.severity ?? null);
}

/**
 * The conditions the bank feed is responsible for.
 *
 * These fold into the Sync SimpleFIN button rather than standing as tags of
 * their own: every one of them is answered by looking at the connection, and the
 * button is the thing somebody presses about it. A column of five yellow tags
 * beside a yellow button was the same sentence said twice.
 *
 * **Only the feed's own.** A categorization backlog, a cheque waiting to be
 * confirmed, an overdue bill, a stalled backup — none of those is anything the
 * bridge did or failed to do, and burying them inside a button about the bank
 * would be hiding them. They stay tags.
 *
 * `stale_balances` is here because it is an account's figure going unconfirmed,
 * which is the same question the feed answers for every account it does report.
 */
export const SYNC_KINDS: ReadonlySet<string> = new Set([
  'sync_failing',
  'sync_warning',
  'stale_balances',
  'feed_not_reporting',
  'accounts_need_review',
]);

/**
 * Everything the application currently has to say.
 *
 * One query key, so the sidebar's column and the Sync button's own fold share a
 * single fetch however many components ask.
 */
export function useNotifications(): UseQueryResult<{
  readonly notifications: readonly NotificationDto[];
}> {
  const demo = useIsDemo();

  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: readonly NotificationDto[] }>('/api/notifications'),
    // Re-checked periodically: a sync failing at 3am should be on screen by
    // breakfast without the page being reloaded.
    refetchInterval: 5 * 60 * 1000,
    /*
     * Never in the demo. These are facts about the owner's own machine — a bank
     * feed that needs a fresh login, an account of his that has stopped
     * reporting — and a demo is a household, not his infrastructure.
     */
    enabled: !demo,
  });
}
