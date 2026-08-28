import {
  bitcoinValueCents,
  weakestProvenance,
  type Cents,
  type SnapshotProvenance,
} from '@budget/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client.js';
import { accountBalanceDelta } from './accounts.js';
import { priceOnDate } from './bitcoin.js';
import { endOfLocalDay, localDayKey } from './calendar.js';
import { satsOnDate } from './bitcoin-holdings.js';
import {
  asSnapshotDate,
  writeSnapshotDay,
  type AccountSnapshotRow,
  type AggregateSnapshotRow,
  type DelegationSnapshotRow,
  type SnapshotDay,
} from './snapshots.js';
import { valueOnDate } from './valuations.js';

/**
 * Repairing days nobody was running for. See ADR 035.
 *
 * The NAS reboots, containers restart, power fails. Nothing here is a backfill:
 * it only ever fills dates **between an existing snapshot and yesterday**, so a
 * deployment with no snapshots at all stays empty and history starts at the
 * first run. That is a product decision, and this is the one place it could be
 * quietly undone.
 *
 * Every row is filled by the most accurate method available for that row, and
 * every row says which method it was. Nothing here writes `observed` — an
 * observation means somebody looked.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A sanity bound rather than a tuning knob.
 *
 * A gap longer than a year is not an outage, it is a clock that moved or a
 * database restored from somewhere unexpected — and grinding through a thousand
 * days on a two-core NAS would be a worse answer than saying so.
 */
const MAX_GAP_DAYS = 370;

function startOfDay(date: Date): Date {
  return asSnapshotDate(date);
}

// ---------------------------------------------------------------------------
// Which days are missing
// ---------------------------------------------------------------------------

export interface Gap {
  readonly dates: readonly Date[];
  /** True when the gap was longer than `MAX_GAP_DAYS` and has been cut short. */
  readonly truncated: boolean;
}

/**
 * The dates between the newest stored snapshot and `through`, exclusive of the
 * former and inclusive of the latter.
 *
 * Empty when nothing is stored yet. **That is the no-backfill rule**, and it is
 * load-bearing: without a first snapshot there is no gap, only history nobody
 * chose to record.
 */
export async function missingDates(db: Db, through: Date): Promise<Gap> {
  const newest = await db.aggregateSnapshot.findFirst({
    orderBy: { snapshotDate: 'desc' },
    select: { snapshotDate: true },
  });
  if (!newest) return { dates: [], truncated: false };

  const last = startOfDay(newest.snapshotDate).getTime();
  const end = startOfDay(through).getTime();

  const dates: Date[] = [];
  for (let time = last + DAY_MS; time <= end; time += DAY_MS) {
    dates.push(new Date(time));
    if (dates.length >= MAX_GAP_DAYS) {
      return { dates, truncated: time < end };
    }
  }
  return { dates, truncated: false };
}

// ---------------------------------------------------------------------------
// Per-row strategies
// ---------------------------------------------------------------------------

interface AccountForFill {
  readonly id: string;
  readonly type: 'asset' | 'debt';
  readonly source: 'simplefin' | 'manual';
  readonly balanceCents: Cents;
  readonly bitcoinSats: Cents | null;
  readonly inBudget: boolean;
  readonly inNetWorth: boolean;
  readonly createdAt: Date;
}

/**
 * **1. Delegations — exact, always.**
 *
 * The balance on a date is the sum of every un-reversed event that had happened
 * by the end of it. Exact regardless of how long the gap was, because the ledger
 * is the truth and it is all still there.
 *
 * "The end of it" is the end of the household's day. `occurred_at` is an
 * instant and `snapshot_date` is a local day, so cutting at midnight UTC would
 * put an evening's delegating on the wrong side of the boundary — see ADR 037.
 */
async function delegationBalanceOn(
  db: Db,
  delegationId: string,
  date: Date,
  timeZone: string,
): Promise<Cents> {
  const result = await db.delegationEvent.aggregate({
    where: {
      delegationId,
      reversedAt: null,
      occurredAt: { lt: endOfLocalDay(date, timeZone) },
    },
    _sum: { deltaCents: true },
  });
  return result._sum.deltaCents ?? 0n;
}

