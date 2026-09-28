import { bitcoinValueCents, type Cents } from '@budget/shared';
import type { BitcoinEventType } from '@prisma/client';
import type { Db } from '../db/client.js';
import { revalueBitcoinHoldings } from './bitcoin.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * The Bitcoin holdings ledger.
 *
 * A quantity used to be one number on the account, which left the net worth
 * chart no choice but to apply *today's* quantity to every past date. It said so
 * in a comment. Two things follow from replacing that number with dated events,
 * and they are the whole design:
 *
 * 1. **What was held on a date is answerable.** Sum the deltas up to that date.
 *    A purchase in March shows up in March, and nowhere earlier.
 * 2. **What it cost is answerable too.** An event can carry the price of one
 *    whole Bitcoin at the time, so cost basis is the sum of what was actually
 *    paid rather than a number anyone has to keep by hand.
 *
 * Same shape as `delegation_events`, deliberately: append-only, reversal by
 * stamping `reversed_at` rather than deleting, and a cached sum on
 * `accounts.bitcoin_sats` written in the same transaction. The events are the
 * truth; the cache is an optimization that `recompute-balances` rebuilds and
 * checks. Nothing here mutates or deletes an event, so a correction cannot
 * silently rewrite what the chart showed yesterday.
 */

/** Midnight UTC for a date — what an `occurred_at` is filed under. */
export function holdingDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Events that add to a holding. The rest take away, and must be given as such. */
const ADDING: readonly BitcoinEventType[] = ['opening', 'purchase', 'transfer_in'];

/**
 * Whether a price belongs on this kind of event.
 *
 * A transfer between your own wallets buys nothing and sells nothing, so a price
 * on one would invent a gain out of moving your own money. An adjustment is a
 * correction to a quantity nobody transacted, and has no price either.
 */
const PRICED: readonly BitcoinEventType[] = ['purchase', 'sale'];

export interface RecordHoldingEventInput {
  readonly accountId: string;
  readonly eventType: BitcoinEventType;
  /** Always a positive magnitude; the sign comes from the event type. */
  readonly sats: Cents;
  /**
   * An adjustment only: the signed delta, because a correction can go either
   * way. Every other kind's direction is decided by what it means.
   */
  readonly signedSats?: Cents | undefined;
  readonly occurredAt: Date;
  readonly priceCents?: Cents | null | undefined;
  readonly note?: string | null | undefined;
  readonly actorId?: string | null | undefined;
}

/**
 * Records one dated change, and moves the cached quantity by the same amount.
 *
 * The magnitude is given unsigned and the direction comes from the event type.
 * Asking a caller for a negative number and *also* for the word "sale" is asking
 * the same question twice, and a disagreement between the two answers would be a
 * silent wrong balance.
 *
 * `increment`, not a read-then-write of an absolute: two events recorded against
 * one holding at once must both land, and Postgres serializes them on the row
 * lock rather than losing one to a stale read.
 */
export async function recordHoldingEvent(
  db: Db,
  input: RecordHoldingEventInput,
  now: Date = new Date(),
): Promise<{ id: string; balanceSats: Cents }> {
  if (input.sats < 0n) {
    throw new ValidationError(
      'bitcoin_amount_negative',
      'Give the amount as a positive quantity. Whether it adds or subtracts comes from what kind of event it is.',
    );
  }
  if (input.sats === 0n) {
    throw new ValidationError(
      'bitcoin_amount_zero',
      'An event that moves nothing is not an event.',
    );
  }

  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, managedAs: true, archivedAt: true, bitcoinSats: true, inBudget: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);
  if (account.managedAs !== 'bitcoin') {
    throw new ConflictError('account_not_managed_here', 'That is not a Bitcoin holding.');
  }
  if (account.archivedAt) {
    throw new ConflictError('account_archived', 'That holding is archived. Restore it first.');
  }

  if (input.priceCents != null) {
    if (input.priceCents <= 0n) {
      throw new ValidationError('bitcoin_price_not_positive', 'A price must be positive.');
    }
    if (!PRICED.includes(input.eventType)) {
      throw new ValidationError(
        'bitcoin_price_not_applicable',
        'Only a purchase or a sale carries a price. Moving Bitcoin between your own wallets buys nothing.',
      );
    }
  }

  // An adjustment is the one kind that can go either way, so it carries its own
  // sign; every other kind's direction is fixed by what it means, and asking a
  // caller for both the word and the sign would be asking twice.
  const deltaSats =
    input.eventType === 'adjustment'
      ? (input.signedSats ?? input.sats)
      : ADDING.includes(input.eventType)
        ? input.sats
        : -input.sats;

  // A holding cannot go below zero: you cannot sell what you never had, and a
  // negative quantity would put a negative asset on the net worth chart.
  const resulting = (account.bitcoinSats ?? 0n) + deltaSats;
  if (resulting < 0n) {
    throw new ValidationError(
      'bitcoin_would_go_negative',
      'That is more Bitcoin than this holding has.',
      { heldSats: (account.bitcoinSats ?? 0n).toString() },
    );
  }

  const event = await db.bitcoinHoldingEvent.create({
    data: {
      accountId: input.accountId,
      occurredAt: holdingDate(input.occurredAt),
      deltaSats,
      eventType: input.eventType,
      priceCents: input.priceCents ?? null,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
    },
    select: { id: true },
  });

  const updated = await db.account.update({
    where: { id: input.accountId },
    data: {
      bitcoinSats: { increment: deltaSats },
      // Recording a movement is confirming the quantity, which is what
      // staleness counts from.
      balanceAsOf: now,
    },
    select: { bitcoinSats: true },
  });

  // An in-budget holding carries a dollar figure the identity reads, and it is
  // wrong the instant the quantity moves.
  if (account.inBudget) {
    await revalueBitcoinHoldings(db, { force: true, accountId: input.accountId }, now);
  }

  return { id: event.id, balanceSats: updated.bitcoinSats ?? 0n };
}

