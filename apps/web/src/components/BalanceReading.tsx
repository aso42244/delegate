import { classifyIdentity, formatCents, formatIdentityLabel } from '@budget/shared';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { BudgetViewDto } from '../api/budget.js';
import { type PillTone } from './AlertTag.jsx';
import { ControlPopover } from './ControlPopover.jsx';
import { buttonFace, Modal, type ButtonVariant } from './ui.jsx';
import { useIsDemo } from '../useDemo.js';
import { pathFor } from '../demo/is-demo.js';

/**
 * The bottom-line reading: Balanced, To delegate, Over-delegated.
 *
 * It was a full-width bar carrying the state on the left and the equation on the
 * right. The equation is the reason to trust the number, but it is not something
 * anybody reads twice a day, and a bar's worth of page for it pushed the budget
 * itself down the screen. So the state stays visible and the working is one
 * hover away.
 *
 * **Three states and three colours.** Green when the parts add up, blue when
 * there is money waiting to be delegated, red when more has been delegated than
 * exists. A positive reading is informational rather than a warning — it is the
 * ordinary state on payday, and that figure *is* the amount available to
 * delegate, so colouring the commonest healthy state as a fault would train the
 * owner to ignore the one reading that has to be read.
 *
 * Over-delegation used to split into yellow inside twice the tolerance and red
 * beyond it. That distinction is gone (ADR 064): over-delegated is the direction
 * that is genuinely wrong at any size, and the reading is now a *control* whose
 * colour is read at a glance rather than compared against itself.
 *
 * Two faces, one set of words and one tone:
 *
 * - `BalanceReading` is the tag, beside the page title on a phone — where there
 *   is no sidebar, and no control zone to put a button in.
 * - `BalanceButton` is the control, at the top of the sidebar's foot, always
 *   coloured and always a way to Overview.
 */

/**
 * Three states, three colours — so the tone is typed to the three rather than to
 * every tone a tag can take. `VARIANTS` and `GLYPHS` below are then total, and a
 * fourth state could not be added without this line refusing to compile.
 */
type ReadingTone = Extract<PillTone, 'positive' | 'info' | 'danger'>;

interface Reading {
  readonly tone: ReadingTone;
  readonly message: string;
  readonly working: ReactNode;
}

/**
 * What the reading says, how alarmed to be, and the arithmetic behind it.
 *
 * A function rather than logic inside either face, because the phone's tag and
 * the sidebar's button must never disagree about the state of one budget —
 * which is exactly what two copies of a threshold produce.
 */
function read(view: BudgetViewDto): Reading {
  const difference = BigInt(view.identity.differenceCents);
  const tolerance = BigInt(view.identity.toleranceCents);
  // Signed: negative for a pending spend, which is the ordinary case.
  const pending = BigInt(view.identity.pendingCents);

  // The wording comes from `formatIdentityLabel`; only the tone is decided here.
  const status = classifyIdentity(difference, tolerance);
  const message = formatIdentityLabel({
    assetsCents: BigInt(view.identity.assetsCents),
    debtsCents: BigInt(view.identity.debtsCents),
    delegationsCents: BigInt(view.identity.delegationsCents),
    pendingCents: pending,
    differenceCents: difference,
    toleranceCents: tolerance,
    status,
  });

  const tone: ReadingTone =
    status === 'balanced' ? 'positive' : status === 'to_delegate' ? 'info' : 'danger';

  const working = (
    <>
      Assets {formatCents(BigInt(view.identity.assetsCents))} − Debts{' '}
      {formatCents(BigInt(view.identity.debtsCents))} − Delegations{' '}
      {formatCents(BigInt(view.identity.delegationsCents))}
      {/* Shown only when there is one. A term reading "− Pending $0.00" on the
          ordinary day would be four words of noise. The operator follows the
          sign so the arithmetic can be checked as written — a pending refund
          adds rather than subtracts. */}
      {pending !== 0n && (
        <>
          {' '}
          {pending < 0n ? '−' : '+'} Pending {formatCents(pending < 0n ? -pending : pending)}
        </>
      )}{' '}
      = {formatCents(difference)}
    </>
  );

  return { tone, message, working };
}

/** The dot's fill, by tone. Written out: Tailwind never sees a runtime string. */
const DOTS: Record<ReadingTone, string> = {
  positive: 'bg-positive',
  info: 'bg-accent',
  danger: 'bg-danger-dot',
};

