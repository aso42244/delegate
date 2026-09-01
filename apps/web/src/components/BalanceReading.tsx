import { classifyIdentity, formatCents, formatIdentityLabel } from '@budget/shared';
import { useId, type ReactNode } from 'react';
import type { BudgetViewDto } from '../api/budget.js';
import { HeaderPill, type PillTone } from './HeaderPill.jsx';

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
 * The pill itself is `HeaderPill`, shared with the notifications that sit
 * beside it. This file decides what the reading says and how alarmed to be; it
 * does not decide what a pill looks like, because there is now more than one.
 */

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

  const tone: PillTone =
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

  return <HeaderPill tone={tone} label={message} detail={working} detailId={workingId} />;
}
