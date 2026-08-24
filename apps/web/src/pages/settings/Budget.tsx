import {
  CYCLES_PER_YEAR,
  PAY_CADENCES,
  PAY_CADENCE_LABELS,
  formatCents,
  formatCentsForInput,
  isPayCadence,
  tryParseMoney,
} from '@budget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { settingsApi } from '../../api/settings.js';
import { Alert, Button, SelectField, TextField } from '../../components/ui.jsx';
import { SettingsCard } from './SettingsCard.jsx';

/**
 * Settings → Budget.
 *
 * Three settings that change how the rest of the application reads, on one
 * screen without scrolling. They were three cards stacked down the page, each
 * with a paragraph or two of explanation, and a fourth reporting a date nothing
 * writes any more.
 *
 * The explanations are not gone — the tolerance one in particular has to stay,
 * because the warning and danger thresholds are derived from it and would
 * otherwise be invisible. They sit under their own field rather than as prose
 * between cards.
 */

export function BudgetSection(): ReactNode {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });

  const [tolerance, setTolerance] = useState<string | null>(null);
  const [undoHours, setUndoHours] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Null means "not edited yet", so the server's value shows until it is.
  const toleranceValue =
    tolerance ??
    (settings.data ? formatCentsForInput(BigInt(settings.data.identityToleranceCents)) : '');
  const undoValue = undoHours ?? (settings.data ? String(settings.data.undoWindowHours) : '');

  const save = useMutation({
    mutationFn: () => {
      const parsedTolerance = tryParseMoney(toleranceValue);
      if (!parsedTolerance.ok) {
        throw new ApiError(400, 'invalid_tolerance', 'Enter a tolerance like 5.00.');
      }
      const parsedHours = Number(undoValue);
      if (!Number.isInteger(parsedHours)) {
        throw new ApiError(400, 'invalid_undo_window', 'Enter the undo window in whole hours.');
      }

      return settingsApi.update({
        identityToleranceCents: parsedTolerance.value.toString(),
        undoWindowHours: parsedHours,
      });
    },
    onSuccess: async () => {
      setProblem(null);
      setSaved(true);
      setTolerance(null);
      setUndoHours(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      // The reading's thresholds come from the tolerance, so the budget view is
      // no longer trustworthy either.
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) => {
      setSaved(false);
      setProblem(error instanceof ApiError ? error.message : 'Could not save these settings.');
    },
  });

  const cadenceSave = useMutation({
    mutationFn: (payCadence: string) => {
      if (!isPayCadence(payCadence)) {
        throw new ApiError(400, 'invalid_cadence', 'That is not a pay cadence.');
      }
      return settingsApi.update({ payCadence });
    },
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      // The Utilities suggestion is this number divided by that one.
      await queryClient.invalidateQueries({ queryKey: ['utilities'] });
      await queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that.'),
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  const toleranceCents = tryParseMoney(toleranceValue);
  const cadence = settings.data?.payCadence ?? 'biweekly';

  return (
    <SettingsCard
      title="Budget"
      description="How the budget reads, how long a Delegate press can be taken back, and how often money lands."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <TextField
              label="Balance tolerance"
              value={toleranceValue}
              onChange={(event) => setTolerance(event.target.value)}
              inputMode="decimal"
              className="money"
              hint="How far from zero still reads as balanced. Default $5.00."
            />
          </div>

          <div>
            <TextField
              label="Undo window (hours)"
              value={undoValue}
              onChange={(event) => setUndoHours(event.target.value)}
              inputMode="numeric"
              hint="How long a Delegate press stays undoable. 1 to 168."
            />
          </div>

          <div>
            {/*
              Saved on change rather than behind the Save button beside it: it is
              one choice from four, there is nothing to mistype, and a select
              that silently needs a button pressed elsewhere is how a setting
              gets left half-applied.
            */}
            <SelectField label="Paid" value={cadence} onChange={(next) => cadenceSave.mutate(next)}>
              {PAY_CADENCES.map((option) => (
                <option key={option} value={option}>
                  {PAY_CADENCE_LABELS[option]}
                </option>
              ))}
            </SelectField>
            <p className="mt-1 text-quiet text-muted">
              {CYCLES_PER_YEAR[cadence]} paychecks a year. Saved as soon as you pick it.
            </p>
          </div>
        </div>

        {/* Said plainly, because the two thresholds are derived rather than
            configured and would otherwise be invisible. */}
        {toleranceCents.ok && toleranceCents.value > 0n && (
          <p className="text-quiet text-muted">
            Within ±{formatCents(toleranceCents.value)} reads{' '}
            <strong className="text-ink">Balanced</strong>. Over-delegated by more than{' '}
            {formatCents(toleranceCents.value)} warns, and by more than{' '}
            {formatCents(toleranceCents.value * 2n)} shows as danger. A positive reading is never a
            warning — it is the money waiting to be delegated. Pay cadence divides the Utilities
            suggestion and schedules nothing: Delegate is still pressed by hand, and no amount to
            delegate is ever rewritten when it changes.
          </p>
        )}

        {problem && <Alert>{problem}</Alert>}
        {saved && <Alert tone="positive">Saved.</Alert>}

        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
