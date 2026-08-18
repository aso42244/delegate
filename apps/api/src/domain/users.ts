import { canModifyUser, type UserRole } from '@budget/shared';
import type { Db } from '../db/client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from './passwords.js';

/**
 * User accounts, roles, and the login check.
 *
 * The permission model is two predicates in @budget/shared and nothing else:
 * only user management is gated, and a Super Admin can only be modified by a
 * Super Admin. Resist growing a matrix here.
 */

/** The shape safe to send to a client. A password hash must never leave this module. */
export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  role: true,
  mustChangePassword: true,
  lastLoginAt: true,
  archivedAt: true,
  createdAt: true,
} as const;

/**
 * Usernames are matched case-insensitively at login, so they are stored
 * lower-cased. Without this, "Andy" and "andy" are two accounts and the second
 * one to be created wins the confusion.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Deliberately permissive: a plain handle or an email address both work, because
 * an email is what most people reach for and rejecting it is an irritation with
 * nothing behind it.
 *
 * This is not an email validator. A username is an identifier the household
 * chooses, not an address anything is ever sent to — nothing in this system
 * emails anyone — so validating RFC 5322 would buy nothing and reject addresses
 * that are perfectly legal. It checks only that the value is a sane, storable
 * identifier. 254 characters is the maximum length of an email address.
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._+@-]{1,253}$/;

export function assertUsernameAcceptable(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError(
      'invalid_username',
      'Username must be 2–254 characters, start with a letter or digit, and use only letters, digits and . _ + - @ — an email address is fine.',
    );
  }
}

/**
 * True when no usable account exists and the first-run setup screen should be
 * shown. Archived users count: an archived-only database is a locked-out one,
 * and silently offering to mint a fresh Super Admin would be a way back in for
 * anyone who can reach the LAN.
 */
export async function needsFirstRunSetup(db: Db): Promise<boolean> {
  return (await db.user.count()) === 0;
}

export interface CreateFirstUserInput {
  readonly username: string;
  readonly password: string;
}

/**
 * Creates the first account, which becomes Super Admin.
 *
 * Serialised with a transaction-scoped advisory lock. Two setup requests racing
 * on an empty database would both see a count of zero and both create a Super
 * Admin; the unique index on username would not stop them, because they can pick
 * different names. The lock makes the check-then-insert atomic.
 */