/**
 * Backs an event out without deleting it.
 *
 * Stamped rather than removed, so the history of what the chart showed stays
 * readable. Reversing is idempotent: a retried request must not move the
 * quantity twice.
 */
export async function reverseHoldingEvent(
  db: Db,
  eventId: string,
  now: Date = new Date(),
): Promise<{ reversed: boolean }> {
  const event = await db.bitcoinHoldingEvent.findUnique({
    where: { id: eventId },
    select: { id: true, accountId: true, deltaSats: true, reversedAt: true },
  });
  if (!event) throw new NotFoundError('BitcoinHoldingEvent', eventId);
  if (event.reversedAt) return { reversed: false };

  const account = await db.account.findUniqueOrThrow({
    where: { id: event.accountId },
    select: { bitcoinSats: true, inBudget: true },
  });
  if ((account.bitcoinSats ?? 0n) - event.deltaSats < 0n) {
    throw new ConflictError(
      'bitcoin_would_go_negative',
      'Backing that out would leave this holding with less than nothing. Reverse what came after it first.',
    );
  }

  await db.bitcoinHoldingEvent.update({
    where: { id: eventId },
    data: { reversedAt: now },
  });
  await db.account.update({
    where: { id: event.accountId },
    data: { bitcoinSats: { decrement: event.deltaSats }, balanceAsOf: now },
  });

  if (account.inBudget) {
    await revalueBitcoinHoldings(db, { force: true, accountId: event.accountId }, now);
  }

  return { reversed: true };
}

/**
 * How much was held on a date, across every holding or one of them.
 *
 * This is the function the net worth chart was missing. Everything up to and
 * including that day counts; nothing after it does.
 */
export async function satsOnDate(
  db: Db,
  date: Date,
  options: { readonly accountId?: string } = {},
): Promise<Cents> {
  const result = await db.bitcoinHoldingEvent.aggregate({
    where: {
      reversedAt: null,
      occurredAt: { lte: holdingDate(date) },
      ...(options.accountId ? { accountId: options.accountId } : {}),
      account: { archivedAt: null },
    },
    _sum: { deltaSats: true },
  });
  return result._sum.deltaSats ?? 0n;
}

/** The first day any Bitcoin was held, so a chart knows where its history starts. */
export async function earliestHoldingDate(
  db: Db,
  options: { readonly accountId?: string } = {},
): Promise<Date | null> {
  const first = await db.bitcoinHoldingEvent.findFirst({
    where: {
      reversedAt: null,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      account: { archivedAt: null },
    },
    orderBy: { occurredAt: 'asc' },
    select: { occurredAt: true },
  });
  return first?.occurredAt ?? null;
}

export interface CostBasis {
  /** What the Bitcoin still held cost, in cents. */
  readonly costCents: Cents;
  /** The satoshis that cost is for — priced acquisitions only. */
  readonly basisSats: Cents;
  /** Satoshis held whose cost is unknown: an opening balance, or a transfer in. */
  readonly unpricedSats: Cents;
}

/**
 * What the holding cost, on average cost basis.
 *
 * Average rather than FIFO or specific-identification. This is a household
 * budget, not a tax return: the figure exists so "worth $50,000" can be read
 * against "cost $31,000", and choosing a lot-matching method would imply a
 * precision the app cannot stand behind for a filing.
 *
 * Satoshis whose cost is not known — an opening balance from before the ledger,
 * a transfer in from another wallet — are reported separately rather than valued
 * at zero. Zero would read as "free", which is a lie in the flattering
 * direction.
 */