/**
 * **2. SimpleFIN accounts — exact, walking backward.**
 *
 * Take the next balance actually known — the earliest snapshot after this date,
 * or today's live balance when there is none — and roll every posted transaction
 * back out of it.
 *
 * Signs go through `accountBalanceDelta`, the one function that knows a debt
 * opposes a transaction amount. Getting that backwards would move every card
 * balance the wrong way while leaving the identity looking fine, which is
 * exactly why it is not re-derived here.
 *
 * **Posted only.** A pending charge is not in the institution's settled balance,
 * so subtracting it would push the reconstruction off by its amount. Archived
 * rows are excluded too: whatever they once did to the balance was reversed when
 * they were archived, so the live balance already has them out.
 */
async function reconstructFromTransactions(
  db: Db,
  account: AccountForFill,
  date: Date,
  timeZone: string,
): Promise<{ balanceCents: Cents; exact: boolean }> {
  const anchor = await db.accountSnapshot.findFirst({
    where: { accountId: account.id, snapshotDate: { gt: startOfDay(date) } },
    orderBy: { snapshotDate: 'asc' },
    select: { snapshotDate: true, balanceCents: true },
  });

  const anchorBalance = anchor?.balanceCents ?? account.balanceCents;
  /*
   * A snapshot is the balance at the end of its own day; the live balance is the
   * balance now. Either way the window ends where the anchor's day ends — and
   * the day ends when it ends *here*. `posted_at` is an instant, so a UTC cut
   * would roll an evening charge back out of the wrong day. ADR 037.
   */
  const until = anchor ? endOfLocalDay(anchor.snapshotDate, timeZone) : null;

  const moved = await db.transaction.aggregate({
    where: {
      accountId: account.id,
      archivedAt: null,
      pending: false,
      postedAt: {
        gte: endOfLocalDay(date, timeZone),
        ...(until ? { lt: until } : {}),
      },
    },
    _sum: { amountCents: true },
  });

  const balanceCents =
    anchorBalance - accountBalanceDelta(account.type, moved._sum.amountCents ?? 0n);

  /*
   * Exact only as far back as the transactions reach. Before the earliest one
   * this produces a flat line at the oldest reconstructable balance, which looks
   * like data and is not — ADR 013 made exactly that mistake, and the answer here
   * is to keep the number and stop calling it exact.
   */
  const earliest = await db.transaction.findFirst({
    where: { accountId: account.id, archivedAt: null, pending: false },
    orderBy: { postedAt: 'asc' },
    select: { postedAt: true },
  });
  const exact =
    earliest !== null &&
    // Which day the earliest transaction is in — an instant becoming a day, so
    // it takes the zone rather than being truncated in UTC.
    localDayKey(earliest.postedAt, timeZone).getTime() <= startOfDay(date).getTime();

  return { balanceCents, exact };
}

/**
 * **4. Bitcoin — exact quantity, dated price.**
 *
 * The quantity is a dated append-only ledger (ADR 023), so what was held on a
 * date is a fact rather than a carry. Only the price can be missing, and when it
 * has to be carried from an earlier day the row becomes an estimate — the
 * quantity was known and the price was guessed.
 */
async function reconstructBitcoin(
  db: Db,
  account: AccountForFill,
  date: Date,
): Promise<AccountSnapshotRow> {
  const [sats, price] = await Promise.all([
    satsOnDate(db, date, { accountId: account.id }),
    priceOnDate(db, date),
  ]);

  return {
    accountId: account.id,
    balanceCents: price === null ? 0n : bitcoinValueCents(sats, price.priceCents),
    provenance: price === null || price.stale ? 'interpolated' : 'reconstructed',
    accountType: account.type,
    inBudget: account.inBudget,
    inNetWorth: account.inNetWorth,
    quantitySats: sats,
    priceCents: price?.priceCents ?? null,
  };
}

/**
 * **5. Interpolation — last resort only.**
 *
 * The straight midpoint between the two nearest stored values. With only one
 * neighbour it is that neighbour, which is not a midpoint but is the nearest
 * true thing available.
 *
 * Null when there is nothing on either side and no live balance to fall back on.
 */
