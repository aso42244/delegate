import type { AccountType } from '@prisma/client';
import type { Db } from '../db/client.js';
import type { FeedAccount, FeedTransaction } from '../simplefin/protocol.js';
import type { SimpleFinClient } from '../simplefin/client.js';
import { fetchAccountsInWindows } from '../simplefin/backfill.js';
import { ConflictError } from './errors.js';
import { matchClearedChecks } from './checks.js';
import { applyRules } from './rules.js';
import { markEventsReversed } from './ledger.js';
import {
  carryPendingCategorizationToPosted,
  findPostedMatchesForPending,
  reversePendingTransaction,
} from './pending.js';

/**
 * A SimpleFIN sync run.
 *
 * Two properties matter more than anything else here:
 *
 *   * **Idempotent.** Re-running must never duplicate a transaction. Every row
 *     is keyed on SimpleFIN's transaction id plus the account, which is a unique
 *     index, so a repeated run updates in place.
 *   * **Exact on pending.** A pending transaction already moved the owner's
 *     envelopes. When it settles the spend must stay counted exactly once, and
 *     when it evaporates it must be backed out completely. Both are delegated to
 *     `pending.ts`, which owns that lifecycle.
 */

/** Overlap re-requested on every incremental sync. */
const INCREMENTAL_OVERLAP_DAYS = 7;

/** A run still `running` after this long is assumed dead — the process was killed mid-sync. */
const STALE_RUN_MINUTES = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Just enough of pino for the domain to log without depending on the HTTP layer. */
export interface SyncLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

const SILENT_LOGGER: SyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface RunSyncOptions {
  readonly client: SimpleFinClient;
  readonly backfillMonths?: number;
  readonly now?: Date;
  readonly logger?: SyncLogger;
  /** Attributed on any delegation event this run causes, e.g. reversing a vanished pending row. */
  readonly actorId?: string | null;
}

export interface SyncRunSummary {
  readonly syncRunId: string;
  readonly status: 'succeeded' | 'failed';
  readonly accountsTouched: number;
  readonly accountsDiscovered: number;
  readonly transactionsAdded: number;
  readonly transactionsUpdated: number;
  readonly transactionsReversed: number;
  /** How many of the newly imported rows a rule categorized automatically. */
  readonly transactionsCategorized: number;
  readonly errors: readonly string[];
}

/**
 * Guesses whether a discovered account is an asset or a debt.
 *
 * SimpleFIN carries no account type, so this reads the name first and the sign
 * of the balance second. It is a guess by construction, which is why every
 * discovered account is flagged `needsReview` for the owner to confirm.
 */
export function guessAccountType(name: string, balanceCents: bigint): AccountType {
  if (
    /\b(credit|card|visa|mastercard|amex|discover|loan|mortgage|heloc|line of credit)\b/i.test(name)
  ) {
    return 'debt';
  }
  return balanceCents < 0n ? 'debt' : 'asset';
}

/**
 * Debt balances are stored as positive magnitudes so the identity can subtract
 * them; asset balances keep their sign, because an overdrawn current account is
 * genuinely negative.
 */
function storedBalance(type: AccountType, feedBalanceCents: bigint): bigint {
  return type === 'debt'
    ? feedBalanceCents < 0n
      ? -feedBalanceCents
      : feedBalanceCents
    : feedBalanceCents;
}

function subtractMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() - months);
  return result;
}

/**
 * Refuses to start when another run is already in flight.
 *
 * The hourly job and the manual sync button can otherwise overlap, and two runs
 * reconciling pending transactions at once would each see the other's
 * half-finished work. A `running` row older than the stale threshold is treated
 * as a dead process and failed, so a killed container cannot block sync forever.
 */
async function claimRunSlot(db: Db, now: Date, correlationId: string): Promise<string> {
  const staleBefore = new Date(now.getTime() - STALE_RUN_MINUTES * 60 * 1000);

  await db.syncRun.updateMany({
    where: { status: 'running', startedAt: { lt: staleBefore } },
    data: {
      status: 'failed',
      finishedAt: now,
      error: `Abandoned: still running after ${STALE_RUN_MINUTES} minutes, so the process was presumed killed.`,
    },
  });

  if (await db.syncRun.findFirst({ where: { status: 'running' }, select: { id: true } })) {
    throw new ConflictError('sync_already_running', 'A sync is already in progress.');
  }

  const run = await db.syncRun.create({
    data: { status: 'running', startedAt: now, correlationId },
    select: { id: true },
  });
  return run.id;
}

