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
    select: { id: true, name: true, balanceCents: true, archivedAt: true },
  });
  if (!delegation) throw new NotFoundError('Delegation', delegationId);
  if (delegation.archivedAt !== null) return;

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
    select: { id: true, name: true, archivedAt: true },
  });
  if (!grouping) throw new NotFoundError('Grouping', groupingId);
  if (grouping.archivedAt !== null) return;

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
