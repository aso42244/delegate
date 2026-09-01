import { classifyIdentity, formatCents, formatIdentityLabel } from '@budget/shared';
import { useId, type ReactNode } from 'react';
import type { BudgetViewDto } from '../api/budget.js';

/**
 * The bottom-line reading, beside the page title.
 *
 * It was a full-width bar carrying the state on the left and the equation on the
 * right. The equation is the reason to trust the number, but it is not something
 * anybody reads twice a day, and a bar's worth of page for it pushed the budget
 * itself down the screen. So the state stays visible and the working is one
 * hover away.
 *
 * Four states, with thresholds from the configured tolerance rather than fixed
 * numbers, because the tolerance is a Settings value.
 *
 * A **positive** reading is informational, not a warning. It is the ordinary
 * state on payday — money has landed and has not been distributed yet — and that
 * figure *is* the amount available to delegate. Colouring the most common
 * healthy state as a fault would train the owner to ignore the one reading that
 * has to be read. Yellow and red are for over-delegation, the direction that is
 * genuinely wrong. See docs/design.md, decision 3.
 *
 * Not a button, because there is nothing to press: it reports, it does not act.
 * It still takes focus, though. The working has to be reachable without a mouse,
 * and `tabIndex` plus `aria-describedby` is what gets it to a keyboard and to a
 * screen reader — a description referenced this way is read even while the
 * element holding it is hidden.
 */

type Tone = 'info' | 'positive' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  info: 'border-accent bg-accent-soft text-accent',
  positive: 'border-positive bg-positive-soft text-positive',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
};

export function BalanceReading({ view }: { view: BudgetViewDto }): ReactNode {
  const workingId = useId();

  const difference = BigInt(view.identity.differenceCents);
  const tolerance = BigInt(view.identity.toleranceCents);
  // Signed: negative for a pending spend, which is the ordinary case.
  const pending = BigInt(view.identity.pendingCents);
  const magnitude = difference < 0n ? -difference : difference;

  /*
   * The wording comes from `formatIdentityLabel`; only the tone is decided here.
   *
   * `classifyIdentity` knows three states and this needs four — over-delegation
   * past twice the tolerance is red rather than yellow — but that split is a
   * matter of how loudly to say the same thing, not of what to say. Keeping it
   * here leaves one copy of the words.
   */
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

  const tone: Tone =
    status === 'balanced'
      ? 'positive'
      : status === 'to_delegate'
        ? 'info'
        : magnitude <= tolerance * 2n
          ? 'warning'
          : 'danger';

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

  return (
    <div className="group relative shrink-0">
      {/*
        role="status" rather than "alert": a standing reading of the budget, not
        an interruption, and it changes on every edit. The working sits outside
        it deliberately — inside, revealing the tooltip would re-announce the
        whole live region on every hover.
      */}
      <span
        role="status"
        tabIndex={0}
        aria-describedby={workingId}
        className={`inline-flex min-h-[28px] cursor-default items-center rounded-lg border px-3 text-quiet font-semibold ${TONES[tone]}`}
      >
        {message}
      </span>

      <span
        id={workingId}
        role="tooltip"
        // `w-max` keeps the equation on one line wherever there is room for it,
        // and the cap makes it wrap rather than run off a phone.
        className="pointer-events-none absolute top-full left-0 z-20 mt-1 hidden w-max max-w-[calc(100vw-3rem)] rounded-lg border border-line bg-canvas px-3 py-2 text-quiet text-ink shadow-lg group-hover:block group-focus-within:block"
      >
        {working}
      </span>
    </div>
  );
}