async function interpolate(db: Db, account: AccountForFill, date: Date): Promise<Cents | null> {
  const day = startOfDay(date);

  const [before, after] = await Promise.all([
    db.accountSnapshot.findFirst({
      where: { accountId: account.id, snapshotDate: { lt: day } },
      orderBy: { snapshotDate: 'desc' },
      select: { balanceCents: true },
    }),
    db.accountSnapshot.findFirst({
      where: { accountId: account.id, snapshotDate: { gt: day } },
      orderBy: { snapshotDate: 'asc' },
      select: { balanceCents: true },
    }),
  ]);

  if (before && after) {
    // Integer arithmetic throughout: money never becomes a float, not even
    // halfway through an estimate.
    return (before.balanceCents + after.balanceCents) / 2n;
  }
  return before?.balanceCents ?? after?.balanceCents ?? null;
}

/** One account, on one missing date, by the best method available for it. */
async function fillAccount(
  db: Db,
  account: AccountForFill,
  date: Date,
  timeZone: string,
  logger?: FastifyBaseLogger,
): Promise<AccountSnapshotRow | null> {
  // An account that did not exist yet has no value on that date, and inventing
  // one would draw a line through a period it was not part of. `created_at` is
  // an instant, so which day it falls in is the household's question.
  if (localDayKey(account.createdAt, timeZone).getTime() > startOfDay(date).getTime()) return null;

  if (account.bitcoinSats !== null) return reconstructBitcoin(db, account, date);

  const row = (balanceCents: Cents, provenance: SnapshotProvenance): AccountSnapshotRow => ({
    accountId: account.id,
    balanceCents,
    provenance,
    accountType: account.type,
    inBudget: account.inBudget,
    inNetWorth: account.inNetWorth,
    quantitySats: null,
    priceCents: null,
  });

  if (account.source === 'simplefin') {
    const { balanceCents, exact } = await reconstructFromTransactions(db, account, date, timeZone);
    if (exact) return row(balanceCents, 'reconstructed');

    logger?.warn(
      { accountId: account.id, date },
      'gap predates this account’s transaction history; the balance is an estimate',
    );
    return row(balanceCents, 'interpolated');
  }

  /*
   * **3. Manual accounts — carry forward.**
   *
   * Manual values change in steps, not slopes. If property was $400,000 and
   * $420,000 was entered on the 16th, the 15th was $400,000 — not $410,000.
   */
  const carried = await valueOnDate(db, account.id, date);
  if (carried !== null) return row(carried, 'carried');

  const estimated = await interpolate(db, account, date);
  if (estimated !== null) {
    logger?.warn(
      { accountId: account.id, date },
      'manual account has no value recorded on or before this date; interpolating',
    );
    return row(estimated, 'interpolated');
  }

  /*
   * Nothing stored on either side. The live balance is all anybody knows, and
   * carrying it backwards is precisely the move ADR 013 was criticised for — so
   * it is kept, marked as the estimate it is, and said out loud.
   */
  logger?.warn(
    { accountId: account.id, date },
    'no stored value for this account on any side of this date; falling back to its current balance',
  );
  return row(account.balanceCents, 'interpolated');
}

// ---------------------------------------------------------------------------
// A whole missing day
// ---------------------------------------------------------------------------

/**
 * Rebuilds one missing date.
 *
 * Aggregates are recomputed **from the filled rows** and take the weakest
 * provenance among them, so a day rebuilt from one interpolated account is an
 * interpolated day.
 */
export async function rebuildDay(
  db: Db,
  date: Date,
  timeZone: string,
  logger?: FastifyBaseLogger,
): Promise<SnapshotDay> {
  const snapshotDate = startOfDay(date);

  const [accountRows, delegationRows] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        type: true,
        source: true,
        balanceCents: true,
        bitcoinSats: true,
        inBudget: true,
        inNetWorth: true,
        createdAt: true,
      },
    }),
    db.delegation.findMany({
      where: { archivedAt: null },
      select: { id: true, groupingId: true, createdAt: true },
    }),
  ]);

  const accounts: AccountSnapshotRow[] = [];
  for (const account of accountRows) {
    const row = await fillAccount(db, account, snapshotDate, timeZone, logger);
    if (row) accounts.push(row);
  }

  const delegations: DelegationSnapshotRow[] = [];
  for (const delegation of delegationRows) {
    // Same as an account: `created_at` is an instant, and which day it lands in
    // is the household's day.
    if (localDayKey(delegation.createdAt, timeZone).getTime() > snapshotDate.getTime()) continue;
    delegations.push({
      delegationId: delegation.id,
      balanceCents: await delegationBalanceOn(db, delegation.id, snapshotDate, timeZone),
      // Exact, from the ledger. Never anything weaker.
      provenance: 'reconstructed',
      groupingId: delegation.groupingId,
    });
  }

  return {
    snapshotDate,
    accounts,
    delegations,
    aggregate: aggregateFrom(accounts, delegations),
  };
}

