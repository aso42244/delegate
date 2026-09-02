import { formatCents, type Cents } from '@budget/shared';
import type { AccountType } from '@prisma/client';
import { localDayKey } from './calendar.js';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * How a transaction moves the account it belongs to.
 *
 * Balances are stored as positive magnitudes for both assets and debts, and
 * transaction amounts are signed with negative meaning money out. Those two
 * conventions pull in opposite directions on a debt:
 *
 *   * Asset: a −$50 charge lowers the balance.       delta = amount
 *   * Debt:  a −$50 charge *raises* what is owed.    delta = −amount
 *
 * Getting this backwards would keep the identity balanced while showing every
 * card balance with the wrong sign, so it lives in one function with one test
 * rather than being re-derived at each call site.
 *
 * The identity is unaffected either way: a card charge raises debts by $50 and
 * lowers the categorized envelope by $50, and the two cancel.
 */
export function accountBalanceDelta(type: AccountType, amountCents: Cents): Cents {
  switch (type) {
    case 'asset':
      return amountCents;
    case 'debt':
      return -amountCents;
  }
}

/**
 * Applies a transaction's effect to its account's cached balance, and stamps
 * `balance_as_of` so staleness reflects the most recent confirmed movement.
 */
export async function applyTransactionToAccountBalance(
  db: Db,
  accountId: string,
  amountCents: Cents,
  asOf: Date,
): Promise<{ balanceCents: Cents }> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, type: true },
  });
  if (!account) throw new NotFoundError('Account', accountId);

  const updated = await db.account.update({
    where: { id: accountId },
    data: {
      balanceCents: { increment: accountBalanceDelta(account.type, amountCents) },
      balanceAsOf: asOf,
    },
    select: { balanceCents: true },
  });
  return { balanceCents: updated.balanceCents };
}

export interface CreateAccountInput {
  readonly nickname?: string | null | undefined;
  readonly name: string;
  readonly type: AccountType;
  readonly balanceCents: Cents;
  // `| undefined` throughout, because `exactOptionalPropertyTypes` is on and a
  // parsed request body carries explicit undefined for an omitted field.
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
  readonly groupingId?: string | null | undefined;
}

/**
 * Creates an account the owner keeps by hand.
 *
 * Only manual accounts are created here. A SimpleFIN account is discovered by a
 * sync, which owns its external id — creating one here would produce a row the
 * feed could never match, and then a duplicate the first time it synced.
 */
export async function createManualAccount(
  db: Db,
  input: CreateAccountInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name === '') throw new ValidationError('empty_name', 'An account needs a name.');

  return db.account.create({
    data: {
      name,
      type: input.type,
      source: 'manual',
      balanceCents: input.balanceCents,
      inBudget: input.inBudget ?? true,
      inNetWorth: input.inNetWorth ?? true,
      stalenessIntervalDays: input.stalenessIntervalDays ?? null,
      groupingId: input.groupingId ?? null,
      // The balance was just confirmed by being typed in.
      balanceAsOf: now,
    },
    select: { id: true },
  });
}

export interface UpdateAccountInput {
  readonly name?: string | undefined;
  /** Empty is stored as null: a blank nickname is the absence of one. */
  readonly nickname?: string | null | undefined;
  readonly type?: AccountType | undefined;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
  readonly groupingId?: string | null | undefined;
  readonly needsReview?: boolean | undefined;
  /** Manual accounts only. Sets the balance outright and stamps it as of now. */
  readonly balanceCents?: Cents | undefined;
  /** Recorded on the dated valuation a balance edit writes, when there is one. */
  readonly actorId?: string | null | undefined;
  /** The mortgage secured against this property, if it is one. */
  readonly mortgageAccountId?: string | null | undefined;
  /**
   * The household's zone, for the date a typed balance is filed under.
   *
   * Required rather than defaulted to UTC even though only a balance edit reads
   * it: a default would let a call site that forgot it file an evening's edit
   * under tomorrow, silently and only in the winter half of the year. A missing
   * argument should be a build error. See ADR 037.
   */
  readonly timeZone: string;
}

