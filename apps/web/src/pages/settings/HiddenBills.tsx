import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { recurringApi } from '../../api/recurring.js';
import { Alert, Button } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Budget → Hidden bills.
 *
 * The merchants somebody has said are not bills. It was a fold at the foot of
 * the Bills page and left it with ADR 061, because Due is a tile beside Cost now
 * and a list of corrections is not what anybody opens that page for. The rule it
 * was written for still holds and is why it moved rather than went: **a
 * correction nobody can find is one nobody can undo**, and the row it hid is
 * invisible by design.
 *
 * **Not Settings → Archived**, which was the first place it was put and the
 * wrong one. "Archived" means something exact here — `archived_at` on a row —
 * and a list of hidden bills under that heading reads as a claim that the
 * charges were archived too. They are not: `bill_overrides` holds one row per
 * merchant carrying a refusal and a name, and it touches no transaction. Every
 * charge stays in the register, still categorized, still searchable, still
 * counted in every figure it was counted in before. The card says so, because
 * that is the question somebody asks standing in front of it.
 *
 * It sits on Budget because this is a correction to what the register
 * *infers* — the same subject as the overdue notification switch in the card
 * above it.
 */
export function HiddenBillsSection(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const bills = useQuery({ queryKey: ['recurring'], queryFn: recurringApi.list });
  const hidden = bills.data?.hidden ?? [];

  /*
   * The same override that hid it, with `hidden` turned off. Whatever else it
   * carries is left alone, so putting a bill back does not throw away the name
   * somebody gave it.
   */
  const putBack = useMutation({
    mutationFn: (entry: { key: string; label: string }) =>
      recurringApi.override({ key: entry.key, label: entry.label, hidden: false }),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['recurring'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'That could not be put back.'),
  });

  return (
    <SettingsCard
      span="third"
      title="Hidden bills"
      // The sentence that stops somebody reading this list as a pile of
      // archived transactions. It is the second half that earns its place.
      description="Merchants told they are not a bill. Their charges stay in the register."
    >
      {problem && (
        <div className="mb-4">
          <Alert>{problem}</Alert>
        </div>
      )}

      {bills.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : hidden.length === 0 ? (
        <p className="text-quiet text-muted">Nothing is hidden.</p>
      ) : (
        <ul className="list-none p-0">
          {hidden.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate text-ink" title={entry.label}>
                {entry.label}
              </span>
              {/* "Put back", not "Restore": nothing was archived, and this is
                  the word the control has carried since bill overrides
                  shipped. */}
              <Button
                onClick={() => putBack.mutate(entry)}
                disabled={putBack.isPending}
                aria-label={`Put back ${entry.label}`}
              >
                Put back
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