export async function runSync(db: Db, options: RunSyncOptions): Promise<SyncRunSummary> {
  const now = options.now ?? new Date();
  const logger = options.logger ?? SILENT_LOGGER;
  const backfillMonths = options.backfillMonths ?? 12;
  const correlationId = `sync-${now.getTime().toString(36)}`;

  const syncRunId = await claimRunSlot(db, now, correlationId);

  // First run backfills; later runs re-request a short overlap so a transaction
  // that posts late, or a pending row that changes, is still inside the window.
  const lastSuccess = await db.syncRun.findFirst({
    where: { status: 'succeeded', id: { not: syncRunId } },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  const incrementalStart = lastSuccess
    ? new Date(lastSuccess.startedAt.getTime() - INCREMENTAL_OVERLAP_DAYS * MS_PER_DAY)
    : subtractMonths(now, backfillMonths);

  // The window must reach back far enough to cover every pending row we still
  // hold. Absence from the feed is how we detect that a pending transaction
  // vanished, and that inference is only valid if we actually asked about it —
  // a hold older than the overlap (hotel and rental deposits routinely run 7–10
  // days) would otherwise never be reconciled at all.
  const oldestPending = await db.transaction.findFirst({
    where: { pending: true, archivedAt: null, source: 'simplefin' },
    orderBy: { postedAt: 'asc' },
    select: { postedAt: true },
  });
  const pendingStart = oldestPending
    ? new Date(oldestPending.postedAt.getTime() - MS_PER_DAY)
    : undefined;

  const startDate =
    pendingStart && pendingStart < incrementalStart ? pendingStart : incrementalStart;

  logger.info(
    { correlationId, syncRunId, startDate, backfill: lastSuccess === null },
    'sync started',
  );

  const errors: string[] = [];
  let accountsTouched = 0;
  let accountsDiscovered = 0;
  let transactionsAdded = 0;
  let transactionsUpdated = 0;
  let transactionsReversed = 0;
  let transactionsCategorized = 0;
  // Collected across accounts so rules run once at the end rather than per
  // account, which keeps first-match-wins evaluation over one consistent set.
  const importedTransactionIds: string[] = [];

  try {
    // Windowed, because the bridge silently caps a long range rather than
    // failing — see simplefin/backfill.ts.
    const feed = await fetchAccountsInWindows(options.client, {
      startDate,
      endDate: now,
      includePending: true,
    });
    errors.push(...feed.errors);

    for (const feedAccount of feed.accounts) {
      // USD only, by hard constraint. Importing a foreign-currency account would
      // silently corrupt the identity, so it is refused loudly instead.
      if (feedAccount.currency && feedAccount.currency.toUpperCase() !== 'USD') {
        errors.push(
          `Skipped "${feedAccount.name}": this budget is USD only and that account reports ${feedAccount.currency}.`,
        );
        continue;
      }

      const { accountId, discovered } = await upsertAccount(db, feedAccount, now);
      accountsTouched += 1;
      if (discovered) {
        accountsDiscovered += 1;
        logger.info({ correlationId, accountId, name: feedAccount.name }, 'account discovered');
      }

      const counts = await ingestTransactions(
        db,
        accountId,
        feedAccount.transactions,
        now,
        logger,
        correlationId,
      );
      transactionsAdded += counts.added;
      transactionsUpdated += counts.updated;
      importedTransactionIds.push(...counts.importedIds);

      const reconciled = await reconcilePending(db, {
        accountId,
        seenExternalIds: new Set(feedAccount.transactions.map((t) => t.externalId)),
        windowStart: startDate,
        now,
        actorId: options.actorId ?? null,
        logger,
        correlationId,
      });
      transactionsUpdated += reconciled.settled;
      transactionsReversed += reconciled.reversed;
    }

    // Rules run after every account is ingested and reconciled, so evaluation
    // sees one settled set of rows. Restricted to what this run imported: a rule
    // added since the last sync must be applied deliberately through
    // "apply to existing", not as a side effect of an unrelated sync.
    if (importedTransactionIds.length > 0) {
      const applied = await applyRules(db, {
        transactionIds: importedTransactionIds,
        actorId: options.actorId ?? null,
      });
      transactionsCategorized = applied.categorized;

      if (applied.categorized > 0) {
        logger.info(
          { correlationId, categorized: applied.categorized, examined: applied.examined },
          'auto-categorization applied',
        );
      }
    }

    /**
     * Checks are matched after the rules, and against everything uncategorized
     * rather than only this run's imports.
     *
     * Unlike a rule, this cannot fire on the wrong row by being too eager: a
     * match needs the exact amount and the check number as a whole token. And a
     * check written last month clears whenever the bank gets round to it, so
     * restricting the search to this run's imports would simply miss it.
     */
    const matched = await matchClearedChecks(db, { actorId: options.actorId ?? null });
    if (matched.length > 0) {
      logger.info(
        { correlationId, checks: matched.map((match) => match.checkNumber) },
        'outstanding checks cleared',
      );
    }

    await db.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        accountsTouched,
        transactionsAdded,
        transactionsUpdated,
        transactionsReversed,
        // Non-fatal feed errors are recorded on a successful run so the banner
        // can still surface them. They are never swallowed.
        error: errors.length > 0 ? errors.join('\n') : null,
      },
    });

    logger.info(
      {
        correlationId,
        syncRunId,
        accountsTouched,
        transactionsAdded,
        transactionsUpdated,
        transactionsReversed,
      },
      'sync finished',
    );

    return {
      syncRunId,
      status: 'succeeded',
      accountsTouched,
      accountsDiscovered,
      transactionsAdded,
      transactionsUpdated,
      transactionsReversed,
      transactionsCategorized,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db.syncRun.update({
      where: { id: syncRunId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        accountsTouched,
        transactionsAdded,
        transactionsUpdated,
        transactionsReversed,
        error: [message, ...errors].join('\n'),
      },
    });

    // Surfaced as a persistent in-app banner, never logs alone.
    logger.error({ correlationId, syncRunId, err: error }, 'sync failed');
    throw error;
  }
}

