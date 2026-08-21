import type { Cents } from '@budget/shared';
import { newUuid } from '../db/ids.js';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError } from './errors.js';
import { appendEvent, markEventsReversed } from './ledger.js';

/**
 * Delegate, and its undo.
 *
 * Pressing Delegate distributes each line's `amount_to_delegate_cents` into that
 * line's balance. Lines with a null amount receive nothing — null means "ad hoc,
 * add nothing", which is distinct from an explicit $0 even though both move
 * nothing here.
 *
 * The run's `created_at` defines the start of the current budget cycle. There is
 * no automatic cadence and there is not meant to be: the owner presses this when
 * the money lands. Settings → Budget carries a pay cadence, but it is a divisor
 * for the Utilities page rather than a schedule — nothing here reads it.
 */

export interface DelegatePreview {
  readonly totalCents: Cents;
  readonly lineCount: number;
  readonly lines: ReadonlyArray<{
    readonly delegationId: string;
    readonly name: string;
    readonly amountCents: Cents;
  }>;
}

/** Drives the confirmation dialog. Reads only — nothing is written. */
export async function previewDelegate(db: Db): Promise<DelegatePreview> {
  const lines = await db.delegation.findMany({
    where: { archivedAt: null, amountToDelegateCents: { not: null } },
    select: { id: true, name: true, amountToDelegateCents: true },
    orderBy: { name: 'asc' },
  });

  const previewLines = lines.map((line) => ({
    delegationId: line.id,
    name: line.name,
    // Non-null by the query filter; narrowed here rather than asserted.
    amountCents: line.amountToDelegateCents ?? 0n,
  }));

  return {
    totalCents: previewLines.reduce((sum, line) => sum + line.amountCents, 0n),
    lineCount: previewLines.length,
    lines: previewLines,
  };
}

export interface DelegateRunSummary {
  readonly runId: string;
  readonly batchId: string;
  readonly totalCents: Cents;
  readonly lineCount: number;
}

/**
 * Writes one delegate_run and one `delegate` event per funded line, all sharing a
 * batch id so undo can reverse exactly this press and nothing else.
 *
 * Must be called inside a transaction: a partially applied Delegate would leave
 * the budget in a state the owner cannot reason about.
 */
export async function runDelegate(
  db: Db,
  options: { readonly actorId?: string | null } = {},
): Promise<DelegateRunSummary> {
  const preview = await previewDelegate(db);
  if (preview.lineCount === 0) {
    throw new ConflictError(
      'nothing_to_delegate',
      'No delegation has an amount to delegate, so there is nothing to distribute',
    );
  }

  const batchId = newUuid();
  const run = await db.delegateRun.create({
    data: {
      batchId,
      totalCents: preview.totalCents,
      lineCount: preview.lineCount,
      actorId: options.actorId ?? null,
    },
    select: { id: true },
  });

  for (const line of preview.lines) {
    await appendEvent(db, {
      delegationId: line.delegationId,
      deltaCents: line.amountCents,
      eventType: 'delegate',
      batchId,
      delegateRunId: run.id,
      actorId: options.actorId ?? null,
    });
  }

  return {
    runId: run.id,
    batchId,
    totalCents: preview.totalCents,
    lineCount: preview.lineCount,
  };
}

/** The most recent non-undone run. Its createdAt is the current cycle start. */
export async function currentCycleStart(db: Db): Promise<Date | null> {
  const run = await db.delegateRun.findFirst({
    where: { undoneAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return run?.createdAt ?? null;
}

export interface UndoPreview {
  readonly runId: string;
  readonly totalCents: Cents;
  readonly lineCount: number;
  readonly runAt: Date;
  readonly expiresAt: Date;
  /** Where the cycle boundary lands after undo. Null means no earlier run. */
  readonly cycleStartAfterUndo: Date | null;
}

/**
 * Describes what undoing the latest run would do, including the cycle rollback —
 * surfaced in the confirmation so the boundary move is not a surprise.
 */
export async function previewUndoLatestDelegate(
  db: Db,
  options: { readonly now?: Date } = {},
): Promise<UndoPreview | null> {
  const now = options.now ?? new Date();

  const run = await db.delegateRun.findFirst({
    where: { undoneAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, totalCents: true, lineCount: true, createdAt: true },
  });
  if (!run) return null;

  const settings = await db.budgetSettings.findUnique({
    where: { id: 1 },
    select: { undoWindowHours: true },
  });
  const undoWindowHours = settings?.undoWindowHours ?? 12;
  const expiresAt = new Date(run.createdAt.getTime() + undoWindowHours * 60 * 60 * 1000);

  /*
   * Nothing offered once the window has closed.
   *
   * This used to compute `expiresAt` and hand the preview back regardless, so
   * the interface kept offering an undo that `undoDelegateRun` would refuse
   * with `undo_window_expired`. The money was never at risk — the refusal is
   * real — but a button that cannot do what it says is worse than no button.
   */
  if (now > expiresAt) return null;

  const previous = await db.delegateRun.findFirst({
    where: { undoneAt: null, createdAt: { lt: run.createdAt } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  return {
    runId: run.id,
    totalCents: run.totalCents,
    lineCount: run.lineCount,
    runAt: run.createdAt,
    expiresAt,
    cycleStartAfterUndo: previous?.createdAt ?? null,
  };
}

/**
 * Reverses every event in a run's batch.
 *
 * Work done in the interim — categorizing, transferring, manual adjustment — is
 * untouched, because each of those is its own event with its own batch. That
 * property is the whole reason balances are a ledger rather than a number.
 */
export async function undoDelegateRun(
  db: Db,
  runId: string,
  options: { readonly now?: Date } = {},
): Promise<{ reversedCount: number }> {
  const now = options.now ?? new Date();

  const run = await db.delegateRun.findUnique({
    where: { id: runId },
    select: { id: true, batchId: true, createdAt: true, undoneAt: true },
  });
  if (!run) throw new NotFoundError('DelegateRun', runId);
  if (run.undoneAt !== null) {
    throw new ConflictError('already_undone', 'This Delegate run has already been undone');
  }

  const settings = await db.budgetSettings.findUnique({
    where: { id: 1 },
    select: { undoWindowHours: true },
  });
  const undoWindowHours = settings?.undoWindowHours ?? 12;
  const expiresAt = new Date(run.createdAt.getTime() + undoWindowHours * 60 * 60 * 1000);
  if (now > expiresAt) {
    throw new ConflictError(
      'undo_window_expired',
      `The undo window for this Delegate run closed at ${expiresAt.toISOString()}`,
      { expiresAt: expiresAt.toISOString() },
    );
  }

  const { reversedCount } = await markEventsReversed(
    db,
    { batchId: run.batchId, eventType: 'delegate' },
    now,
  );

  // Marking the run undone is what rolls the cycle boundary back:
  // currentCycleStart only considers runs where undoneAt IS NULL.
  await db.delegateRun.update({ where: { id: run.id }, data: { undoneAt: now } });

  return { reversedCount };
}
