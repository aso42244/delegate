import { formatCents } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError } from './errors.js';

/**
 * Archiving. Nothing is ever hard-deleted.
 *
 * Archived rows stay resolvable everywhere history references them, so an
 * eight-month-old transaction renders "Grocery (archived)" rather than a dangling
 * id, and archived delegations still appear in Utilities and Insights history.
 */

/**
 * A delegation may only be archived at exactly $0.
 *
 * Archiving a line with money in it would silently break the identity by the
 * archived balance — the money would still be in an account but no longer
 * accounted for by any envelope. The error carries the balance so the UI can
 * offer Transfer and Adjust inline instead of sending the owner elsewhere.
 */
export async function archiveDelegation(
  db: Db,
  delegationId: string,
  options: { readonly now?: Date } = {},
): Promise<void> {
  const delegation = await db.delegation.findUnique({
    where: { id: delegationId },
    select: { id: true, name: true, balanceCents: true, archivedAt: true, kind: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', delegationId);
  if (delegation.archivedAt !== null) return;

  // A check is settled by matching it to the payment that cashed it, or voided
  // if it never will be. Archiving one directly would leave the money it holds
  // with nowhere to have gone.
  if (delegation.kind === 'check') {
    throw new ConflictError(
      'delegation_is_a_check',
      `${delegation.name} is an outstanding check. Match it to the payment that cashed it, or void it.`,
      { delegationId },
    );
  }

  // Settling a check allocates the payment to the delegation it was drawn on,
  // and an allocation cannot name an archived line. A delegation sits at zero
  // once its check is written, so without this it would look archivable right up
  // until the check cleared and had nowhere to go.
  const outstandingChecks = await db.delegation.count({
    where: { kind: 'check', archivedAt: null, checkSourceDelegationId: delegationId },
  });
  if (outstandingChecks > 0) {
    throw new ConflictError(
      'delegation_has_outstanding_checks',
      `${delegation.name} has ${outstandingChecks} outstanding check(s) drawn on it. Settle or void them first.`,
      { delegationId, outstandingChecks },
    );
  }

  if (delegation.balanceCents !== 0n) {
    throw new ConflictError(
      'delegation_balance_not_zero',
      `${delegation.name} still holds ${formatCents(delegation.balanceCents)}. Move it or adjust it to zero first.`,
      {
        delegationId,
        balanceCents: delegation.balanceCents.toString(),
      },
    );
  }

  await db.delegation.update({
    where: { id: delegationId },
    data: { archivedAt: options.now ?? new Date() },
  });
}

/** A grouping may only be archived when it holds nothing live. */
export async function archiveGrouping(
  db: Db,
  groupingId: string,
  options: { readonly now?: Date } = {},
): Promise<void> {
  const grouping = await db.grouping.findUnique({
    where: { id: groupingId },
    select: { id: true, name: true, archivedAt: true, systemKey: true },
  });
  if (!grouping) throw new NotFoundError('Grouping', groupingId);
  if (grouping.archivedAt !== null) return;

  // The application owns this one and re-creates it on demand; archiving it
  // would be undone by the next check written.
  if (grouping.systemKey !== null) {
    throw new ConflictError(
      'grouping_is_system_owned',
      `${grouping.name} is managed by the budget itself and cannot be archived.`,
      { groupingId },
    );
  }

  const [delegations, accounts] = await Promise.all([
    db.delegation.count({ where: { groupingId, archivedAt: null } }),
    db.account.count({ where: { groupingId, archivedAt: null } }),
  ]);
  if (delegations + accounts > 0) {
    throw new ConflictError(
      'grouping_not_empty',
      `${grouping.name} still contains ${delegations + accounts} live item(s). Move them out first.`,
      { groupingId, delegationCount: delegations, accountCount: accounts },
    );
  }

  await db.grouping.update({
    where: { id: groupingId },
    data: { archivedAt: options.now ?? new Date() },
  });
}

/**
 * Archiving an account leaves its transactions in place and resolvable. The
 * account drops out of the identity because every aggregate filters on
 * `archivedAt: null` — which is correct: an archived account is one the household
 * no longer holds, so its balance should no longer be claimed by an envelope.
 */
export async function archiveAccount(
  db: Db,
  accountId: string,
  options: { readonly now?: Date } = {},
): Promise<void> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, archivedAt: true },
  });
  if (!account) throw new NotFoundError('Account', accountId);
  if (account.archivedAt !== null) return;

  await db.account.update({
    where: { id: accountId },
    data: { archivedAt: options.now ?? new Date() },
  });
}

/** Restore, offered from Settings → Archived. */
export interface ArchivedEntities {
  readonly accounts: { id: string; name: string; archivedAt: Date | null; type: string }[];
  readonly delegations: { id: string; name: string; archivedAt: Date | null }[];
  readonly groupings: { id: string; name: string; archivedAt: Date | null; section: string }[];
}

/**
 * Everything currently archived, for Settings → Archived.
 *
 * Transactions are excluded on purpose. An archived transaction is a pending row
 * that vanished or one entered by mistake, and there are potentially thousands
 * of them — restoring one individually is not a thing the owner needs, while a
 * list of entities he might genuinely want back is.
 */
export async function listArchivedEntities(db: Db): Promise<ArchivedEntities> {
  const [accounts, delegations, groupings] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: { not: null } },
      select: { id: true, name: true, archivedAt: true, type: true },
      orderBy: { name: 'asc' },
    }),
    db.delegation.findMany({
      where: { archivedAt: { not: null } },
      select: { id: true, name: true, archivedAt: true },
      orderBy: { name: 'asc' },
    }),
    db.grouping.findMany({
      where: { archivedAt: { not: null } },
      select: { id: true, name: true, archivedAt: true, section: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return { accounts, delegations, groupings };
}

export async function restoreDelegation(db: Db, delegationId: string): Promise<void> {
  const delegation = await db.delegation.findUnique({
    where: { id: delegationId },
    select: { id: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', delegationId);
  await db.delegation.update({ where: { id: delegationId }, data: { archivedAt: null } });
}

export async function restoreGrouping(db: Db, groupingId: string): Promise<void> {
  const grouping = await db.grouping.findUnique({
    where: { id: groupingId },
    select: { id: true },
  });
  if (!grouping) throw new NotFoundError('Grouping', groupingId);
  await db.grouping.update({ where: { id: groupingId }, data: { archivedAt: null } });
}

export async function restoreAccount(db: Db, accountId: string): Promise<void> {
  const account = await db.account.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw new NotFoundError('Account', accountId);
  await db.account.update({ where: { id: accountId }, data: { archivedAt: null } });
}
