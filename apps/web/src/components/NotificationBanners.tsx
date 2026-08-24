import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

/**
 * What the application needs to tell the owner about itself, above whatever page
 * he is on.
 *
 * Every one of these is a condition he would otherwise only discover by noticing
 * a number was wrong. A sync failing for three days looks exactly like a quiet
 * week; a cash balance nobody has confirmed since March looks exactly like a
 * cash balance.
 *
 * They can be put away, but not cleared. A banner dismissed for a condition that
 * is still true would be a lie the interface tells on the owner's behalf, so the
 * X is a snooze: gone for a day, back afterwards if the thing it is about is
 * still the case. What makes it go away for good is fixing it.
 */

type Severity = 'info' | 'confirm' | 'warning' | 'danger';

interface NotificationDto {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
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

export function NotificationBanners(): ReactNode {
  const [snoozes, setSnoozes] = useState<Snoozes>(readSnoozes);

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: readonly NotificationDto[] }>('/api/notifications'),
    // Re-checked periodically: a sync failing at 3am should be on screen by
    // breakfast without the page being reloaded.
    refetchInterval: 5 * 60 * 1000,
  });

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

  const notifications = (query.data?.notifications ?? []).filter(
    (notification) => snoozes[signatureOf(notification)] === undefined,
  );
  if (notifications.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      {notifications.map((notification) => (
        <div
          key={notification.kind}
          // `status` rather than `alert`: these are standing conditions, and an
          // assertive live region would interrupt a screen reader every time the
          // poll came back.
          role="status"
          className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-quiet ${TONES[notification.severity]}`}
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
