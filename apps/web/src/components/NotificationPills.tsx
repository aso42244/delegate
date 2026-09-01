import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { api } from '../api/client.js';
import { HeaderPill, type PillTone } from './HeaderPill.jsx';

/**
 * What the application needs to tell the owner about itself, in the page header.
 *
 * Every one of these is a condition he would otherwise only discover by noticing
 * a number was wrong. A sync failing for three days looks exactly like a quiet
 * week; a cash balance nobody has confirmed since March looks exactly like a
 * cash balance.
 *
 * They were full-width bars stacked above the page, then bars for the two
 * conditions that can cost the household its data and pills for the other six.
 * They are all pills now, beside the budget's own reading and shaped exactly
 * like it — see ADR 040. Severity is carried by the colour and by the words,
 * which is how it is carried everywhere else here; the bar was saying it a third
 * time in floor space, and charged the Budget page a row for it.
 *
 * There is no dismiss. Snoozing existed because a bar was in the way, and a pill
 * is not in the way; what makes one go away is fixing the thing it is about.
 */

interface NotificationDto {
  readonly kind: string;
  readonly severity: PillTone;
  readonly message: string;
  /** Two or three words for the pill's face; `message` is its detail. */
  readonly pill: string;
  readonly actionPath: string;
}

/** One pill, which needs its own `useId` and so cannot be inlined into a map. */
function NotificationPill({ notification }: { notification: NotificationDto }): ReactNode {
  const detailId = useId();
  return (
    <HeaderPill
      tone={notification.severity}
      label={notification.pill}
      detail={notification.message}
      detailId={detailId}
      to={notification.actionPath}
    />
  );
}

/**
 * Rendered by `PageHeader`, so they appear on every screen rather than only on
 * the one that happens to have a reading of its own — a bank that needs a fresh
 * login is not a fact about the Budget page, and it was not one when it was a
 * bar either.
 *
 * Including the page a pill points at. Hiding it there was tried and is wrong in
 * the case that matters most: the cashed-check proposal points at the Budget
 * page, because the row you confirm is on it, so suppressing it there would show
 * the pill everywhere except where it can be acted on. Left visible, the count
 * on it also runs down as the queue is cleared, which is the better feedback.
 */
export function NotificationPills(): ReactNode {
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: readonly NotificationDto[] }>('/api/notifications'),
    // Re-checked periodically: a sync failing at 3am should be on screen by
    // breakfast without the page being reloaded.
    refetchInterval: 5 * 60 * 1000,
  });

  const notifications = query.data?.notifications ?? [];
  if (notifications.length === 0) return null;

  return (
    <>
      {notifications.map((notification) => (
        <NotificationPill key={notification.kind} notification={notification} />
      ))}
    </>
  );
}
