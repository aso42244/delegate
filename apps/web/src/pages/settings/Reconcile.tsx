import { formatCents, tryParseMoney } from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { budgetApi, type BudgetRowDto } from '../../api/budget.js';
import { ApiError } from '../../api/client.js';
import { settingsApi, type ReconcileResultDto } from '../../api/settings.js';
import { Alert, Button } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Reconcile to Actual — the go-live screen.
 *
 * At go-live the owner has backfilled and categorized twelve months of history,
 * which drives balances deeply negative: Grocery may read −$9,000 when it truly
 * holds $725. That is deliberate, and it buys full history and accurate day-one
 * numbers. This screen is how those sixty lines are corrected — one screen and
 * one commit, sharing a batch, not sixty modals and not sixty writes that could
 * half-apply.
 *
 * The rule that governs everything here: **a blank line is left alone.** Sixty
 * rows means most will be blank on any given pass, and reading a blank as zero
 * would silently empty every envelope the owner had not got to yet.
 */

interface Line {
  readonly row: BudgetRowDto;
  readonly actualText: string;
}

/** Parses a typed actual. Null when the cell is blank or not a number. */
function parseActual(text: string): bigint | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = tryParseMoney(trimmed);
  return parsed.ok ? parsed.value : null;
}

export function ReconcileSection(): ReactNode {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });

  const [actuals, setActuals] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ReconcileResultDto | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const rows: readonly BudgetRowDto[] = view.data
    ? [
        ...view.data.delegations.groupings.flatMap((grouping) => grouping.rows),
        ...view.data.delegations.ungrouped,
      ]
    : [];

  const lines: Line[] = rows.map((row) => ({ row, actualText: actuals[row.id] ?? '' }));

  const changes = lines.flatMap((line) => {
    const actual = parseActual(line.actualText);
    if (actual === null) return [];
    const delta = actual - BigInt(line.row.balanceCents);
    // A line already reading its actual is not a change; the server would write
    // no event for it either.
    if (delta === 0n) return [];
    return [{ delegationId: line.row.id, actualBalanceCents: actual.toString(), delta }];
  });

  const invalidCount = lines.filter(
    (line) => line.actualText.trim() !== '' && parseActual(line.actualText) === null,
  ).length;

  const totalMovement = changes.reduce<bigint>((sum, change) => sum + change.delta, 0n);

  const commit = useMutation({
    mutationFn: () =>
      settingsApi.reconcile(
        changes.map((change) => ({
          delegationId: change.delegationId,
          actualBalanceCents: change.actualBalanceCents,
        })),
      ),
    onSuccess: async (committed) => {
      setResult(committed);
      setProblem(null);
      setActuals({});
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      setResult(null);
      setProblem(
        error instanceof ApiError ? error.message : 'Could not commit the reconciliation.',
      );
    },
  });

  /** Enter moves down the column: sixty lines is a typing session, not a form. */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    inputRefs.current[index + 1]?.focus();
    inputRefs.current[index + 1]?.select();
  }

  if (view.isLoading) return <p className="text-quiet text-muted">Loading the delegations…</p>;

  return (
    <SettingsCard
      title="Reconcile to Actual"
      description="Set every delegation to what it really holds. One commit corrects them all."
    >
      <div className="mb-4 flex flex-col gap-2">
        <p className="text-quiet text-muted">
          Categorizing a backfilled year drives these balances far negative — that is expected, and
          it is what buys accurate history. Enter what each envelope actually holds and commit once.
        </p>
        {/* The single most important behaviour on this screen, said before the
            table rather than discovered after committing. */}
        <p className="text-quiet text-muted">
          <strong className="text-ink">A line left blank is not touched.</strong> Only the lines you
          fill in are corrected, so this can be done in several sittings.
        </p>
        {settings.data?.goLiveAt === null && (
          <p className="text-quiet text-muted">
            This first commit will also be recorded as your go-live date.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-quiet text-muted">There are no delegations to reconcile yet.</p>
      ) : (
        <>
          <table className="w-full border-t-2 border-ink">
            <thead>
              <tr className="text-label uppercase tracking-[0.05em] text-muted">
                <th className="py-2 text-left font-normal">Delegation</th>
                <th className="py-2 pr-3 text-right font-normal">Computed</th>
                <th className="py-2 pr-3 text-right font-normal">Actual</th>
                <th className="py-2 text-right font-normal">Change</th>
              </tr>
            </thead>

            <tbody>
              {lines.map((line, index) => {
                const computed = BigInt(line.row.balanceCents);
                const actual = parseActual(line.actualText);
                const invalid = line.actualText.trim() !== '' && actual === null;
                const delta = actual === null ? null : actual - computed;

                return (
                  <tr key={line.row.id} className="border-b border-line">
                    <td className="py-2 pr-3 text-ink">{line.row.name}</td>

                    <td
                      className={`money py-2 pr-3 ${computed < 0n ? 'text-negative font-semibold' : 'text-ink'}`}
                    >
                      {formatCents(computed)}
                    </td>

                    <td className="w-36 py-2 pr-3">
                      <input
                        ref={(element) => {
                          inputRefs.current[index] = element;
                        }}
                        value={line.actualText}
                        onChange={(event) =>
                          setActuals((previous) => ({
                            ...previous,
                            [line.row.id]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => onKeyDown(event, index)}
                        aria-label={`Actual balance for ${line.row.name}`}
                        aria-invalid={invalid}
                        inputMode="decimal"
                        placeholder="—"
                        className={`money w-full rounded border bg-canvas px-2 py-1 ${
                          invalid ? 'border-danger-dot' : 'border-line'
                        }`}
                      />
                    </td>

                    <td className="money py-2 text-quiet text-muted">
                      {delta === null || delta === 0n
                        ? '—'
                        : formatCents(delta, { explicitPlus: true })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="mt-4 flex flex-col gap-3">
            {invalidCount > 0 && (
              <Alert>
                {invalidCount} {invalidCount === 1 ? 'line is' : 'lines are'} not a valid amount.
                Fix {invalidCount === 1 ? 'it' : 'them'} or clear the cell.
              </Alert>
            )}
            {problem && <Alert>{problem}</Alert>}
            {result && (
              <Alert tone="positive">
                {result.adjustedCount} {result.adjustedCount === 1 ? 'line' : 'lines'} corrected in
                one commit, moving{' '}
                {formatCents(BigInt(result.totalDeltaCents), { explicitPlus: true })} in total.
              </Alert>
            )}

            <div className="flex items-center justify-between">
              <p className="text-quiet text-muted" role="status">
                {changes.length === 0
                  ? 'Nothing to commit yet.'
                  : `${changes.length} ${changes.length === 1 ? 'line' : 'lines'} will change, moving ${formatCents(totalMovement, { explicitPlus: true })} in total.`}
              </p>

              <Button
                variant="primary"
                onClick={() => commit.mutate()}
                disabled={changes.length === 0 || invalidCount > 0 || commit.isPending}
              >
                {commit.isPending ? 'Committing…' : 'Commit corrections'}
              </Button>
            </div>
          </div>
        </>
      )}
    </SettingsCard>
  );
}
