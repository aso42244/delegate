import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { HeaderPill } from './HeaderPill.jsx';

/**
 * What the application needs to tell the owner about itself.
 *
 * Every one of these is a condition he would otherwise only discover by noticing
 * a number was wrong. A sync failing for three days looks exactly like a quiet
 * week; a cash balance nobody has confirmed since March looks exactly like a
 * cash balance.
 *
 * Two shapes, and which one a condition gets is decided by whether ignoring it
 * costs the household its data or merely its tidiness:
 *
 * - **`danger` is a bar**, full width, above the page. The backup has never run;
 *   the sync is failing. Two conditions, both of which mean the numbers on
 *   screen are quietly wrong or the only copy of them is at risk. These earn the
 *   width.
 * - **Everything else is a pill** in the page header, beside the budget's own
 *   reading and shaped exactly like it. A bank wanting a fresh login and a
 *   handful of transactions waiting to be categorized are both real and neither
 *   is an emergency — as two stacked bars they pushed the budget a third of the
 *   way down the screen to say six words.
 *
 * The pills carry no dismiss. Snoozing exists because a bar is in the way, and a
 * pill is not in the way; what makes a pill go away is fixing the thing.
 */

type Severity = 'info' | 'confirm' | 'warning' | 'danger';

interface NotificationDto {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  /** Two or three words for the pill's face; `message` is its detail. */
  readonly pill: string;
  readonly actionPath: string;
  readonly actionLabel: string;
}

const TONES: Record<Severity, string> = {
  info: 'border-accent bg-accent-soft text-accent',
  // Purple: worked out, not yet acted on, waiting on a person.
  confirm: 'border-confirm-line bg-confirm-soft text-confirm',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
};

const SNOOZE_KEY = 'budget.notifications.snoozed';
const SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Keyed on the message rather than the kind alone, so a snooze covers the
 * condition that was actually read and dismissed. A second bank failing, or a
 * backlog that has grown, is news again.
 */
function signatureOf(notification: NotificationDto): string {
  return `${notification.kind}:${notification.message}`;
}

type Snoozes = Record<string, number>;

function readSnoozes(): Snoozes {
  if (typeof window === 'undefined') return {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SNOOZE_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null) return {};

    // Expired entries are dropped on read rather than left to accumulate; a
    // signature contains a whole message, so this store would otherwise grow
    // without bound.
    const cutoff = Date.now() - SNOOZE_MS;
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > cutoff,
      ),
    );
  } catch {
    // Corrupt or unavailable storage must not cost the owner his banners.
    return {};
  }
}

function useNotifications(): readonly NotificationDto[] {
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: readonly NotificationDto[] }>('/api/notifications'),
    // Re-checked periodically: a sync failing at 3am should be on screen by
    // breakfast without the page being reloaded.
    refetchInterval: 5 * 60 * 1000,
  });
  return query.data?.notifications ?? [];
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
 * The conditions that are not emergencies, in the page header.
 *
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
  const notifications = useNotifications();

  const pills = notifications.filter((notification) => notification.severity !== 'danger');
  if (pills.length === 0) return null;

  return (
    <>
      {pills.map((notification) => (
        <NotificationPill key={notification.kind} notification={notification} />
      ))}
    </>
  );
}

/**
 * The two conditions that get a bar, above whatever page he is on.
 *
 * They can be put away, but not cleared. A bar dismissed for a condition that is
 * still true would be a lie the interface tells on the owner's behalf, so the X
 * is a snooze: gone for a day, back afterwards if the thing it is about is still
 * the case. What makes it go away for good is fixing it.
 */
export function NotificationBanners(): ReactNode {
  const [snoozes, setSnoozes] = useState<Snoozes>(readSnoozes);
  const notifications = useNotifications();

  function snooze(notification: NotificationDto): void {
    const next = { ...snoozes, [signatureOf(notification)]: Date.now() };
    setSnoozes(next);
    try {
      window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing. It stays dismissed for this page view and comes back
      // on the next, which is the safe direction to fail in.
    }
  }

  const bars = notifications.filter(
    (notification) =>
      notification.severity === 'danger' && snoozes[signatureOf(notification)] === undefined,
  );
  if (bars.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      {bars.map((notification) => (
        <div
          key={notification.kind}
          // `status` rather than `alert`: these are standing conditions, and an
          // assertive live region would interrupt a screen reader every time the
          // poll came back.
          role="status"
          className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-quiet ${TONES[notification.severity]}`}
        >
          {/* The message takes the slack, so the two controls stay together at
              the right rather than drifting apart on a wide screen. */}
          <span className="flex-1">{notification.message}</span>
          <Link
            to={notification.actionPath}
            className="rounded border border-current px-2 py-0.5 font-semibold"
          >
            {notification.actionLabel}
          </Link>
          <button
            type="button"
            onClick={() => snooze(notification)}
            aria-label={`Dismiss: ${notification.message}`}
            title="Dismiss for a day"
            className="-mr-1 rounded px-1.5 py-0.5 leading-none hover:bg-current/10"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