/**
 * Edits an account.
 *
 * The balance is the one field that is not universally editable. A SimpleFIN
 * account's balance is whatever the institution last reported, and the next sync
 * would overwrite anything typed here — so accepting it would be a lie that
 * corrects itself within the hour, which is worse than refusing.
 */
export async function updateAccount(
  db: Db,
  id: string,
  input: UpdateAccountInput,
  now: Date = new Date(),
): Promise<void> {
  const account = await db.account.findUnique({
    where: { id },
    select: { id: true, source: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', id);
  if (account.archivedAt) {
    throw new ConflictError('account_archived', 'That account is archived. Restore it first.');
  }

  if (input.balanceCents !== undefined && account.source !== 'manual') {
    throw new ConflictError(
      'balance_not_editable',
      'This balance comes from SimpleFIN and the next sync would overwrite it. Record a transaction instead.',
    );
  }

  if (input.name !== undefined && input.name.trim() === '') {
    throw new ValidationError('empty_name', 'An account needs a name.');
  }

  if (
    input.stalenessIntervalDays !== undefined &&
    input.stalenessIntervalDays !== null &&
    (!Number.isInteger(input.stalenessIntervalDays) || input.stalenessIntervalDays < 1)
  ) {
    throw new ValidationError(
      'staleness_interval_invalid',
      'A staleness interval is a whole number of days, at least one. Leave it empty for never.',
    );
  }

  await db.account.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.nickname === undefined
        ? {}
        : { nickname: input.nickname?.trim() ? input.nickname.trim() : null }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.inBudget === undefined ? {} : { inBudget: input.inBudget }),
      ...(input.inNetWorth === undefined ? {} : { inNetWorth: input.inNetWorth }),
      ...(input.stalenessIntervalDays === undefined
        ? {}
        : { stalenessIntervalDays: input.stalenessIntervalDays }),
      ...(input.groupingId === undefined ? {} : { groupingId: input.groupingId }),
      ...(input.needsReview === undefined ? {} : { needsReview: input.needsReview }),
      ...(input.mortgageAccountId === undefined
        ? {}
        : { mortgageAccountId: input.mortgageAccountId }),
      // Typing a balance is confirming it, so the staleness clock restarts.
      ...(input.balanceCents === undefined
        ? {}
        : { balanceCents: input.balanceCents, balanceAsOf: now }),
    },
  });

  /*
   * A balance typed by hand is also a dated valuation.
   *
   * `balance_as_of` is one timestamp, overwritten on every edit, so it can say
   * when a value was last confirmed and never what the value was in March. Only
   * properties had a history, because only they went through `recordValuation` —
   * which left cash, River and Strike with no dated history at all, and the
   * snapshot gap-filler with nothing to carry forward for them.
   *
   * Upserted on today's date so two edits in one day leave one row saying what
   * it finally settled at, rather than a history of somebody's typing.
   *
   * Today *here*: `now` is an instant and `as_of` is a calendar day, so the
   * conversion takes the household's zone. Truncated in UTC, a balance typed at
   * eight in the evening landed on tomorrow — which put the valuation a day
   * ahead of the snapshot meant to carry it, so the day it was typed on read the
   * old figure.
   */
  if (input.balanceCents !== undefined && account.source === 'manual') {
    const asOf = localDayKey(now, input.timeZone);
    await db.accountValuation.upsert({
      where: { accountId_asOf: { accountId: id, asOf } },
      create: {
        accountId: id,
        valueCents: input.balanceCents,
        asOf,
        actorId: input.actorId ?? null,
      },
      update: { valueCents: input.balanceCents, actorId: input.actorId ?? null },
    });
  }
}

/**
 * Archives an account.
 *
 * Blocked while an **in-budget** account still holds a balance, because the
 * identity subtracts what the accounts hold: archiving $400 of real money would
 * shift the bottom line by $400 with nothing on screen to explain it, exactly as
 * archiving a delegation with money in it would.
 *
 * An off-budget account — the house, the mortgage — is not part of that sum, so
 * there is nothing to protect and it archives at any balance.
 */
