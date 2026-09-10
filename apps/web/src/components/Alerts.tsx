import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { api } from '../api/client.js';
import { budgetApi } from '../api/budget.js';
import { AlertTag, type PillTone } from './AlertTag.jsx';
import { BalanceReading } from './BalanceReading.jsx';
import { useIsDemo } from '../useDemo.js';

/**
 * What is true right now.
 *
 * Every one of these is a condition the owner would otherwise discover only by
 * noticing a number was wrong. A sync failing for three days looks exactly like
 * a quiet week; a cash balance nobody has confirmed since March looks exactly
 * like a cash balance.
 *
 * They were full-width bars above the page, then pills beside the page title,
 * and they are here now. The header was the wrong home for two reasons: they are
 * not facts about the page they happened to be sitting on, and they pushed the
 * title's own controls around as they came and went. The sidebar is on every
 * screen and is not competing with anything.
 *
 * **Except on a phone, where there is no sidebar.** Below `sm` the navigation is
 * a tab bar and the sidebar is not rendered at all, so a stack that lived only
 * there would take a sync failure or a bank needing a fresh login off the small
 * screen entirely — silently, and for the reader most likely to be away from the
 * machine that can fix it. `inline` is that case: the same alerts, back beside
 * the page title, which is where they used to live.
 *
 * There is no dismiss. Snoozing existed because a bar was in the way, and this
 * is not in the way; what makes one go away is fixing the thing it is about.
 */

interface NotificationDto {
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
 * The order down the column is by this, and the column reads **upwards**: the
 * most urgent thing sits at the bottom, nearest the budget's reading and nearest
 * the eye, with the quieter ones stacked above it. A list that grows and shrinks
 * from the top leaves the thing that matters most in the same place.
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

/** One tag, which needs its own `useId` and so cannot be inlined into a map. */
function Notification({ notification }: { notification: NotificationDto }): ReactNode {
  const detailId = useId();
  return (
    <AlertTag
      tone={notification.severity}
      label={notification.pill}
      detail={notification.message}
      detailId={detailId}
      to={notification.actionPath}
    />
  );
}

export function Alerts({ inline = false }: { readonly inline?: boolean }): ReactNode {
  const demo = useIsDemo();

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ notifications: readonly NotificationDto[] }>('/api/notifications'),
    // Re-checked periodically: a sync failing at 3am should be on screen by
    // breakfast without the page being reloaded.
    refetchInterval: 5 * 60 * 1000,
    /*
     * Never in the demo. These are facts about the owner's own machine — a bank
     * feed that needs a fresh login, an account of his that has stopped
     * reporting — and a demo is a household, not his infrastructure. The budget
     * reading below is invented like everything else on those pages, so it
     * stays.
     */
    enabled: !demo,
  });

  // The same key the Budget page uses, so the two share one fetch.
  const budget = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const rows = byUrgency(notifications.data?.notifications ?? []);

  const view = budget.data ?? null;
  if (rows.length === 0 && view === null) return null;

  /*
   * `items-start` so a short tag is as wide as its words rather than as wide as
   * the column — these are tags, not buttons. `min-w-0` so the long ones
   * truncate instead of widening the sidebar, which is the whole reason the face
   * carries `truncate` and the detail carries the sentence.
   *
   * Beside a title the order reverses: a column is read downwards towards the
   * most urgent thing, a row is read left to right, so `flex-row-reverse` keeps
   * the reading first and the urgent items nearest it either way.
   */
  const shape = inline
    ? 'flex min-w-0 flex-row-reverse flex-wrap items-center gap-2'
    : 'flex min-w-0 flex-col items-start gap-1 px-3 pb-3';

  return (
    <div className={shape}>
      {rows.map((notification) => (
        <Notification key={notification.kind} notification={notification} />
      ))}
      {/* Always last in the source, so it is the bottom of the column and the
          first thing on the row: the reading somebody looks for sits in the same
          place whatever else the application has to say today. */}
      {view !== null && <BalanceReading view={view} />}
    </div>
  );
}
