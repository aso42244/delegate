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
 * Settings that change how the rest of the application reads. The tolerance is
 * not cosmetic: the Budget page's warning and danger thresholds are derived
 * from it, so widening it moves the point at which over-delegation is called
 * out at all.
 *
 * Pay cadence is its own card rather than a third field in that form, because
 * it is a different kind of thing — a fact about the household rather than a
 * threshold — and because the sentence explaining what it does not do needs
 * room.
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
      // The banner's thresholds come from the tolerance, so the budget view is
      // no longer trustworthy either.
      await queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
    onError: (error: unknown) => {
      setSaved(false);
      setProblem(error instanceof ApiError ? error.message : 'Could not save these settings.');
    },
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    save.mutate();
  }

  const toleranceCents = tryParseMoney(toleranceValue);

  return (
    <>
      <SettingsCard
        title="Balance tolerance"
        description="How far the budget may drift from zero before it stops reading as balanced."
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <TextField
            label="Tolerance"
            value={toleranceValue}
            onChange={(event) => setTolerance(event.target.value)}
            inputMode="decimal"
            className="money"
            hint="A positive amount. The default is $5.00."
          />

          {/* Said plainly, because the two thresholds are derived rather than
              configured and would otherwise be invisible. */}
          {toleranceCents.ok && toleranceCents.value > 0n && (
            <p className="text-quiet text-muted">
              Within ±{formatCents(toleranceCents.value)} reads{' '}
              <strong className="text-ink">Balanced</strong>. Over-delegated by more than{' '}
              {formatCents(toleranceCents.value)} warns, and by more than{' '}
              {formatCents(toleranceCents.value * 2n)} shows as danger. A positive reading is never
              a warning — it is the money waiting to be delegated.
            </p>
          )}

          <TextField
            label="Undo window (hours)"
            value={undoValue}
            onChange={(event) => setUndoHours(event.target.value)}
            inputMode="numeric"
            hint="How long a Delegate press stays undoable. Between 1 and 168 hours."
          />

          {problem && <Alert>{problem}</Alert>}
          {saved && <Alert tone="positive">Saved.</Alert>}

          <div>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </SettingsCard>

      <PayCadenceCard />

      <SettingsCard
        title="Go-live"
        description="The date the first Reconcile commit was made, separating backfilled history from live activity."
      >
        <p className="text-quiet text-muted">
          {settings.data?.goLiveAt
            ? `Go-live was ${new Date(settings.data.goLiveAt).toLocaleDateString()}.`
            : 'Not yet. It is stamped automatically when you first commit Reconcile to Actual.'}
        </p>
      </SettingsCard>
    </>
  );
}

/**
 * How often the household is paid.
 *
 * Saved on change rather than behind a Save button: it is one choice from four,
 * there is nothing to mistype, and a select that silently needs a button
 * pressed somewhere else is how a setting gets left half-applied.
 *
 * The copy is careful about two things it does *not* do. It does not schedule
 * anything — Delegate is still pressed by hand when the money lands. And it
 * does not touch the amount to delegate on any line: those are per press, so
 * changing cadence changes what they add up to over a year, and that is the
 * household's business rather than something to quietly rewrite.
 */
function PayCadenceCard(): ReactNode {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
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
    onError: (error: unknown) => setProblem(messageOf(error)),
  });

  const cadence = settings.data?.payCadence ?? 'biweekly';

  return (
    <SettingsCard
      title="Pay cadence"
      description="How often money lands, which is what a cycle means here."
    >
      <div className="flex max-w-sm flex-col gap-3">
        <SelectField label="Paid" value={cadence} onChange={(next) => save.mutate(next)}>
          {PAY_CADENCES.map((option) => (
            <option key={option} value={option}>
              {PAY_CADENCE_LABELS[option]}
            </option>
          ))}
        </SelectField>

        <p className="text-quiet text-muted">
          The Utilities page spreads a monthly average over {CYCLES_PER_YEAR[cadence]} paychecks a
          year to suggest what to delegate to each one.
        </p>

        <p className="text-quiet text-muted">
          Nothing here runs on a schedule — Delegate is still pressed by hand when the money lands,
          and a cycle is still one press to the next. The amount to delegate on each line is added
          once per press whatever this is set to, so changing it changes what those amounts come to
          over a year. They are left exactly as they are.
        </p>

        {problem && <Alert>{problem}</Alert>}
      </div>
    </SettingsCard>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Could not save that.';
}
