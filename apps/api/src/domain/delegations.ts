import type { Cents, GroupingSection } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/**
 * Delegations and groupings: creation, renaming, and the settings each carries.
 *
 * Inline creation on the Budget page has to be fast — the owner types roughly
 * sixty of these by hand at go-live with no import — so these are deliberately
 * thin: a name is enough to create one.
 *
 * Balances are not settable here. A balance is the sum of an event stream, so it
 * moves only through `adjust.ts`, `transfer.ts`, `delegate.ts` or a
 * categorization.
 */

const MAX_NAME_LENGTH = 100;

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new ValidationError('empty_name', 'A name is required.');
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      'name_too_long',
      `A name must be at most ${MAX_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/**
 * Names are unique per section case-insensitively, but **only among live rows** —
 * a partial unique index enforces the same rule in the database. Archiving must
 * not permanently reserve a name.
 */
async function assertDelegationNameFree(db: Db, name: string, exceptId?: string): Promise<void> {
  const clash = await db.delegation.findFirst({
    where: {
      archivedAt: null,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError('name_taken', `A delegation named "${name}" already exists.`);
  }
}

async function assertGroupingUsable(
  db: Db,
  groupingId: string,
  expectedSection: GroupingSection,
): Promise<void> {
  const grouping = await db.grouping.findUnique({
    where: { id: groupingId },
    select: { section: true, archivedAt: true },
  });
  if (!grouping) throw new NotFoundError('Grouping', groupingId);
  if (grouping.archivedAt) {
    throw new ConflictError('grouping_archived', 'That grouping is archived.');
  }
  if (grouping.section !== expectedSection) {
    // A delegation inside an assets grouping would appear in the wrong section
    // and be summed into the wrong total.
    throw new ValidationError(
      'wrong_section',
      `That grouping belongs to the ${grouping.section} section.`,
    );
  }
}

/**
 * A target is an amount, optionally by a day.
 *
 * The database holds both of these too. They are here so the refusal says which
 * one it is, rather than surfacing as a constraint name.
 */
function assertTargetSane(
  targetCents: Cents | null,
  targetDate: Date | null,
  intervalMonths: number | null = null,
): void {
  if (targetDate !== null && targetCents === null) {
    throw new ValidationError(
      'target_date_without_amount',
      'A target needs an amount. A date on its own is a deadline for nothing.',
    );
  }
  if (targetCents !== null && targetCents <= 0n) {
    throw new ValidationError(
      'target_not_positive',
      'A target is an amount to reach. Clear it instead of setting it to zero.',
    );
  }
  if (intervalMonths !== null) {
    if (targetDate === null) {
      throw new ValidationError(
        'target_interval_without_date',
        'A repeating target needs a date to repeat from.',
      );
    }
    if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 120) {
      throw new ValidationError(
        'target_interval_out_of_range',
        'A target repeats every 1 to 120 months.',
      );
    }
  }
}

export interface CreateDelegationInput {
  readonly name: string;
  readonly amountToDelegateCents?: Cents | null | undefined;
  readonly groupingId?: string | null | undefined;
  readonly isUtility?: boolean | undefined;
  readonly notes?: string | null | undefined;
  /**
   * What the line is saving towards, and by when. Null on either clears it.
   *
   * The date is optional and turns "keep this much here" into "have this much by
   * then". A date with no amount is refused — it is a deadline for nothing — and
   * the database refuses it too, so a caller that never comes through here
   * cannot write one either.
   */
  readonly targetCents?: Cents | null | undefined;
  readonly targetDate?: Date | null | undefined;
  /** How often the date comes round, in months. Null for a one-off. */
  readonly targetIntervalMonths?: number | null | undefined;
}

export async function createDelegation(
  db: Db,
  input: CreateDelegationInput,
): Promise<{ id: string }> {
  const name = normalizeName(input.name);
  await assertDelegationNameFree(db, name);
  if (input.groupingId) await assertGroupingUsable(db, input.groupingId, 'delegations');
  assertTargetSane(
    input.targetCents ?? null,
    input.targetDate ?? null,
    input.targetIntervalMonths ?? null,
  );

  return db.delegation.create({
    data: {
      name,
      // Null is not zero: null means "ad hoc, add nothing when Delegate is
      // pressed", and the UI shows an empty cell rather than $0.
      amountToDelegateCents: input.amountToDelegateCents ?? null,
      groupingId: input.groupingId ?? null,
      isUtility: input.isUtility ?? false,
      notes: input.notes ?? null,
      targetCents: input.targetCents ?? null,
      targetDate: input.targetDate ?? null,
      targetIntervalMonths: input.targetIntervalMonths ?? null,
    },
    select: { id: true },
  });
}

export interface UpdateDelegationInput {
  readonly name?: string | undefined;
  readonly amountToDelegateCents?: Cents | null | undefined;
  readonly groupingId?: string | null | undefined;
  readonly isUtility?: boolean | undefined;
  readonly notes?: string | null | undefined;
  /**
   * What the line is saving towards, and by when. Null on either clears it.
   *
   * The date is optional and turns "keep this much here" into "have this much by
   * then". A date with no amount is refused — it is a deadline for nothing — and
   * the database refuses it too, so a caller that never comes through here
   * cannot write one either.
   */
  readonly targetCents?: Cents | null | undefined;
  readonly targetDate?: Date | null | undefined;
  /** How often the date comes round, in months. Null for a one-off. */
  readonly targetIntervalMonths?: number | null | undefined;
}

export async function updateDelegation(
  db: Db,
  id: string,
  input: UpdateDelegationInput,
): Promise<void> {
  const existing = await db.delegation.findUnique({
    where: { id },
    select: {
      id: true,
      archivedAt: true,
      kind: true,
      targetCents: true,
      targetDate: true,
      targetIntervalMonths: true,
    },
  });
  if (!existing) throw new NotFoundError('Delegation', id);
  if (existing.archivedAt) {
    throw new ConflictError(
      'delegation_archived',
      'That delegation is archived. Restore it first.',
    );
  }

  // A check's name, amount and grouping are all consequences of the check
  // itself. Editing them here would let the line disagree with what was written.
  if (existing.kind === 'check') {
    throw new ConflictError(
      'delegation_is_a_check',
      'An outstanding check is not edited. Void it and write it again if it was wrong.',
    );
  }

  const name = input.name === undefined ? undefined : normalizeName(input.name);
  if (name !== undefined) await assertDelegationNameFree(db, name, id);
  if (input.groupingId) await assertGroupingUsable(db, input.groupingId, 'delegations');

  /*
   * The target, resolved once as the three values that will actually be
   * written, and then both validated and written from that.
   *
   * Doing it any other way is how this went wrong twice. A target is three
   * fields that constrain each other — an amount, a date, and what repeats the
   * date — and a request usually mentions one of them. Validating the field
   * that arrived refuses "remove this target"; writing the field that arrived
   * while validating something else lets a request past the domain and into a
   * check constraint, which then reports itself as a Prisma error rather than
   * as a sentence.
   */
  const nextTargetCents =
    input.targetCents === undefined ? existing.targetCents : input.targetCents;

  // Clearing the amount clears the date with it: removing a target means the
  // whole target, and a date with no amount is a deadline for nothing.
  const nextTargetDate =
    input.targetCents === null
      ? null
      : input.targetDate === undefined
        ? existing.targetDate
        : input.targetDate;

  // And clearing the date clears what repeats it. An interval the caller asked
  // for explicitly is kept here rather than dropped, so that asking to repeat a
  // target that has no date is *refused* — silently ignoring it would answer
  // 200 to a request that did not happen.
  const nextTargetInterval =
    input.targetIntervalMonths !== undefined
      ? input.targetIntervalMonths
      : nextTargetDate === null
        ? null
        : existing.targetIntervalMonths;

  assertTargetSane(nextTargetCents, nextTargetDate, nextTargetInterval);

  await db.delegation.update({
    where: { id },
    data: {
      ...(name === undefined ? {} : { name }),
      ...(input.amountToDelegateCents === undefined
        ? {}
        : { amountToDelegateCents: input.amountToDelegateCents }),
      ...(input.groupingId === undefined ? {} : { groupingId: input.groupingId }),
      ...(input.isUtility === undefined ? {} : { isUtility: input.isUtility }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      // All three, always, from the values resolved above. A request that
      // mentions none of them rewrites them to what it just read, which is a
      // no-op — and one that mentions any of them cannot leave the other two
      // saying something the validation never saw.
      targetCents: nextTargetCents,
      targetDate: nextTargetDate,
      targetIntervalMonths: nextTargetInterval,
    },
  });
}

export interface CreateGroupingInput {
  readonly name: string;
  readonly section: GroupingSection;
  readonly color?: string | null | undefined;
}

export async function createGrouping(db: Db, input: CreateGroupingInput): Promise<{ id: string }> {
  const name = normalizeName(input.name);

  const clash = await db.grouping.findFirst({
    where: {
      archivedAt: null,
      section: input.section,
      name: { equals: name, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(
      'name_taken',
      `A grouping named "${name}" already exists in that section.`,
    );
  }

  return db.grouping.create({
    data: { name, section: input.section, color: input.color ?? null },
    select: { id: true },
  });
}

export interface UpdateGroupingInput {
  readonly name?: string | undefined;
  readonly color?: string | null | undefined;
  readonly collapsed?: boolean | undefined;
}

export async function updateGrouping(
  db: Db,
  id: string,
  input: UpdateGroupingInput,
): Promise<void> {
  const existing = await db.grouping.findUnique({
    where: { id },
    select: { id: true, section: true, archivedAt: true, systemKey: true },
  });
  if (!existing) throw new NotFoundError('Grouping', id);
  if (existing.archivedAt) {
    throw new ConflictError('grouping_archived', 'That grouping is archived. Restore it first.');
  }

  // Collapsing it is a view preference and stays available; its name and colour
  // are the application's, and renaming it would break nothing except the
  // reader's understanding of what the section is.
  if (existing.systemKey !== null && (input.name !== undefined || input.color !== undefined)) {
    throw new ConflictError(
      'grouping_is_system_owned',
      'That grouping is managed by the budget itself and cannot be renamed.',
    );
  }

  const name = input.name === undefined ? undefined : normalizeName(input.name);
  if (name !== undefined) {
    const clash = await db.grouping.findFirst({
      where: {
        archivedAt: null,
        section: existing.section,
        name: { equals: name, mode: 'insensitive' },
        id: { not: id },
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        'name_taken',
        `A grouping named "${name}" already exists in that section.`,
      );
    }
  }

  await db.grouping.update({
    where: { id },
    data: {
      ...(name === undefined ? {} : { name }),
      ...(input.color === undefined ? {} : { color: input.color }),
      // Collapsed state is per-grouping rather than per-user: one household, one
      // shared budget, and a shared view is what the owner expects.
      ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
    },
  });
}

/**
 * Puts a delegation somewhere, in one move.
 *
 * Both halves at once — which grouping it belongs to, and where it sits among
 * that grouping's lines — because dragging a row does both and doing them as
 * two writes would show the page an intermediate state that nobody asked for.
 *
 * `orderedIds` is the grouping's full membership afterwards, in order. A
 * partial order would silently leave rows where they were, which reads as the
 * drop having been ignored; and computing the gap arithmetic on the server from
 * a complete list is the only version of this that cannot drift.
 */
export async function placeDelegation(
  db: Db,
  input: {
    readonly delegationId: string;
    readonly groupingId: string | null;
    readonly orderedIds: readonly string[];
  },
): Promise<void> {
  const moving = await db.delegation.findUnique({
    where: { id: input.delegationId },
    select: { id: true, archivedAt: true },
  });
  if (!moving || moving.archivedAt) {
    throw new NotFoundError('Delegation', input.delegationId);
  }

  if (input.groupingId !== null) {
    const grouping = await db.grouping.findUnique({
      where: { id: input.groupingId },
      select: { id: true, section: true, archivedAt: true },
    });
    if (!grouping || grouping.archivedAt) {
      throw new NotFoundError('Grouping', input.groupingId);
    }
    if (grouping.section !== 'delegations') {
      throw new ValidationError(
        'wrong_section',
        'A delegation can only be filed under a grouping in the Delegations section.',
      );
    }
  }

  if (!input.orderedIds.includes(input.delegationId)) {
    throw new ValidationError(
      'incomplete_order',
      'The new order must include the delegation being moved.',
    );
  }

  const live = await db.delegation.findMany({
    where: { id: { in: [...input.orderedIds] }, archivedAt: null },
    select: { id: true },
  });
  if (live.length !== new Set(input.orderedIds).size) {
    throw new ValidationError(
      'unknown_delegation',
      'The new order names a delegation that does not exist.',
    );
  }

  // Gaps of ten, as the rules table does: inserting between two neighbours
  // later does not have to renumber everything.
  for (const [index, id] of input.orderedIds.entries()) {
    await db.delegation.update({
      where: { id },
      data: {
        position: (index + 1) * 10,
        ...(id === input.delegationId ? { groupingId: input.groupingId } : {}),
      },
    });
  }
}

/**
 * Puts the groupings of one section in an order.
 *
 * The whole order for that section, for the reason `placeDelegation` takes one:
 * a direction races, a list cannot. Restricted to a section because the three
 * are independent lists that happen to share a table — reordering Assets must
 * not renumber Delegations underneath somebody.
 */
export async function reorderGroupings(
  db: Db,
  section: GroupingSection,
  orderedIds: readonly string[],
): Promise<void> {
  const live = await db.grouping.findMany({
    where: { archivedAt: null, section },
    select: { id: true, systemKey: true },
  });

  /*
   * The application's own groupings are not moved.
   *
   * Outstanding checks sort last by rule rather than by position — they are
   * where the budget puts money that has left in paper form, not a heading
   * anybody filed anything under — so they are excluded here rather than
   * silently renumbered into the middle.
   */
  const movable = live.filter((grouping) => grouping.systemKey === null).map((row) => row.id);
  const wanted = new Set(orderedIds);

  if (orderedIds.length !== movable.length || movable.some((id) => !wanted.has(id))) {
    // A partial order would leave groupings where they were, which reads as the
    // reorder having been ignored.
    throw new ValidationError(
      'incomplete_order',
      'Reordering must list every grouping in the section exactly once.',
    );
  }

  for (const [index, id] of orderedIds.entries()) {
    await db.grouping.update({ where: { id }, data: { position: (index + 1) * 10 } });
  }
}
