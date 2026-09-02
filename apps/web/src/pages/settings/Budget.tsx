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
import { budgetApi } from '../../api/budget.js';
import { settingsApi } from '../../api/settings.js';
import { StatusLine } from '../../components/layout.jsx';
import { Alert, Button, SelectField, TextField, Toggle } from '../../components/ui.jsx';
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
  /*
   * The same key the Budget page uses, so this is the cache rather than a
   * second request. Only `cycleStartedAt` is read: the cycle is what the undo
   * window and the pay cadence below are both about, which is why the date
   * moved here off the Budget header, where nobody could act on it.
   */
  const view = useQuery({ queryKey: ['budget'], queryFn: budgetApi.view });
  const cycleStartedAt = view.data?.cycleStartedAt ?? null;

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

  /**
   * The household's zone.
   *
   * Saved on change like the cadence, and for the same reason — one choice from
   * a list, nothing to mistype. It invalidates nearly everything: since ADR 037
   * the zone decides which day an instant falls in, so which month a spend lands
   * in and where a chart's window starts both move with it.
   */
  const zoneSave = useMutation({
    mutationFn: (choice: string) =>
      // The empty option is "follow the environment", which is null, not "".
      settingsApi.update({ scheduleTimezone: choice === '' ? null : choice }),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['utilities'] });
      await queryClient.invalidateQueries({ queryKey: ['insights'] });
      await queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (error: unknown) =>
      setProblem(error instanceof ApiError ? error.message : 'Could not save that zone.'),
  });

  /**
   * Whether an overdue bill is announced.
   *
   * Saved on change like the cadence and the zone: one switch, nothing to
   * mistype. It only governs the pill — the Bills page is there either way,
   * because a switch that hid the list as well would make "I turned the noise
   * off" and "there are no bills" impossible to tell apart.
   */
  const alertsSave = useMutation({
    mutationFn: (recurringAlertsEnabled: boolean) => settingsApi.update({ recurringAlertsEnabled }),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
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
      title="How the budget reads"
      description="Tolerance, the undo window, how often money lands, and what gets said."
    >
      <StatusLine tone={cycleStartedAt === null ? 'muted' : 'positive'}>
        {cycleStartedAt === null
          ? 'No Delegate press yet.'
          : `Cycle began ${new Date(cycleStartedAt).toLocaleDateString()}.`}
      </StatusLine>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        {/* Widths by content, not by grid cell: two short numbers and a select.
            They were a three-column grid, which stretched a five-character money
            field to a third of the card. */}
        <div className="flex flex-wrap items-start gap-4">
          <TextField
            label="Balance tolerance"
            width="sm"
            value={toleranceValue}
            onChange={(event) => setTolerance(event.target.value)}
            inputMode="decimal"
            className="money"
          />

          <TextField
            label="Undo window"
            width="sm"
            value={undoValue}
            onChange={(event) => setUndoHours(event.target.value)}
            inputMode="numeric"
            hint="Hours, 1 to 168."
          />

          {/*
            Saved on change rather than behind the Save button beside it: it is
            one choice from four, there is nothing to mistype, and a select
            that silently needs a button pressed elsewhere is how a setting
            gets left half-applied.
          */}
          {/* The hint is the confirmation. This select saves on change, so
              without it nothing on screen says the choice landed. */}
          <SelectField
            label="Paid"
            width="md"
            hint={`${CYCLES_PER_YEAR[cadence]} paychecks a year.`}
            value={cadence}
            onChange={(next) => cadenceSave.mutate(next)}
          >
            {PAY_CADENCES.map((option) => (
              <option key={option} value={option}>
                {PAY_CADENCE_LABELS[option]}
              </option>
            ))}
          </SelectField>

          {/*
            The zone the household keeps.

            The hint names what is actually in force rather than what was
            chosen, because those differ in the case that matters: nobody has
            chosen, and the answer is coming from `SCHEDULE_TIMEZONE`. A page
            that showed only the choice would read blank on precisely the
            deployment whose zone nobody could otherwise discover.
          */}
          <SelectField
            label="Time zone"
            width="lg"
            {...(settings.data
              ? {
                  hint:
                    settings.data.scheduleTimezone === null
                      ? `Following the server: ${settings.data.effectiveTimezone}.`
                      : `Days, months and schedules are read in ${settings.data.effectiveTimezone}.`,
                }
              : {})}
            value={settings.data?.scheduleTimezone ?? ''}
            onChange={(next) => zoneSave.mutate(next)}
          >
            <option value="">
              Follow the server ({settings.data?.environmentTimezone ?? 'UTC'})
            </option>
            {(settings.data?.availableTimezones ?? []).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </SelectField>
        </div>

        <label className="flex items-center gap-2 text-quiet text-ink">
          <Toggle
            checked={settings.data?.recurringAlertsEnabled ?? true}
            onChange={(next) => alertsSave.mutate(next)}
            label="Tell me when a bill is overdue"
          />
          Tell me when a bill is overdue
        </label>

        {/* The derived thresholds, which are otherwise invisible. One line: the
            three sentences that followed restated the two hints above and the
            pay-cadence rule already recorded in the ADR. */}
        {toleranceCents.ok && toleranceCents.value > 0n && (
          <p className="text-quiet text-muted">
            Within ±{formatCents(toleranceCents.value)} reads{' '}
            <strong className="text-ink">Balanced</strong>; over {formatCents(toleranceCents.value)}{' '}
            warns and over {formatCents(toleranceCents.value * 2n)} is danger.
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
