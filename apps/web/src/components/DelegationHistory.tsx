import { formatCents } from '@budget/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { budgetApi, type DelegationEventType } from '../api/budget.js';
import { Modal } from './ui.jsx';

/**
 * The per-line event history.
 *
 * This is the only route to it. Manual adjustments deliberately never appear on
 * the Transactions page — that journal exists for categorization, not auditing —
 * so without this screen an adjustment would be invisible after the fact, and
 * "why does this line read what it reads" would have no answer.
 */

const EVENT_LABELS: Record<DelegationEventType, string> = {
  delegate: 'Delegated',
  categorize: 'Transaction',
  transfer: 'Transfer',
  adjust: 'Manual adjustment',
};

export function DelegationHistory({
  delegationId,
  delegationName,
  onClose,
}: {
  readonly delegationId: string;
  readonly delegationName: string;
  readonly onClose: () => void;
}): ReactNode {
  const history = useQuery({
    queryKey: ['delegation-history', delegationId],
    queryFn: () => budgetApi.delegationHistory(delegationId),
  });

  const events = history.data?.events ?? [];

  return (
    <Modal
      label={`History for ${delegationName}`}
      title={`History — ${delegationName}`}
      description="Everything that has moved this line, newest first. Reversed entries are kept rather than removed."
      onClose={onClose}
      width="lg"
    >
      {history.isLoading ? (
        <p className="text-quiet text-muted">Loading history…</p>
      ) : events.length === 0 ? (
        <p className="text-quiet text-muted">Nothing has moved this line yet.</p>
      ) : (
        <table className="w-full border-t-2 border-ink">
          <thead>
            <tr className="text-label uppercase tracking-label text-muted">
              <th className="py-2 text-left font-normal">When</th>
              <th className="py-2 text-left font-normal">What</th>
              <th className="py-2 text-left font-normal">Who</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const delta = BigInt(event.deltaCents);
              const reversed = event.reversedAt !== null;

              return (
                <tr key={event.id} className="border-b border-line">
                  <td className="py-2 pr-3 text-quiet whitespace-nowrap text-muted">
                    {new Date(event.occurredAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-3 text-quiet text-ink">
                    {EVENT_LABELS[event.eventType]}
                    {/* Said in words, not only by the strike-through: a reversal
                        is the difference between a balance that makes sense and
                        one that does not. */}
                    {reversed && <span className="ml-2 text-muted">(reversed)</span>}
                  </td>
                  <td className="py-2 pr-3 text-quiet text-muted">
                    {event.actor?.username ?? '—'}
                  </td>
                  <td
                    className={`money py-2 text-quiet ${
                      reversed
                        ? 'text-faint line-through'
                        : delta < 0n
                          ? 'text-negative'
                          : 'text-ink'
                    }`}
                  >
                    {formatCents(delta, { explicitPlus: true })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