async function upsertAccount(
  db: Db,
  feedAccount: FeedAccount,
  now: Date,
): Promise<{ accountId: string; discovered: boolean }> {
  const existing = await db.account.findUnique({
    where: {
      account_source_external_id: { source: 'simplefin', externalId: feedAccount.externalId },
    },
    select: { id: true, type: true },
  });

  if (existing) {
    // The type is never re-guessed. The owner may have overridden it, and a sync
    // silently flipping an account between asset and debt would move the identity.
    await db.account.update({
      where: { id: existing.id },
      data: {
        balanceCents: storedBalance(existing.type, feedAccount.balanceCents),
        balanceAsOf: feedAccount.balanceAsOf ?? now,
      },
    });
    return { accountId: existing.id, discovered: false };
  }

  // The institution name carries the signal as often as the account name does:
  // a real feed returns institution "Discover Credit Card" with account name
  // "Andy Anderson (7169)", and guessing from the account name alone reads a
  // credit card as an asset — which then adds to the identity instead of
  // subtracting from it.
  const displayName = feedAccount.institution
    ? `${feedAccount.institution} ${feedAccount.name}`.trim()
    : feedAccount.name;

  const type = guessAccountType(displayName, feedAccount.balanceCents);
  const created = await db.account.create({
    data: {
      name: displayName,
      type,
      source: 'simplefin',
      externalId: feedAccount.externalId,
      balanceCents: storedBalance(type, feedAccount.balanceCents),
      balanceAsOf: feedAccount.balanceAsOf ?? now,
      // Defaults per §7; `needsReview` prompts the owner to confirm the guess.
      inBudget: true,
      inNetWorth: true,
      needsReview: true,
    },
    select: { id: true },
  });

  return { accountId: created.id, discovered: true };
}

