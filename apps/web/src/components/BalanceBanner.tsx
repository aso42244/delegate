import { formatCents } from '@budget/shared';
import type { ReactNode } from 'react';
import type { BudgetViewDto } from '../api/budget.js';

/**
 * The bottom-line reading, at the top of the page.
 *
 * Four states, and the thresholds come from the configured tolerance rather than
 * fixed numbers, because the tolerance is a Settings value.
 *
 * A **positive** reading is informational, not a warning. It is the ordinary
 * state on payday — money has landed and has not been distributed yet — and that
 * figure *is* the amount available to delegate. Colouring the most common
 * healthy state as a fault would train the owner to ignore the one banner that
 * has to be read. Yellow and red are for over-delegation, the direction that is
 * genuinely wrong. See docs/design.md, decision 3.
 */

type Tone = 'info' | 'positive' | 'warning' | 'danger';

const TONES: Record<Tone, { box: string }> = {
  info: { box: 'border-accent bg-accent-soft text-accent' },
  positive: { box: 'border-positive bg-positive-soft text-positive' },
  warning: { box: 'border-warning-line bg-warning-soft text-warning' },
  danger: { box: 'border-danger-line bg-danger-soft text-danger' },
};

export function BalanceBanner({ view }: { view: BudgetViewDto }): ReactNode {
  const difference = BigInt(view.identity.differenceCents);
  const tolerance = BigInt(view.identity.toleranceCents);
  const magnitude = difference < 0n ? -difference : difference;

  let tone: Tone;
  let message: string;

  if (difference > 0n && magnitude >= tolerance) {
    tone = 'info';
    message = `${formatCents(difference)} to delegate`;
  } else if (magnitude <= tolerance) {
    tone = 'positive';
    message = 'Balanced';
  } else if (magnitude <= tolerance * 2n) {
    tone = 'warning';
    message = `${formatCents(magnitude)} over-delegated`;
  } else {
    tone = 'danger';
    message = `${formatCents(magnitude)} over-delegated`;
  }

  const { box } = TONES[tone];

  return (
    // role="status" rather than "alert": this is a standing reading of the
    // budget, not an interruption, and it changes on every edit.
    <div
      role="status"
      className={`mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border px-4 py-3 ${box}`}
    >
      {/* The state is carried by the words as well as the colour, and the
          equation is spelled out so the number can be checked rather than
          trusted. The two are the reading and its working, so they sit at
          opposite ends rather than running together. */}
      <p className="text-base font-semibold">{message}</p>
      <p className="text-base opacity-80">
        Assets {formatCents(BigInt(view.identity.assetsCents))} − Debts{' '}
        {formatCents(BigInt(view.identity.debtsCents))} − Delegations{' '}
        {formatCents(BigInt(view.identity.delegationsCents))} = {formatCents(difference)}
      </p>
    </div>
  );
}
