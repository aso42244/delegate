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
function assertTargetSane(targetCents: Cents | null, targetDate: Date | null): void {
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
}

export async function createDelegation(
  db: Db,
  input: CreateDelegationInput,
): Promise<{ id: string }> {
  const name = normalizeName(input.name);
  await assertDelegationNameFree(db, name);
  if (input.groupingId) await assertGroupingUsable(db, input.groupingId, 'delegations');
  assertTargetSane(input.targetCents ?? null, input.targetDate ?? null);

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
}

export async function updateDelegation(
  db: Db,
  id: string,
  input: UpdateDelegationInput,
): Promise<void> {
  const existing = await db.delegation.findUnique({
    where: { id },
    select: { id: true, archivedAt: true, kind: true, targetCents: true, targetDate: true },
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
   * Checked as the pair it will be, not as the field that arrived. Clearing an
   * amount sends one key and the date the other, and validating either alone
   * would refuse the only request that is actually right.
   */
  const nextTargetCents =
    input.targetCents === undefined ? existing.targetCents : input.targetCents;
  assertTargetSane(
    nextTargetCents,
    // Clearing the amount clears the date with it, so the pair validated here
    // has to be the pair that will be written. Checking the stored date against
    // a cleared amount refuses the one request that is unambiguously right:
    // "remove this target".
    //
    // An *explicit* null, not merely an absent one: a request that sets a date
    // on a line which has no target is still a deadline for nothing, and must
    // be refused with a sentence rather than by a constraint name.
    input.targetCents === null
      ? null
      : input.targetDate === undefined
        ? existing.targetDate
        : input.targetDate,
  );

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
      ...(input.targetCents === undefined ? {} : { targetCents: input.targetCents }),
      // Clearing the amount clears the date with it: a deadline for nothing is
      // the state the check constraint exists to prevent, and somebody removing
      // a target means the whole target.
      ...(input.targetCents === null ? { targetDate: null } : {}),
      ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
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