async function ingestTransactions(
  db: Db,
  accountId: string,
  feedTransactions: readonly FeedTransaction[],
  now: Date,
  logger: SyncLogger,
  correlationId: string,
): Promise<{ added: number; updated: number; importedIds: string[] }> {
  let added = 0;
  let updated = 0;
  const importedIds: string[] = [];

  for (const feedTransaction of feedTransactions) {
    const existing = await db.transaction.findUnique({
      where: {
        transaction_account_external_id: { accountId, externalId: feedTransaction.externalId },
      },
      select: {
        id: true,
        amountCents: true,
        pending: true,
        postedAt: true,
        description: true,
        archivedAt: true,
        _count: { select: { allocations: true } },
      },
    });

    if (!existing) {
      const created = await db.transaction.create({
        data: {
          accountId,
          externalId: feedTransaction.externalId,
          source: 'simplefin',
          amountCents: feedTransaction.amountCents,
          postedAt: feedTransaction.occurredAt,
          description: feedTransaction.description,
          descriptionRaw: feedTransaction.description,
          pending: feedTransaction.pending,
        },
        select: { id: true },
      });
      added += 1;
      importedIds.push(created.id);
      continue;
    }

    const amountChanged = existing.amountCents !== feedTransaction.amountCents;

    // A pending charge that settles at a different amount — a restaurant tip is
    // the everyday case — would leave allocations that no longer sum to the
    // transaction. Back the categorization out and let it resurface as
    // uncategorized rather than hold a total that cannot be right.
    if (amountChanged && existing._count.allocations > 0) {
      await markEventsReversed(db, { transactionId: existing.id }, now);
      await db.transactionAllocation.deleteMany({ where: { transactionId: existing.id } });
      logger.warn(
        {
          correlationId,
          transactionId: existing.id,
          was: existing.amountCents.toString(),
          now: feedTransaction.amountCents.toString(),
        },
        'amount changed after categorization; categorization reversed',
      );
    }

    const unchanged =
      !amountChanged &&
      existing.pending === feedTransaction.pending &&
      existing.description === feedTransaction.description &&
      existing.postedAt.getTime() === feedTransaction.occurredAt.getTime();

    if (unchanged) continue;

    await db.transaction.update({
      where: { id: existing.id },
      data: {
        amountCents: feedTransaction.amountCents,
        postedAt: feedTransaction.occurredAt,
        description: feedTransaction.description,
        descriptionRaw: feedTransaction.description,
        pending: feedTransaction.pending,
      },
    });
    updated += 1;
  }

  return { added, updated, importedIds };
}

interface ReconcilePendingOptions {
  readonly accountId: string;
  readonly seenExternalIds: ReadonlySet<string>;
  readonly windowStart: Date;
  readonly now: Date;
  readonly actorId: string | null;
  readonly logger: SyncLogger;
  readonly correlationId: string;
}

/**
 * Resolves pending rows the feed stopped reporting.
 *
 * Only rows inside the requested window are considered. A pending transaction
 * older than the window is absent because we did not ask for it, not because it
 * vanished, and reversing those would wrongly credit envelopes.
 *
 * A pending row that reappears under a new id — which is what most banks do on
 * settlement — is matched on account, exact amount and date proximity, and its
 * categorization is carried across. One that matches nothing never happened, and
 * is reversed.
 */
async function reconcilePending(
  db: Db,
  options: ReconcilePendingOptions,
): Promise<{ settled: number; reversed: number }> {
  const disappeared = await db.transaction.findMany({
    where: {
      accountId: options.accountId,
      pending: true,
      archivedAt: null,
      source: 'simplefin',
      postedAt: { gte: options.windowStart },
      externalId: { notIn: [...options.seenExternalIds] },
    },
    select: { id: true },
  });
  if (disappeared.length === 0) return { settled: 0, reversed: 0 };

  const disappearedIds = disappeared.map((row) => row.id);
  const matches = await findPostedMatchesForPending(db, { pendingTransactionIds: disappearedIds });
  const matchedIds = new Set(matches.map((match) => match.pendingTransactionId));

  for (const match of matches) {
    await carryPendingCategorizationToPosted(
      db,
      match.pendingTransactionId,
      match.postedTransactionId,
      {
        actorId: options.actorId,
        now: options.now,
      },
    );
    options.logger.info(
      {
        correlationId: options.correlationId,
        pendingTransactionId: match.pendingTransactionId,
        postedTransactionId: match.postedTransactionId,
        dayGap: match.dayGap,
      },
      'pending transaction settled',
    );
  }

  let reversed = 0;
  for (const id of disappearedIds) {
    if (matchedIds.has(id)) continue;
    await reversePendingTransaction(db, id, { now: options.now });
    reversed += 1;
    options.logger.info(
      { correlationId: options.correlationId, transactionId: id },
      'pending transaction vanished; effect reversed',
    );
  }

  return { settled: matches.length, reversed };
}