export async function createFirstUser(db: Db, input: CreateFirstUserInput): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  assertUsernameAcceptable(username);
  const passwordHash = await hashPassword(input.password);

  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('household-budget:first-run-setup'))`;

  if (!(await needsFirstRunSetup(db))) {
    throw new ConflictError(
      'setup_already_complete',
      'This budget already has an account. Ask an administrator to create yours.',
    );
  }

  return db.user.create({
    data: { username, passwordHash, role: 'super_admin', mustChangePassword: false },
    select: PUBLIC_USER_SELECT,
  });
}

export interface CreateUserInput {
  readonly username: string;
  readonly temporaryPassword: string;
  readonly role: UserRole;
}

/** Creates an account on behalf of an Admin. The password is always temporary. */
export async function createUser(
  db: Db,
  actorRole: UserRole,
  input: CreateUserInput,
): Promise<PublicUser> {
  if (!canModifyUser(actorRole, input.role)) {
    throw new ConflictError(
      'forbidden',
      input.role === 'super_admin'
        ? 'Only a Super Admin can create another Super Admin.'
        : 'You do not have permission to create users.',
    );
  }

  const username = normalizeUsername(input.username);
  assertUsernameAcceptable(username);
  const passwordHash = await hashPassword(input.temporaryPassword);

  if (await db.user.findUnique({ where: { username }, select: { id: true } })) {
    throw new ConflictError('username_taken', `The username "${username}" is already in use.`);
  }

  return db.user.create({
    data: { username, passwordHash, role: input.role, mustChangePassword: true },
    select: PUBLIC_USER_SELECT,
  });
}

export async function listUsers(db: Db): Promise<PublicUser[]> {
  return db.user.findMany({ orderBy: { username: 'asc' }, select: PUBLIC_USER_SELECT });
}

export async function getUser(db: Db, id: string): Promise<PublicUser> {
  const user = await db.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
  if (!user) throw new NotFoundError('User', id);
  return user;
}

/**
 * Loads the target and refuses if the actor may not touch it. Every mutating
 * path below goes through this, so Super Admin immunity is enforced in exactly
 * one place.
 */
async function loadModifiableUser(db: Db, actorRole: UserRole, id: string): Promise<PublicUser> {
  const target = await getUser(db, id);
  if (!canModifyUser(actorRole, target.role)) {
    throw new ConflictError(
      'forbidden',
      target.role === 'super_admin'
        ? 'Only a Super Admin can modify the Super Admin.'
        : 'You do not have permission to modify this user.',
    );
  }
  return target;
}

/**
 * `| undefined` is explicit because `exactOptionalPropertyTypes` is on: a parsed
 * request body has the keys present and set to undefined, which a bare optional
 * would reject.
 */
export interface UpdateUserInput {
  readonly username?: string | undefined;
  readonly role?: UserRole | undefined;
}

export async function updateUser(
  db: Db,
  actorRole: UserRole,
  id: string,
  input: UpdateUserInput,
): Promise<PublicUser> {
  const target = await loadModifiableUser(db, actorRole, id);

  // Promoting someone to Super Admin is itself a Super Admin action, or an Admin
  // could grant themselves immunity through a proxy account.
  if (input.role !== undefined && !canModifyUser(actorRole, input.role)) {
    throw new ConflictError('forbidden', 'Only a Super Admin can grant the Super Admin role.');
  }

  const data: { username?: string; role?: UserRole } = {};

  if (input.username !== undefined) {
    const username = normalizeUsername(input.username);
    assertUsernameAcceptable(username);
    const clash = await db.user.findUnique({ where: { username }, select: { id: true } });
    if (clash && clash.id !== id) {
      throw new ConflictError('username_taken', `The username "${username}" is already in use.`);
    }
    data.username = username;
  }
  if (input.role !== undefined) data.role = input.role;

  /**
   * A changed role drops that user's sessions.
   *
   * Guards re-read the role on every request, so a demotion already bites
   * immediately — but the session id itself was minted while the account held
   * different privileges, and a privilege boundary is exactly where a session
   * identifier should not survive. Signing in again is a small price on an
   * action that happens about once.
   */
  if (data.role !== undefined && data.role !== target.role) {
    await db.session.deleteMany({ where: { userId: id } });
  }

  return db.user.update({ where: { id }, data, select: PUBLIC_USER_SELECT });
}

/**
 * Issues a new temporary password. Every existing session for that user is
 * dropped, because the common reason to reset a password is that the old one is
 * no longer trusted, and leaving a live session open defeats the reset.
 */
export async function resetPassword(
  db: Db,
  actorRole: UserRole,
  id: string,
  temporaryPassword: string,
): Promise<PublicUser> {
  await loadModifiableUser(db, actorRole, id);
  const passwordHash = await hashPassword(temporaryPassword);

  await db.session.deleteMany({ where: { userId: id } });

  return db.user.update({
    where: { id },
    data: { passwordHash, mustChangePassword: true },
    select: PUBLIC_USER_SELECT,
  });
}

/**
 * Changes a user's own password. Requires the current one, so a session left
 * open on an unlocked machine cannot be used to take the account over.
 */
export async function changeOwnPassword(
  db: Db,
  id: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id }, select: { passwordHash: true } });
  if (!user) throw new NotFoundError('User', id);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new ValidationError('incorrect_password', 'Current password is incorrect.');
  }
  if (currentPassword === newPassword) {
    throw new ValidationError(
      'password_unchanged',
      'The new password must be different from the current one.',
    );
  }

  const passwordHash = await hashPassword(newPassword);
  await db.user.update({ where: { id }, data: { passwordHash, mustChangePassword: false } });

  /*
   * Every other session for this account goes, exactly as `resetPassword` has
   * always done. The asymmetry between the two was the bug: an administrator
   * resetting somebody's password revoked their sessions, but somebody changing
   * their *own* password did not.
   *
   * That is backwards. The commonest reason a person changes their own password
   * is that they think somebody else may have it — and in that case the session
   * that matters is the attacker's, which survived. The route re-establishes the
   * caller's session immediately afterwards, so the person doing this stays
   * signed in and everyone else is thrown out.
   */
  await db.session.deleteMany({ where: { userId: id } });
}

/**
 * Archives a user. Nothing is ever hard-deleted, so their delegation events keep
 * resolving to a real name. Their sessions go immediately — an archived account
 * that stays logged in is not archived in any sense that matters.
 */
export async function archiveUser(
  db: Db,
  actorRole: UserRole,
  actorId: string,
  id: string,
): Promise<PublicUser> {
  if (actorId === id) {
    throw new ConflictError(
      'cannot_archive_self',
      'You cannot archive your own account. Ask another administrator.',
    );
  }

  const target = await loadModifiableUser(db, actorRole, id);
  if (target.archivedAt) return target;

  // The last Super Admin leaving means nobody can ever manage users again.
  if (target.role === 'super_admin') {
    const remaining = await db.user.count({
      where: { role: 'super_admin', archivedAt: null, id: { not: id } },
    });
    if (remaining === 0) {
      throw new ConflictError(
        'last_super_admin',
        'This is the only Super Admin. Promote another account first.',
      );
    }
  }

  await db.session.deleteMany({ where: { userId: id } });
  return db.user.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: PUBLIC_USER_SELECT,
  });
}

export async function restoreUser(db: Db, actorRole: UserRole, id: string): Promise<PublicUser> {
  await loadModifiableUser(db, actorRole, id);
  return db.user.update({ where: { id }, data: { archivedAt: null }, select: PUBLIC_USER_SELECT });
}

/**
 * Verifies a username and password.
 *
 * Returns null for every failure — unknown user, wrong password, archived
 * account — and says nothing about which. Distinguishing them tells an attacker
 * which usernames are real.
 */
export async function authenticate(
  db: Db,
  rawUsername: string,
  password: string,
): Promise<PublicUser | null> {
  const username = normalizeUsername(rawUsername);
  const user = await db.user.findUnique({
    where: { username },
    select: { ...PUBLIC_USER_SELECT, passwordHash: true },
  });

  if (!user) {
    // Spend the same time a real verification costs; see verifyAgainstDummyHash.
    await verifyAgainstDummyHash(password);
    return null;
  }

  const correct = await verifyPassword(user.passwordHash, password);
  if (!correct || user.archivedAt) return null;

  // Strip the hash by omission, so a future column added to the select cannot
  // leak by default.
  const { passwordHash, ...publicUser } = user;
  return publicUser;
}

export async function recordLogin(db: Db, id: string): Promise<void> {
  await db.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
}
