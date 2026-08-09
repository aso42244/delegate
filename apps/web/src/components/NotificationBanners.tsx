import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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
 * They are not dismissible. A dismissed banner for a condition that is still
 * true is a lie the interface tells on the owner's behalf — these disappear when
 * the thing they are about stops being the case, and not before.
 */

type Severity = 'info' | 'warning' | 'danger';

interface NotificationDto {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly actionPath: string;
  readonly actionLabel: string;
}

const TONES: Record<Severity, string> = {
  info: 'border-accent bg-accent-soft text-accent',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
};

export function NotificationBanners(): ReactNode {
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
    <div className="mb-4 flex flex-col gap-2">
      {notifications.map((notification) => (
        <div
          key={notification.kind}
          // `status` rather than `alert`: these are standing conditions, and an
          // assertive live region would interrupt a screen reader every time the
          // poll came back.
          role="status"
          className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-quiet ${TONES[notification.severity]}`}
        >
          <span>{notification.message}</span>
          <Link
            to={notification.actionPath}
            className="rounded border border-current px-2 py-0.5 font-semibold"
          >
            {notification.actionLabel}
          </Link>
        </div>
      ))}
    </div>
  );
}
