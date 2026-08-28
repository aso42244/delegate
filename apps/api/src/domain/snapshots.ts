import {
  bitcoinValueCents,
  weakestProvenance,
  type Cents,
  type SnapshotProvenance,
} from '@budget/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { priceOnDate } from './bitcoin.js';

/**
 * The nightly record of the whole financial picture. See ADR 035.
 *
 * The delegation ledger gives envelopes a history. Account balances and net
 * worth never had one, so Insights could show today and never a trend — and
 * every day nothing captured state was a day gone for good.
 *
 * This module writes what it can *see*. Repairing days nobody was running for is
 * the gap-filler's job, and everything it writes is marked as derived rather
 * than observed.
 */

// ---------------------------------------------------------------------------
// Which day a run is for
// ---------------------------------------------------------------------------

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The calendar date at an instant, in a given zone. */
function localDateIn(instant: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const part = (type: string): number => Number(parts.find((piece) => piece.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/**
 * The date a run at this instant should be labelled with: **the previous day**,
 * in the household's zone.
 *
 * A run at 03:10 on the 15th produces rows dated the 14th, read as "end of day
 * the 14th". Deliberate, and not to be changed: a row written at three in the
 * morning describes the day that just finished, not the one three hours old.
 *
 * Calendar arithmetic on the local date, never instant arithmetic. Subtracting
 * 24 hours from a timestamp lands on the wrong day twice a year: on the
 * spring-forward morning the previous local day is 23 hours back, and on the
 * autumn one it is 25. `Date.UTC` normalises day 0 and month -1 itself, so the
 * first of a month and the first of January need no special case.
 *
 * The result is midnight UTC, which is how every other date in this schema is
 * filed — `account_valuations.as_of` and `bitcoin_prices.price_date` both.
 */
export function snapshotDateFor(now: Date, timeZone: string): Date {
  const { year, month, day } = localDateIn(now, timeZone);
  return new Date(Date.UTC(year, month - 1, day - 1));
}

/** Midnight UTC for a date, so a caller's timestamp files under the right day. */
export function asSnapshotDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ---------------------------------------------------------------------------
// What a day looks like
// ---------------------------------------------------------------------------

export interface AccountSnapshotRow {
  readonly accountId: string;
  readonly balanceCents: Cents;
  readonly provenance: SnapshotProvenance;
  readonly accountType: 'asset' | 'debt';
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly quantitySats: Cents | null;
  readonly priceCents: Cents | null;
}

export interface DelegationSnapshotRow {
  readonly delegationId: string;
  readonly balanceCents: Cents;
  readonly provenance: SnapshotProvenance;
  readonly groupingId: string | null;
}

export interface AggregateSnapshotRow {
  readonly netWorthAssetsCents: Cents;
  readonly netWorthDebtsCents: Cents;
  readonly netWorthCents: Cents;
  readonly budgetAssetsCents: Cents;
  readonly budgetDebtsCents: Cents;
  readonly totalDelegationsCents: Cents;
  readonly pendingCategorizedCents: Cents;
  readonly identityValueCents: Cents;
  readonly provenance: SnapshotProvenance;
}

export interface SnapshotDay {
  readonly snapshotDate: Date;
  readonly accounts: readonly AccountSnapshotRow[];
  readonly delegations: readonly DelegationSnapshotRow[];
  readonly aggregate: AggregateSnapshotRow;
}

/**
 * What the application can see right now, labelled for `snapshotDate`.
 *
 * "Right now" rather than "at the end of that day" is the honest description: a
 * balance read at 03:10 is the most recent thing anybody knows about the day
 * before, and there is nothing closer to reach for. That is the whole reason
 * rows are labelled for the previous day rather than the current one.
 */
export async function observeDay(
  db: Db,
  snapshotDate: Date,
  logger?: FastifyBaseLogger,
): Promise<SnapshotDay> {
  const [accountRows, delegationRows, price] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        type: true,
        balanceCents: true,
        bitcoinSats: true,
        inBudget: true,
        inNetWorth: true,
      },
    }),
    db.delegation.findMany({
      where: { archivedAt: null },
      select: { id: true, balanceCents: true, groupingId: true },
    }),
    /*
     * The close for the date being recorded, never today's price applied
     * backwards — the specific error the price table exists to prevent.
     *
     * The ordering works out: the price job runs at :05 past every hour and
     * settles the previous day's close on the way through, and this job runs at
     * :10. So by the time a 03:10 run asks for yesterday's price, the 03:05 run
     * has already settled it.
     */
    priceOnDate(db, snapshotDate),
  ]);

  /**
   * A Bitcoin holding's worth is its quantity at that date's price. Its
   * `balance_cents` is zero unless the holding is in-budget, so summing that
   * column alone would record a real holding as worth nothing — the same bug the
   * composition widget had.
   */
  const marketValue = (account: { bitcoinSats: bigint | null; balanceCents: bigint }): Cents =>
    account.bitcoinSats === null
      ? account.balanceCents
      : price === null
        ? 0n
        : bitcoinValueCents(account.bitcoinSats, price.priceCents);

  /**
   * A holding valued at a price nobody recorded for that date is an estimate,
   * and says so. `priceOnDate` carries the last close forward and marks it
   * stale; a stale price makes the row `interpolated` rather than `observed`,
   * because the quantity was seen and the price was guessed.
   *
   * With no price at all the holding contributes zero, which is what every other
   * reading in the application does. Zero is wrong, but it is visibly an
   * estimate here in a way it is nowhere else.
   */
  const bitcoinProvenance: SnapshotProvenance =
    price === null || price.stale ? 'interpolated' : 'observed';

  if (price === null) {
    logger?.warn(
      { snapshotDate },
      'no Bitcoin price has ever been recorded; holdings are snapshotted at zero and marked estimated',
    );
  } else if (price.stale) {
    logger?.warn(
      { snapshotDate, priceDate: price.priceDate },
      'no Bitcoin close for this date; the previous one was carried and the row marked estimated',
    );
  }

  const accounts: AccountSnapshotRow[] = accountRows.map((account) => ({
    accountId: account.id,
    balanceCents: marketValue(account),
    provenance: account.bitcoinSats === null ? 'observed' : bitcoinProvenance,
    accountType: account.type,
    inBudget: account.inBudget,
    inNetWorth: account.inNetWorth,
    quantitySats: account.bitcoinSats,
    priceCents: account.bitcoinSats === null ? null : (price?.priceCents ?? null),
  }));

  const delegations: DelegationSnapshotRow[] = delegationRows.map((delegation) => ({
    delegationId: delegation.id,
    balanceCents: delegation.balanceCents,
    provenance: 'observed',
    groupingId: delegation.groupingId,
  }));

  const ledgerBalances = new Map(accountRows.map((account) => [account.id, account.balanceCents]));
  const aggregate = await buildAggregate(db, ledgerBalances, accounts, delegations);
  return { snapshotDate, accounts, delegations, aggregate };
}

