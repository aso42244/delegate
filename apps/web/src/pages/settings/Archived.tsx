import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { accountsApi } from '../../api/accounts.js';
import { budgetApi } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { archivedApi, type ArchivedDto } from '../../api/settings.js';
import { Alert, Button } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Archived.
 *
 * Nothing in this system is ever hard-deleted, which is only useful if there is
 * somewhere to find what was archived and bring it back. Archived rows stay
 * resolvable everywhere history references them either way — an eight-month-old
 * transaction still renders "Grocery (archived)" whether or not it is restored.
 *
 * Transactions are not listed. An archived transaction is a vanished pending row
 * or a mistake, there may be thousands, and restoring one individually is not
 * something the owner needs.
 */

function ArchivedList({
  title,
  entries,
  onRestore,
  pending,
}: {
  readonly title: string;
  readonly entries: readonly { id: string; name: string; archivedAt: string | null }[];
  readonly onRestore: (id: string) => void;
  readonly pending: boolean;
}): ReactNode {
  if (entries.length === 0) return null;

  return (
    <div className="mb-4">
      <h3 className="mb-2 text-quiet font-semibold text-ink">{title}</h3>
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-0"
        >
          <span className="text-ink">{entry.name}</span>
          <span className="flex-1 text-quiet text-muted">
            {entry.archivedAt
              ? `Archived ${new Date(entry.archivedAt).toLocaleDateString()}`
              : 'Archived'}
          </span>
          <Button
            onClick={() => onRestore(entry.id)}
            disabled={pending}
            aria-label={`Restore ${entry.name}`}
          >
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ArchivedSection(): ReactNode {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const archived = useQuery({ queryKey: ['archived'], queryFn: archivedApi.list });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['archived'] });
    await queryClient.invalidateQueries({ queryKey: ['budget'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const onError = (error: unknown): void =>
    setProblem(error instanceof ApiError ? error.message : 'Could not restore that.');

  const restoreAccount = useMutation({
    mutationFn: (id: string) => accountsApi.restore(id),
    onSuccess: refresh,
    onError,
  });
  const restoreDelegation = useMutation({
    mutationFn: (id: string) => budgetApi.restoreDelegation(id),
    onSuccess: refresh,
    onError,
  });
  const restoreGrouping = useMutation({
    mutationFn: (id: string) => budgetApi.restoreGrouping(id),
    onSuccess: refresh,
    onError,
  });

  const data: ArchivedDto | undefined = archived.data;
  const isEmpty =
    data !== undefined &&
    data.accounts.length === 0 &&
    data.delegations.length === 0 &&
    data.groupings.length === 0;

  return (
    <SettingsCard
      title="Archived"
      description="Nothing here was deleted. Archived rows still resolve everywhere history refers to them."
    >
      {archived.isLoading ? (
        <p className="text-quiet text-muted">Loading…</p>
      ) : isEmpty ? (
        <p className="text-quiet text-muted">Nothing is archived.</p>
      ) : (
        <>
          {problem && (
            <div className="mb-4">
              <Alert>{problem}</Alert>
            </div>
          )}

          <ArchivedList
            title="Accounts"
            entries={data?.accounts ?? []}
            onRestore={(id) => restoreAccount.mutate(id)}
            pending={restoreAccount.isPending}
          />
          <ArchivedList
            title="Delegations"
            entries={data?.delegations ?? []}
            onRestore={(id) => restoreDelegation.mutate(id)}
            pending={restoreDelegation.isPending}
          />
          <ArchivedList
            title="Groupings"
            entries={data?.groupings ?? []}
            onRestore={(id) => restoreGrouping.mutate(id)}
            pending={restoreGrouping.isPending}
          />
        </>
      )}
    </SettingsCard>
  );
}
