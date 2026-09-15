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
 * **Only the feed's own.** A cheque waiting to be confirmed, an overdue bill, a
 * stalled backup — none of those is anything the bridge did or failed to do, and
 * burying them inside a button about the bank would be hiding them. They stay
 * tags. So did the categorization backlog until ADR 066, which moved it for the
 * opposite reason: not that it belongs to the feed, but that it is work rather
 * than a condition. See `BACKLOG_KIND` below.
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
 * The categorization backlog, which is a control rather than a tag.
 *
 * ADR 063 drew its line at what the bank feed is responsible for, put this on
 * the other side of it, and said so explicitly: "they stay tags". That was right
 * about the reason and wrong about the shape.
 *
 * Everything else left in that column is a **condition** — a bank that needs a
 * fresh login, a cheque nobody has confirmed, a bill that did not arrive. You
 * read it, and then you decide what to do about it. A backlog is not a
 * condition. It is a queue of work, there is exactly one thing anybody ever does
 * about it, and since ADR 065 the doing of it starts on the screen this sits on.
 * So it belongs with the acts on the household rather than with the things being
 * reported (ADR 066).
 *
 * **Only where there is a control zone to hold it.** A phone has no sidebar, so
 * `Alerts inline` keeps it among the tags there — the same reason `SYNC_KINDS`
 * are unfolded again on a phone, and the same failure being avoided: a thing on
 * screen on a laptop and nowhere at all on a phone.
 */
export const BACKLOG_KIND = 'uncategorized_backlog';

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