export async function costBasis(
  db: Db,
  options: { readonly accountId?: string } = {},
): Promise<CostBasis> {
  const events = await db.bitcoinHoldingEvent.findMany({
    where: {
      reversedAt: null,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      account: { archivedAt: null },
    },
    orderBy: { occurredAt: 'asc' },
    select: { deltaSats: true, priceCents: true, eventType: true },
  });

  let pricedSats = 0n;
  let pricedCost = 0n;
  let unpricedSats = 0n;

  for (const event of events) {
    if (event.deltaSats > 0n) {
      if (event.priceCents === null) {
        unpricedSats += event.deltaSats;
      } else {
        pricedSats += event.deltaSats;
        pricedCost += bitcoinValueCents(event.deltaSats, event.priceCents);
      }
      continue;
    }

    // A disposal reduces both pools in proportion to what they hold, which is
    // what "average cost" means. Taken from the unpriced pool first would flatter
    // the basis; from the priced pool first would flatter it the other way.
    const gone = -event.deltaSats;
    const held = pricedSats + unpricedSats;
    if (held <= 0n) continue;

    const fromPriced = (gone * pricedSats) / held;
    const fromUnpriced = gone - fromPriced;

    if (pricedSats > 0n) {
      pricedCost -= (pricedCost * fromPriced) / pricedSats;
    }
    pricedSats -= fromPriced;
    unpricedSats -= fromUnpriced;
  }

  return { costCents: pricedCost, basisSats: pricedSats, unpricedSats };
}

/**
 * Rebuilds every cached quantity from the ledger, and says which disagreed.
 *
 * The counterpart to `recomputeAllBalances` for delegations, and it exists for
 * the same reason: a cache that nothing can check is a cache nobody can trust.
 */
export async function recomputeHoldings(
  db: Db,
  options: { readonly check?: boolean } = {},
): Promise<{ checked: number; drifted: { accountId: string; cached: Cents; actual: Cents }[] }> {
  const accounts = await db.account.findMany({
    where: { managedAs: 'bitcoin' },
    select: { id: true, bitcoinSats: true },
  });

  const drifted: { accountId: string; cached: Cents; actual: Cents }[] = [];

  for (const account of accounts) {
    const sum = await db.bitcoinHoldingEvent.aggregate({
      where: { accountId: account.id, reversedAt: null },
      _sum: { deltaSats: true },
    });
    const actual = sum._sum.deltaSats ?? 0n;
    const cached = account.bitcoinSats ?? 0n;

    if (actual !== cached) {
      drifted.push({ accountId: account.id, cached, actual });
      if (!options.check) {
        await db.account.update({ where: { id: account.id }, data: { bitcoinSats: actual } });
      }
    }
  }

  return { checked: accounts.length, drifted };
}

/**
 * Sets the total held, by recording the difference as an adjustment.
 *
 * Typing a new total is the fastest way to correct a quantity, and it stays
 * available — but it cannot write `bitcoin_sats` directly any more, because that
 * would put the cache and the ledger out of step and the chart would go back to
 * guessing. The difference becomes a dated event like everything else, so what
 * changed and when is still answerable afterwards.
 */
export async function setHoldingQuantity(
  db: Db,
  accountId: string,
  sats: Cents,
  options: { readonly actorId?: string | null } = {},
  now: Date = new Date(),
): Promise<void> {
  if (sats < 0n) {
    throw new ValidationError('bitcoin_amount_negative', 'A quantity cannot be negative.');
  }

  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { bitcoinSats: true, managedAs: true },
  });
  if (!account) throw new NotFoundError('Account', accountId);
  if (account.managedAs !== 'bitcoin') {
    throw new ConflictError('account_not_managed_here', 'That is not a Bitcoin holding.');
  }

  const difference = sats - (account.bitcoinSats ?? 0n);
  if (difference === 0n) return;

  await recordHoldingEvent(
    db,
    {
      accountId,
      // The first quantity a holding is given is where its history starts;
      // after that, changing the total is a correction to it.
      eventType: (account.bitcoinSats ?? 0n) === 0n ? 'opening' : 'adjustment',
      sats: difference < 0n ? -difference : difference,
      signedSats: difference,
      occurredAt: now,
      note:
        difference < 0n && (account.bitcoinSats ?? 0n) !== 0n ? 'Total corrected downwards.' : null,
      actorId: options.actorId ?? null,
    },
    now,
  );
}
