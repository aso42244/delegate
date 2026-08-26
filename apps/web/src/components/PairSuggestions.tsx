import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { transactionsApi } from '../api/transactions.js';
import { Alert, Button } from './ui.jsx';

/**
 * Suggested pairs: the two halves of a credit card or mortgage payment.
 *
 * Neither half is spending, and left unpaired they inflate every spending figure
 * by the amount moved. But these are **suggestions the owner confirms** — §7 is
 * emphatic that wrong automatic pairing is worse than no pairing, because a
 * machine guessing wrong silently erases a real expense.
 *
 * So the panel shows both sides in full, says how many days apart they are, and
 * does nothing until it is told to.
 */
export function PairSuggestions(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const candidates = useQuery({
    queryKey: ['pair-candidates'],
    queryFn: transactionsApi.pairCandidates,
  });

  const pair = useMutation({
    mutationFn: ({ firstId, secondId }: { firstId: string; secondId: string }) =>
      transactionsApi.pair(firstId, secondId),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['pair-candidates'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      // Pairing reverses any categorization, so envelopes moved too.
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not pair those.'),
  });

  const shown = (candidates.data?.candidates ?? []).filter(
    (candidate) => !dismissed.has(candidate.outflow.id),
  );
  if (shown.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-line bg-canvas p-3">
      <header className="mb-2">
        <h2 className="text-base font-semibold text-ink">
          {shown.length} possible {shown.length === 1 ? 'transfer' : 'transfers'} between your
          accounts
        </h2>
        <p className="text-quiet text-muted">
          These look like money moving between accounts you own rather than spending. Confirming a
          pair excludes both from every spending figure. Nothing happens until you say so.
        </p>
      </header>

      {problem && (
        <div className="mb-2">
          <Alert>{problem}</Alert>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((candidate) => (
          <li
            key={candidate.outflow.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0"
          >
            <div className="min-w-64 flex-1 text-quiet">
              <div className="text-ink">
                {candidate.outflow.description}{' '}
                <span className="text-muted">
                  — {candidate.outflow.accountName},{' '}
                  {new Date(candidate.outflow.postedAt).toLocaleDateString()}
                </span>
              </div>
              <div className="text-ink">
                {candidate.inflow.description}{' '}
                <span className="text-muted">
                  — {candidate.inflow.accountName},{' '}
                  {new Date(candidate.inflow.postedAt).toLocaleDateString()}
                </span>
              </div>
            </div>

            <span className="money text-quiet text-ink">
              {formatCents(BigInt(candidate.inflow.amountCents))}
            </span>
            {/* How close the match is, so it can be judged rather than trusted. */}
            <span className="text-quiet text-muted">
              {candidate.daysApart === 0
                ? 'same day'
                : `${candidate.daysApart} day${candidate.daysApart === 1 ? '' : 's'} apart`}
            </span>

            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() =>
                  pair.mutate({ firstId: candidate.outflow.id, secondId: candidate.inflow.id })
                }
                disabled={pair.isPending}
                aria-label={`Pair ${candidate.outflow.description} with ${candidate.inflow.description}`}
              >
                These are a pair
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setDismissed((previous) => new Set(previous).add(candidate.outflow.id))
                }
                aria-label={`Dismiss the suggestion for ${candidate.outflow.description}`}
              >
                Not a pair
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
