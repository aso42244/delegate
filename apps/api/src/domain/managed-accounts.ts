import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { clearBudgetValue, revalueBitcoinHoldings } from './bitcoin.js';
import { recordValuation } from './valuations.js';

/**
 * Bitcoin holdings and properties, created where they are managed.
 *
 * Both are ordinary rows in `accounts` — the identity, the budget read model,
 * the net worth chart and the equity netting all read that table, and giving
 * either its own home would mean reimplementing every one of them. What lives
 * here is the *lifecycle*: their own Settings tab creates and retires them, so
 * neither is ever typed into Settings → Accounts as a second step.
 *
 * The guard runs in both directions. Settings → Accounts refuses to create a
 * managed row, and this refuses to touch an unmanaged one, so an account can
 * only ever be edited where it is understood.
 */

async function requireManaged(
  db: Db,
  id: string,
  managedAs: 'bitcoin' | 'property',
): Promise<{ id: string; inBudget: boolean; archivedAt: Date | null }> {
  const account = await db.account.findUnique({
    where: { id },
    select: { id: true, managedAs: true, inBudget: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', id);
  if (account.managedAs !== managedAs) {
    throw new ConflictError(
      'account_not_managed_here',
      managedAs === 'bitcoin' ? 'That is not a Bitcoin holding.' : 'That is not a property.',
    );
  }
  return { id: account.id, inBudget: account.inBudget, archivedAt: account.archivedAt };
}

function cleanName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new ValidationError('empty_name', `A ${what} needs a name.`);
  return trimmed;
}

export interface CreateHoldingInput {
  readonly name: string;
  readonly sats?: bigint | undefined;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
}

/**
 * A Bitcoin holding, and the account behind it, in one act.
 *
 * Net worth only by default. A holding in the budget makes the top banner move
 * with the market rather than with spending, so it is a deliberate choice rather
 * than the path of least resistance — see `revalueBitcoinHoldings`.
 */
export async function createHolding(
  db: Db,
  input: CreateHoldingInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  const created = await db.account.create({
    data: {
      name: cleanName(input.name, 'holding'),
      type: 'asset',
      source: 'manual',
      managedAs: 'bitcoin',
      bitcoinSats: input.sats ?? 0n,
      balanceCents: 0n,
      inBudget: input.inBudget ?? false,
      inNetWorth: input.inNetWorth ?? true,
      stalenessIntervalDays: input.stalenessIntervalDays ?? null,
      balanceAsOf: now,
    },
    select: { id: true },
  });

  // Valued immediately rather than at the next daily pass: a holding that read
  // $0.00 for its first day would look like a bug, and would be one.
  await revalueBitcoinHoldings(db, { force: true, accountId: created.id }, now);
  return created;
}

export interface UpdateHoldingInput {
  readonly name?: string | undefined;
  readonly sats?: bigint | undefined;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
}

export async function updateHolding(
  db: Db,
  id: string,
  input: UpdateHoldingInput,
  now: Date = new Date(),
): Promise<void> {
  const existing = await requireManaged(db, id, 'bitcoin');
  if (existing.archivedAt) {
    throw new ConflictError('account_archived', 'That holding is archived. Restore it first.');
  }

  await db.account.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: cleanName(input.name, 'holding') }),
      // Typing a quantity is confirming it, which is what staleness counts from.
      ...(input.sats === undefined ? {} : { bitcoinSats: input.sats, balanceAsOf: now }),
      ...(input.inBudget === undefined ? {} : { inBudget: input.inBudget }),
      ...(input.inNetWorth === undefined ? {} : { inNetWorth: input.inNetWorth }),
      ...(input.stalenessIntervalDays === undefined
        ? {}
        : { stalenessIntervalDays: input.stalenessIntervalDays }),
    },
  });

  // Both edits make yesterday's dollar figure visibly wrong, so neither waits
  // for the daily pass. Dropping out of the budget clears it instead: left
  // behind, it would go on contributing to the identity after the toggle said
  // it should not.
  if (input.inBudget === false) {
    await clearBudgetValue(db, id);
  } else if (input.sats !== undefined || input.inBudget === true) {
    await revalueBitcoinHoldings(db, { force: true, accountId: id }, now);
  }
}

export interface CreatePropertyInput {
  readonly name: string;
  readonly valueCents: bigint;
  readonly asOf: Date;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly mortgageAccountId?: string | null | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
  readonly actorId?: string | null | undefined;
}

/**
 * A property, its first valuation, and optionally the mortgage against it.
 *
 * The valuation is not an afterthought: a property with no value is a row that
 * reads $0 on the net worth chart, so the opening figure is part of creating it.
 */
export async function createProperty(
  db: Db,
  input: CreatePropertyInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  if (input.valueCents < 0n) {
    throw new ValidationError('valuation_negative', 'A value cannot be negative.');
  }

  const created = await db.account.create({
    data: {
      name: cleanName(input.name, 'property'),
      type: 'asset',
      source: 'manual',
      managedAs: 'property',
      balanceCents: input.valueCents,
      // A house is not spendable. It can be put in the budget, but saying so has
      // to be deliberate.
      inBudget: input.inBudget ?? false,
      inNetWorth: input.inNetWorth ?? true,
      mortgageAccountId: input.mortgageAccountId ?? null,
      stalenessIntervalDays: input.stalenessIntervalDays ?? null,
      balanceAsOf: now,
    },
    select: { id: true },
  });

  await recordValuation(db, {
    accountId: created.id,
    valueCents: input.valueCents,
    asOf: input.asOf,
    actorId: input.actorId ?? null,
  });

  return created;
}

export interface UpdatePropertyInput {
  readonly name?: string | undefined;
  readonly inBudget?: boolean | undefined;
  readonly inNetWorth?: boolean | undefined;
  readonly mortgageAccountId?: string | null | undefined;
  readonly stalenessIntervalDays?: number | null | undefined;
}

export async function updateProperty(
  db: Db,
  id: string,
  input: UpdatePropertyInput,
): Promise<void> {
  const existing = await requireManaged(db, id, 'property');
  if (existing.archivedAt) {
    throw new ConflictError('account_archived', 'That property is archived. Restore it first.');
  }

  if (input.mortgageAccountId) {
    const mortgage = await db.account.findUnique({
      where: { id: input.mortgageAccountId },
      select: { type: true },
    });
    if (!mortgage) throw new NotFoundError('Account', input.mortgageAccountId);
    if (mortgage.type !== 'debt') {
      throw new ValidationError(
        'mortgage_not_a_debt',
        'A mortgage is a debt account. Equity is the property value minus what is owed on it.',
      );
    }
  }

  await db.account.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: cleanName(input.name, 'property') }),
      ...(input.inBudget === undefined ? {} : { inBudget: input.inBudget }),
      ...(input.inNetWorth === undefined ? {} : { inNetWorth: input.inNetWorth }),
      ...(input.mortgageAccountId === undefined
        ? {}
        : { mortgageAccountId: input.mortgageAccountId }),
      ...(input.stalenessIntervalDays === undefined
        ? {}
        : { stalenessIntervalDays: input.stalenessIntervalDays }),
    },
  });
}