/**
 * The day's totals.
 *
 * **Two scopes, and they are not the same arithmetic.** Net worth values a
 * Bitcoin holding at the market, because that is what it is worth. The identity
 * sums `balance_cents` exactly as `computeBudgetIdentity` does, because that is
 * the column the Budget page adds up — a holding marked in-budget has its dollar
 * figure written there once a day by the revaluation job (ADR 021), and using
 * the market value here instead would make this row disagree with the chip
 * beside the Budget title on any day the two had drifted.
 */
async function buildAggregate(
  db: Db,
  ledgerBalances: ReadonlyMap<string, Cents>,
  accounts: readonly AccountSnapshotRow[],
  delegations: readonly DelegationSnapshotRow[],
): Promise<AggregateSnapshotRow> {
  let netWorthAssetsCents = 0n;
  let netWorthDebtsCents = 0n;
  let budgetAssetsCents = 0n;
  let budgetDebtsCents = 0n;

  for (const account of accounts) {
    if (account.inNetWorth) {
      if (account.accountType === 'asset') netWorthAssetsCents += account.balanceCents;
      else netWorthDebtsCents += account.balanceCents;
    }

    if (account.inBudget) {
      // The stored column, not the market value — see the note above.
      const ledger = ledgerBalances.get(account.accountId) ?? 0n;
      if (account.accountType === 'asset') budgetAssetsCents += ledger;
      else budgetDebtsCents += ledger;
    }
  }

  const [delegationTotal, pending] = await Promise.all([
    /*
     * Every delegation, archived ones included — exactly as the identity does.
     * Archiving requires a $0 balance so they contribute nothing in practice,
     * but excluding them would let a nonzero archived line quietly break the
     * identity instead of showing up in it.
     */
    db.delegation.aggregate({ _sum: { balanceCents: true } }),
    /*
     * The fourth term: categorized pending charges the account balances do not
     * carry yet. Same condition as `computeBudgetIdentity`, so the stored
     * identity is the same figure the Budget page shows.
     */
    db.transaction.aggregate({
      where: {
        pending: true,
        archivedAt: null,
        allocations: { some: {} },
        account: { inBudget: true, archivedAt: null },
      },
      _sum: { amountCents: true },
    }),
  ]);

  const totalDelegationsCents = delegationTotal._sum.balanceCents ?? 0n;
  const pendingCategorizedCents = pending._sum.amountCents ?? 0n;

  return {
    netWorthAssetsCents,
    netWorthDebtsCents,
    netWorthCents: netWorthAssetsCents - netWorthDebtsCents,
    budgetAssetsCents,
    budgetDebtsCents,
    totalDelegationsCents,
    pendingCategorizedCents,
    // Added, not subtracted: a pending spend is already negative.
    identityValueCents:
      budgetAssetsCents - budgetDebtsCents - totalDelegationsCents + pendingCategorizedCents,
    // Only as good as the weakest row that fed it.
    provenance: weakestProvenance([
      ...accounts.map((row) => row.provenance),
      ...delegations.map((row) => row.provenance),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

export interface WriteResult {
  readonly snapshotDate: Date;
  readonly accountsWritten: number;
  readonly delegationsWritten: number;
  readonly accountsKept: number;
  readonly delegationsKept: number;
  readonly aggregateWritten: boolean;
  /** Rows written with anything other than `observed`, for the run's log line. */
  readonly derived: Record<string, number>;
}

/**
 * Writes a day, in one transaction.
 *
 * **All three tables or none.** A partial day is worse than a missing day: the
 * gap-filler can see a date with no rows and repair it, and cannot see a date
 * whose accounts were written and whose aggregate was not.
 *
 * **An `observed` row is never overwritten.** Not by a reconstruction, and not
 * by a re-run. A re-run repairs what is missing; it does not revise what was
 * seen. That is what makes the manual trigger safe to point at any date.
 */
export async function writeSnapshotDay(db: Db, day: SnapshotDay): Promise<WriteResult> {
  const snapshotDate = asSnapshotDate(day.snapshotDate);

  const [existingAccounts, existingDelegations, existingAggregate] = await Promise.all([
    db.accountSnapshot.findMany({
      where: { snapshotDate },
      select: { accountId: true, provenance: true },
    }),
    db.delegationSnapshot.findMany({
      where: { snapshotDate },
      select: { delegationId: true, provenance: true },
    }),
    db.aggregateSnapshot.findUnique({
      where: { snapshotDate },
      select: { provenance: true },
    }),
  ]);

  const observedAccounts = new Set(
    existingAccounts.filter((row) => row.provenance === 'observed').map((row) => row.accountId),
  );
  const observedDelegations = new Set(
    existingDelegations
      .filter((row) => row.provenance === 'observed')
      .map((row) => row.delegationId),
  );

  const accounts = day.accounts.filter((row) => !observedAccounts.has(row.accountId));
  const delegations = day.delegations.filter((row) => !observedDelegations.has(row.delegationId));
  const writeAggregate = existingAggregate?.provenance !== 'observed';

  const derived: Record<string, number> = {};
  for (const row of [...accounts, ...delegations]) {
    if (row.provenance === 'observed') continue;
    derived[row.provenance] = (derived[row.provenance] ?? 0) + 1;
  }

  for (const row of accounts) {
    const data = {
      balanceCents: row.balanceCents,
      provenance: row.provenance,
      accountType: row.accountType,
      inBudget: row.inBudget,
      inNetWorth: row.inNetWorth,
      quantitySats: row.quantitySats,
      priceCents: row.priceCents,
    };
    await db.accountSnapshot.upsert({
      where: { snapshotDate_accountId: { snapshotDate, accountId: row.accountId } },
      create: { snapshotDate, accountId: row.accountId, ...data },
      update: data,
    });
  }

  for (const row of delegations) {
    const data = {
      balanceCents: row.balanceCents,
      provenance: row.provenance,
      groupingId: row.groupingId,
    };
    await db.delegationSnapshot.upsert({
      where: { snapshotDate_delegationId: { snapshotDate, delegationId: row.delegationId } },
      create: { snapshotDate, delegationId: row.delegationId, ...data },
      update: data,
    });
  }

  if (writeAggregate) {
    const { provenance, ...totals } = day.aggregate;
    await db.aggregateSnapshot.upsert({
      where: { snapshotDate },
      create: { snapshotDate, provenance, ...totals },
      update: { provenance, ...totals },
    });
  }

  return {
    snapshotDate,
    accountsWritten: accounts.length,
    delegationsWritten: delegations.length,
    accountsKept: day.accounts.length - accounts.length,
    delegationsKept: day.delegations.length - delegations.length,
    aggregateWritten: writeAggregate,
    derived,
  };
}

/**
 * Observe the current picture and store it under `snapshotDate`, in one
 * transaction.
 *
 * This takes the real client rather than a `Db`, because it is the place that
 * decides the transaction boundary — the convention everywhere else in this
 * codebase is that domain functions take a `Db` and the caller opens the
 * transaction, and this is that caller.
 *
 * The read is inside it too, so the totals cannot be computed from a picture
 * that changed halfway through. The hourly sync runs at :00 and this at :10;
 * they will not usually overlap, but "usually" is not a guarantee worth relying
 * on for a stored record.
 */
export async function captureSnapshot(
  client: PrismaClient,
  snapshotDate: Date,
  logger?: FastifyBaseLogger,
): Promise<WriteResult> {
  return client.$transaction(
    async (tx) => {
      const day = await observeDay(tx, asSnapshotDate(snapshotDate), logger);
      return writeSnapshotDay(tx, day);
    },
    // Generous for a two-core NAS with a hundred-odd upserts. The default five
    // seconds is a limit this could plausibly meet on a bad night, and a
    // timeout here means a missing day rather than a slow one.
    { timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Is it running?
// ---------------------------------------------------------------------------

export interface SnapshotStatus {
  /** The most recent date with a stored aggregate. Null before the first run. */
  readonly latestDate: Date | null;
  readonly latestProvenance: SnapshotProvenance | null;
  readonly days: number;
  /**
   * True when the newest snapshot is more than two days old, or there is none.
   *
   * Two days rather than one: a run is for the *previous* day, so the newest
   * date is always a day behind even when everything is working, and a threshold
   * of one would warn every morning. A warning that fires in the ordinary case is
   * one nobody reads — which is exactly how a nightly backup failed for weeks in
   * plain sight.
   */
  readonly stale: boolean;
}

const STALE_AFTER_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the interface needs to answer "did the job run", from the evidence rather
 * than from the absence of an error.
 *
 * The lesson is written into `docs/handoff.md` at some length: the nightly
 * `pg_dump` reported its failures correctly, into a log nobody read, and the
 * question nobody asked was whether a dump was actually on disk. This is that
 * question for snapshots, and it is why the answer is on a screen.
 */
export async function snapshotStatus(db: Db, now: Date = new Date()): Promise<SnapshotStatus> {
  const [latest, days] = await Promise.all([
    db.aggregateSnapshot.findFirst({
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true, provenance: true },
    }),
    db.aggregateSnapshot.count(),
  ]);

  if (!latest) {
    return { latestDate: null, latestProvenance: null, days: 0, stale: true };
  }

  const age = asSnapshotDate(now).getTime() - latest.snapshotDate.getTime();
  return {
    latestDate: latest.snapshotDate,
    latestProvenance: latest.provenance,
    days,
    stale: age > STALE_AFTER_DAYS * DAY_MS,
  };
}