/**
 * The day's totals, from the rows just rebuilt.
 *
 * Two things are knowingly weaker here than on an observed day, and both are
 * unrecoverable rather than unhandled:
 *
 * **The classification is today's.** A snapshot records the type and budget
 * flags as they stood that night; a rebuild has only what they are now. A day
 * repaired after an account was reclassified describes it the new way.
 *
 * **The pending term is zero.** A pending transaction is archived the moment it
 * posts or vanishes, so which charges were pending on a past date cannot be
 * recovered from anything still in the database. The identity on a rebuilt day
 * is therefore its first three terms, and the row's provenance already says the
 * day was not observed.
 */
function aggregateFrom(
  accounts: readonly AccountSnapshotRow[],
  delegations: readonly DelegationSnapshotRow[],
): AggregateSnapshotRow {
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
      if (account.accountType === 'asset') budgetAssetsCents += account.balanceCents;
      else budgetDebtsCents += account.balanceCents;
    }
  }

  const totalDelegationsCents = delegations.reduce((sum, row) => sum + row.balanceCents, 0n);

  return {
    netWorthAssetsCents,
    netWorthDebtsCents,
    netWorthCents: netWorthAssetsCents - netWorthDebtsCents,
    budgetAssetsCents,
    budgetDebtsCents,
    totalDelegationsCents,
    pendingCategorizedCents: 0n,
    identityValueCents: budgetAssetsCents - budgetDebtsCents - totalDelegationsCents,
    provenance: weakestOf(accounts, delegations),
  };
}

function weakestOf(
  accounts: readonly AccountSnapshotRow[],
  delegations: readonly DelegationSnapshotRow[],
): SnapshotProvenance {
  const provenances = [
    ...accounts.map((row) => row.provenance),
    ...delegations.map((row) => row.provenance),
  ];

  /*
   * A rebuilt day with no rows at all is still a rebuilt day. `weakestProvenance`
   * answers `observed` for an empty list — which is the right answer when the
   * nightly job looked and found nothing, and the wrong one here, where nothing
   * was looked at.
   */
  if (provenances.length === 0) return 'reconstructed';
  return weakestProvenance(provenances);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface FillResult {
  readonly filled: number;
  readonly dates: readonly Date[];
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * Fills every missing date between the newest snapshot and `through`.
 *
 * One transaction per day rather than one for the whole run: a fortnight of
 * outage should not be all-or-nothing, and a day that fails should not discard
 * the thirteen that succeeded. Within a day it is still all three tables or
 * none, which is the boundary that matters.
 */
export async function fillGaps(
  client: PrismaClient,
  through: Date,
  timeZone: string,
  logger?: FastifyBaseLogger,
): Promise<FillResult> {
  const startedAt = Date.now();
  const gap = await missingDates(client, through);

  if (gap.truncated) {
    logger?.warn(
      { from: gap.dates[0], days: gap.dates.length },
      `more than ${MAX_GAP_DAYS} days are missing; filling the oldest ${MAX_GAP_DAYS} and leaving the rest for the next run`,
    );
  }

  for (const date of gap.dates) {
    await client.$transaction(
      async (tx) => {
        const day = await rebuildDay(tx, date, timeZone, logger);
        await writeSnapshotDay(tx, day);
      },
      { timeout: 30_000 },
    );
  }

  const durationMs = Date.now() - startedAt;
  if (gap.dates.length > 0) {
    logger?.info(
      {
        days: gap.dates.length,
        from: gap.dates[0],
        to: gap.dates[gap.dates.length - 1],
        durationMs,
      },
      'missing snapshot days rebuilt',
    );
  }

  return { filled: gap.dates.length, dates: gap.dates, truncated: gap.truncated, durationMs };
}