export async function archiveAccount(db: Db, id: string, now: Date = new Date()): Promise<void> {
  const account = await db.account.findUnique({
    where: { id },
    select: { id: true, name: true, balanceCents: true, inBudget: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', id);
  if (account.archivedAt) return;

  if (account.inBudget && account.balanceCents !== 0n) {
    throw new ConflictError(
      'account_balance_not_zero',
      `${account.name} still holds ${formatCents(account.balanceCents)} and is in the budget. Move the money out, or take it out of the budget first.`,
      { accountId: id, balanceCents: account.balanceCents.toString() },
    );
  }

  await db.account.update({ where: { id }, data: { archivedAt: now } });
}

export async function restoreAccount(db: Db, id: string): Promise<void> {
  const account = await db.account.findUnique({ where: { id }, select: { id: true } });
  if (!account) throw new NotFoundError('Account', id);

  await db.account.update({ where: { id }, data: { archivedAt: null } });
}

/**
 * Equity on a property that references a mortgage: property value minus what is
 * still owed. Computed on read, never stored — a stored copy would drift from
 * the mortgage balance on every payment.
 */
export async function computeEquityCents(db: Db, propertyAccountId: string): Promise<Cents | null> {
  const property = await db.account.findUnique({
    where: { id: propertyAccountId },
    select: {
      balanceCents: true,
      mortgageAccount: { select: { balanceCents: true } },
    },
  });
  if (!property) throw new NotFoundError('Account', propertyAccountId);
  if (!property.mortgageAccount) return null;

  return property.balanceCents - property.mortgageAccount.balanceCents;
}

/**
 * Puts an account in a place: which grouping it belongs to, and where among its
 * neighbours it sits.
 *
 * The same shape as `placeDelegation`, and deliberately so — the whole order is
 * sent rather than a direction or an index, because a list is the only
 * description of an ordering that cannot be interpreted two ways. A "move up"
 * that races another tab's "move down" produces a state neither person asked
 * for; a whole order applied at once cannot.
 */
export async function placeAccount(
  db: Db,
  input: {
    readonly accountId: string;
    readonly groupingId: string | null;
    readonly orderedIds: readonly string[];
  },
): Promise<void> {
  const moving = await db.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, type: true, archivedAt: true },
  });
  if (!moving || moving.archivedAt) throw new NotFoundError('Account', input.accountId);

  if (input.groupingId !== null) {
    const grouping = await db.grouping.findUnique({
      where: { id: input.groupingId },
      select: { id: true, section: true, archivedAt: true },
    });
    if (!grouping || grouping.archivedAt) throw new NotFoundError('Grouping', input.groupingId);

    /*
     * An asset cannot be filed under a debt heading, and the reverse.
     *
     * The section a row sits in *is* its type on this page — Settings → Accounts
     * deleted the Type column on exactly that ground — so allowing the two to
     * disagree would make the page state something untrue about the account.
     */
    const wanted = moving.type === 'asset' ? 'assets' : 'debts';
    if (grouping.section !== wanted) {
      // "An asset", not "A asset". The article is written out rather than
      // interpolated because there are exactly two of these and one of them
      // needs the other article.
      const subject = moving.type === 'asset' ? 'An asset' : 'A debt';
      throw new ValidationError(
        'wrong_section',
        `${subject} can only be filed under a grouping in the ${wanted} section.`,
      );
    }
  }

  if (!input.orderedIds.includes(input.accountId)) {
    throw new ValidationError(
      'incomplete_order',
      'The new order must include the account being moved.',
    );
  }

  const live = await db.account.findMany({
    where: { id: { in: [...input.orderedIds] }, archivedAt: null },
    select: { id: true },
  });
  if (live.length !== new Set(input.orderedIds).size) {
    throw new ValidationError(
      'unknown_account',
      'The new order names an account that does not exist.',
    );
  }

  // Gaps of ten, as delegations and rules use: inserting between two neighbours
  // later does not have to renumber everything.
  for (const [index, id] of input.orderedIds.entries()) {
    await db.account.update({
      where: { id },
      data: {
        position: (index + 1) * 10,
        ...(id === input.accountId ? { groupingId: input.groupingId } : {}),
      },
    });
  }
}
