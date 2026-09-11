import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { budgetApi } from '../api/budget.js';
import { useQuery } from '@tanstack/react-query';
import { AlertTag, type PillTone } from './AlertTag.jsx';
import { BalanceReading } from './BalanceReading.jsx';
import { Modal } from './ui.jsx';
import { Tag } from './Tag.jsx';
import {
  byUrgency,
  loudest,
  SYNC_KINDS,
  useNotifications,
  type NotificationDto,
} from './notifications.js';

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
 * **The bank feed's own are not here.** Everything in `SYNC_KINDS` is folded
 * into the Sync SimpleFIN button directly below this column — see
 * `notifications.ts`. What is left is the half the feed cannot answer for.
 *
 * **Except on a phone, where there is no sidebar.** Below `sm` the navigation is
 * a tab bar and the sidebar is not rendered at all, so a stack that lived only
 * there would take a sync failure or a bank needing a fresh login off the small
 * screen entirely — silently, and for the reader most likely to be away from the
 * machine that can fix it. `inline` is that case, and it is **one dot**: a
 * phone's page header has room for a create menu, Delegate and a period picker
 * or it has room for five tags, and the tags were winning. The dot carries the
 * loudest colour, and pressing it opens the lot.
 *
 * There is no dismiss. Snoozing existed because a bar was in the way, and this
 * is not in the way; what makes one go away is fixing the thing it is about.
 */

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
  const notifications = useNotifications();

  // The same key the Budget page uses, so the two share one fetch.
  const budget = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });

  const all = notifications.data?.notifications ?? [];
  const view = budget.data ?? null;

  /*
   * A phone keeps every one of them, the feed's included.
   *
   * There is no Sync button below `sm` to fold them into, and an alert that is
   * on screen on a laptop and nowhere at all on a phone is the exact failure
   * this component's `inline` case exists to prevent.
   */
  const rows = byUrgency(inline ? all : all.filter((row) => !SYNC_KINDS.has(row.kind)));

  if (rows.length === 0 && view === null) return null;

  if (inline) {
    return (
      <span className="contents">
        {rows.length > 0 && <AlertDot rows={rows} />}
        {view !== null && <BalanceReading view={view} />}
      </span>
    );
  }

  /*
   * The notifications, and only those.
   *
   * The budget's own reading used to be the last row here. It is a **control**
   * now — the top of the sidebar's control zone, always coloured, always a way
   * to Overview (ADR 064) — so it is drawn by `Sidebar` rather than by the
   * column of things the application is reporting.
   *
   * `items-start` so a short tag is as wide as its words rather than as wide as
   * the column — these are tags, not buttons. `min-w-0` so the long ones
   * truncate instead of widening the sidebar, which is the whole reason the face
   * carries `truncate` and the detail carries the sentence.
   */
  if (rows.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 px-3 pb-3">
      {rows.map((notification) => (
        <Notification key={notification.kind} notification={notification} />
      ))}
    </div>
  );
}

const DOT_TONES: Record<PillTone, string> = {
  positive: 'bg-positive',
  info: 'bg-accent',
  confirm: 'bg-confirm',
  warning: 'bg-warning',
  danger: 'bg-danger-dot',
};

/**
 * Everything the application has to say, on a phone, as one coloured dot.
 *
 * The tags themselves do not fit. Three of them wrap the page title onto a
 * second and third line and push the period picker off the bottom of the header
 * — and they are tooltips, which a touchscreen has no way to open. A dot is
 * 8px, carries the loudest colour, and opens the whole list on a press, which is
 * the gesture a phone actually has.
 *
 * **Colour is never the only carrier** (design.md §9): the count is in the
 * accessible name, and the list behind it is words.
 */
function AlertDot({ rows }: { readonly rows: readonly NotificationDto[] }): ReactNode {
  const [open, setOpen] = useState(false);
  const tone = loudest(rows) ?? 'info';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${rows.length} ${rows.length === 1 ? 'alert' : 'alerts'}`}
        // 24px of target around an 8px mark, so it is pressable at the size
        // WCAG 2.5.8 asks for without drawing a button beside the title.
        className="-m-2 inline-flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-full p-2 hover:bg-surface-2"
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${DOT_TONES[tone]}`} />
      </button>

      {open && <AlertsDialog rows={rows} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The list behind the dot, loudest first.
 *
 * Downwards here rather than upwards: a dialog is read from the top, unlike the
 * sidebar's column, which is read up towards the reading at its foot.
 *
 * Each row is a link to where the condition is dealt with, which is what the
 * tags it replaces were. A reading nobody can act on from the screen they are
 * holding is half a notification.
 */
function AlertsDialog({
  rows,
  onClose,
}: {
  readonly rows: readonly NotificationDto[];
  readonly onClose: () => void;
}): ReactNode {
  const loudestFirst = [...byUrgency(rows)].reverse();

  return (
    <Modal label="Alerts" title="Alerts" onClose={onClose} dismissible>
      <ul className="flex list-none flex-col gap-4 p-0">
        {loudestFirst.map((row) => (
          <li key={row.kind}>
            <Link
              to={row.actionPath}
              onClick={onClose}
              className="flex flex-col items-start gap-1 rounded-lg p-2 hover:bg-surface-2"
            >
              <Tag tone={row.severity} size="md">
                {row.pill}
              </Tag>
              <span className="text-quiet text-ink">{row.message}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