/**
 * A circle of colour, for a phone.
 *
 * It was a tag reading `Balanced` or `To delegate $1,240.00` beside the page
 * title. On a 375px screen that is a third of the header spent on a reading that
 * is glanced at rather than read, and it pushed New… and Delegate onto a line of
 * their own — on the screen this household opens most, whose whole point is the
 * band underneath.
 *
 * So it is the colour and nothing else, beside the alert dot it matches: the two
 * marks in that corner are "where the budget stands" and "what needs attention",
 * and neither is a sentence a phone has room for.
 *
 * **The words are a press away, not a hover away.** A tooltip is a pointer's
 * gesture and a touchscreen has no way to open one, so this is a button and a
 * sheet rather than `AlertTag`. The sheet carries the reading *and* its working,
 * which is more than the tag ever showed without a mouse.
 *
 * **Colour is not the only carrier** (design.md §9): the accessible name is the
 * whole reading, so a screen reader hears "Balanced" where an eye sees green.
 */
export function BalanceReading({ view }: { view: BudgetViewDto }): ReactNode {
  const [open, setOpen] = useState(false);
  const { tone, message, working } = read(view);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={message}
        // 24px of target around a 10px mark, so it is pressable at the size
        // WCAG 2.5.8 asks for without drawing a chip beside the title. A shade
        // larger than the alert dot beside it: this one is always there, and it
        // is the reading the screen exists for.
        className="-m-2 inline-flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-full p-2 hover:bg-surface-2"
      >
        <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${DOTS[tone]}`} />
      </button>

      {open && (
        <Modal
          label={message}
          title={message}
          onClose={() => setOpen(false)}
          /* A reading has nothing to lose to a stray press beside the card. */
          dismissible
        >
          <p className="text-quiet text-ink">{working}</p>
        </Modal>
      )}
    </>
  );
}

/** Which button a tone paints. */
const VARIANTS: Record<ReadingTone, ButtonVariant> = {
  positive: 'positive',
  info: 'info',
  danger: 'danger',
};

/** The rail's mark, where a sentence does not fit. */
const GLYPHS: Record<ReadingTone, string> = {
  positive: '=',
  info: '↓',
  danger: '!',
};

/**
 * The control, at the top of the sidebar's foot.
 *
 * **Always coloured, and it is the only thing in that zone that always is.**
 * Below it sit Delegate, Sync SimpleFIN and Sign out, all plain until hovered or
 * until the bank feed has something to report — so a glance at the corner of the
 * screen answers "where does the budget stand" and nothing else competes for it.
 *
 * **It goes to Overview whatever it says.** Not only when something is wrong:
 * the reading is the thing the household opens the application for, and a
 * control that is a link on the bad days and inert on the good ones is one
 * nobody learns to press. Over-delegated and balanced land in the same place,
 * which is where the lines it is about are.
 *
 * `role="status"` sits on the words *inside* the link rather than on the link
 * itself. The link has to stay a link to a screen reader, and the reading has to
 * stay a live region — it changes on every edit, and that change is the point.
 */
export function BalanceButton({
  view,
  collapsed = false,
}: {
  readonly view: BudgetViewDto;
  /** The sidebar's icon rail, where a sentence does not fit. */
  readonly collapsed?: boolean;
}): ReactNode {
  const workingId = useId();
  const demo = useIsDemo();
  const { tone, message, working } = read(view);

  return (
    <div className="group relative">
      <Link
        to={pathFor('/overview', demo)}
        /*
         * Named explicitly, because `role="status"` below does not support name
         * from content — so the words inside do not reach the link, and without
         * this it announces as an unnamed link. Caught by the end-to-end suite
         * failing to find it by name at all, which is exactly what a screen
         * reader would have found.
         */
        aria-label={message}
        aria-describedby={workingId}
        title={collapsed ? message : undefined}
        className={`${buttonFace(VARIANTS[tone])} w-full`}
      >
        {collapsed ? (
          <>
            <span aria-hidden>{GLYPHS[tone]}</span>
            {/* The rail draws a mark; a screen reader still gets the sentence,
                which is the whole reading rather than a decoration. */}
            <span role="status" className="sr-only">
              {message}
            </span>
          </>
        ) : (
          // `truncate` because the sidebar is as wide as its longest nav label
          // and "Over-delegated $1,240.00" is wider. The whole of it is in the
          // popover below and in the `title` either way.
          <span role="status" className="min-w-0 truncate">
            {message}
          </span>
        )}
      </Link>

      <ControlPopover id={workingId}>
        <span className="text-quiet text-ink">{working}</span>
      </ControlPopover>
    </div>
  );
}
