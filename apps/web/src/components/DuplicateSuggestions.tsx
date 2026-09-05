import { formatCents } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { transactionsApi } from '../api/transactions.js';
import { Alert, Button } from './ui.jsx';
import { duplicateActionAriaLabel, duplicateActionLabels } from './duplicate-actions.js';

/**
 * The same charge, in the register twice.
 *
 * Reconnecting an institution at the bridge changes every account's external id,
 * so a sync brings back a card's whole recent history as though it were new.
 * Archiving one has been possible from the row menu for months — but only a
 * duplicate somebody had already spotted, which in practice meant noticing a
 * balance was wrong and working backwards.
 *
 * **Proposed, never applied**, like the pairs above it and a cleared check.
 * Archiving reverses whatever the row moved, and a machine picking wrongly
 * between two identical rows is not a thing to find out about later.
 *
 * Both rows are shown in full, and the one carrying a categorization is marked:
 * archiving that one puts money back in an envelope, and archiving the other
 * does not. That is the fact a reader needs before pressing anything.
 *
 * **"Not a duplicate" is remembered**, and that is a correction to how this
 * shipped. It dismissed for a session only, on the reasoning that a refusal is
 * not a fact worth storing — which is right for a cleared check, whose proposal
 * expires by itself once the check clears. Two settled transactions never
 * change, so the same wrong pair came back on every page load, for ever. The
 * first real run produced exactly that, on two different payees that happened to
 * cost the same. See
 * [ADR 049](../../../../docs/decisions/049-a-duplicate-is-proposed-never-archived.md).
 *
 * **No header pill.** One was tried and taken out: computed on the server, it
 * kept saying "1 possible duplicate" after the panel had been waved off. Nothing
 * is lost — a re-import arrives as uncategorized rows, so the backlog pill
 * already leads here, which is where these are dealt with.
 */
export function DuplicateSuggestions(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ['duplicates'],
    queryFn: transactionsApi.duplicates,
  });

  const archive = useMutation({
    mutationFn: (id: string) => transactionsApi.archive(id),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
      // Archiving reverses any envelope movement the row caused.
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That row could not be archived.'),
  });

  const dismiss = useMutation({
    mutationFn: (candidate: { readonly firstId: string; readonly secondId: string }) =>
      transactionsApi.dismissDuplicate(candidate.firstId, candidate.secondId),
    onSuccess: async () => {
      setProblem(null);
      // Read back rather than filtered here: the server is what decides what is
      // proposed, and one place deciding is what stopped the pill disagreeing
      // with the panel.
      await queryClient.invalidateQueries({ queryKey: ['duplicates'] });
    },
    onError: (error: unknown) =>
      setProblem(
        error instanceof ApiError ? error.message : 'That suggestion could not be dismissed.',
      ),
  });

  const shown = candidates.data?.candidates ?? [];
  if (shown.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-line bg-canvas p-3">
      <header className="mb-2">
        <h2 className="text-base font-semibold text-ink">
          {shown.length} possible {shown.length === 1 ? 'duplicate' : 'duplicates'}
        </h2>
        <p className="text-quiet text-muted">
          Two rows for what looks like one charge. Archiving one takes it out of the register and
          puts back anything it moved. Nothing happens until you say so.
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
            key={candidate.copy.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0"
          >
            <div className="min-w-64 flex-1 text-quiet">
              {[candidate.original, candidate.copy].map((side, index) => (
                <div key={side.id} className="text-ink">
                  {side.description}{' '}
                  <span className="text-muted">
                    — {side.accountName}, {new Date(side.postedAt).toLocaleDateString()}
                    {/* On a standby pair "first" is meaningless — the two are
                        the same charge from two sources, not one before the
                        other — so it names the source instead. */}
                    {candidate.reason === 'standby'
                      ? index === 0
                        ? ' · from the bank'
                        : ' · entered by hand'
                      : index === 0
                        ? ' · first'
                        : ''}
                  </span>
                  {/* The one carrying a decision. Archiving it moves money back;
                      archiving the other one does not. */}
                  {side.categorized && <span className="ml-2 text-muted">categorized</span>}
                </div>
              ))}
            </div>

            <span className="money text-quiet text-ink">
              {formatCents(BigInt(candidate.copy.amountCents))}
            </span>

            {/* How close the match is, so it can be judged rather than trusted. */}
            <span className="text-quiet text-muted">
              {candidate.daysApart === 0
                ? 'same day'
                : `${candidate.daysApart} day${candidate.daysApart === 1 ? '' : 's'} apart`}
              {candidate.differentExternalIds && ' · re-imported'}
              {candidate.reason === 'standby' && ' · the feed caught up'}
            </span>

            <div className="flex gap-2">
              {/*
                Each rule names its own sides, because "first" and "later" are
                only meaningful for one of them.
                
                A re-import is two rows the bank sent, arriving months apart, and
                which of them is the copy is a judgement about time — so the
                later one is offered by default, and the earlier one is offered
                too, because the copy carrying the categorization is sometimes
                the one worth keeping.
                
                A standby pair is one charge from two sources on the same day.
                Ordering them by date says nothing, and the row text above
                already calls them what they are. Labelling the buttons "later"
                and "first" described a rule this pair is not decided by — the
                press did the right thing under a name for something else, which
                is the sort of thing that reads as correct until somebody
                depends on it.
              */}
              <Button
                variant="primary"
                onClick={() => archive.mutate(candidate.copy.id)}
                disabled={archive.isPending}
                aria-label={duplicateActionAriaLabel(
                  candidate.reason,
                  'copy',
                  candidate.copy.description,
                )}
              >
                {duplicateActionLabels(candidate.reason).archiveCopy}
              </Button>
              <Button
                onClick={() => archive.mutate(candidate.original.id)}
                disabled={archive.isPending}
                aria-label={duplicateActionAriaLabel(
                  candidate.reason,
                  'original',
                  candidate.original.description,
                )}
              >
                {duplicateActionLabels(candidate.reason).archiveOriginal}
              </Button>
              {/*
                Remembered, not waved off. Recorded against the pair, so both
                rows stay eligible to be proposed against anything else — which
                matters when a charge really was imported three times and only
                one of the pairings is wrong.
              */}
              <Button
                variant="ghost"
                onClick={() =>
                  dismiss.mutate({
                    firstId: candidate.original.id,
                    secondId: candidate.copy.id,
                  })
                }
                disabled={dismiss.isPending}
                aria-label={`Dismiss the duplicate suggestion for ${candidate.copy.description}`}
              >
                Not a duplicate
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
