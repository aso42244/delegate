import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { canManageSettings, canManageUsers, type UserRole } from '@budget/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { getBudgetSettings } from '../domain/settings.js';
import { PrismaSessionStore } from './session-store.js';

/**
 * Session cookies and the request guards built on them.
 *
 * Passwords, a second factor, rate limiting and CSRF are all in place, and a
 * second factor is required of every account. Passkeys are deliberately out of
 * scope (ADR 016). How this is reached from outside the house is the operator's
 * decision — see ADR 027 for the onion service, and ADR 017 for why plain http
 * is still the default at the origin.
 */

/** The authenticated user attached to a request by `requireSession`. */
export interface RequestUser {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly mustChangePassword: boolean;
  /** Whether a confirmed second factor exists — see `requireTwoFactor`. */
  readonly hasTotp: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: RequestUser | null;
  }
  interface Session {
    userId?: string;
  }
}

const authPlugin: FastifyPluginAsync<{ config: AppConfig }> = async (fastify, options) => {
  const { config } = options;

  await fastify.register(fastifyCookie);
  await fastify.register(fastifySession, {
    secret: config.SESSION_SECRET,
    store: new PrismaSessionStore(prisma, config.SESSION_TTL_SECONDS),
    // Anonymous visitors get no database row. The sessions table requires a
    // user_id, and writing a row per unauthenticated request would be both a
    // constraint violation and a slow denial-of-service target.
    saveUninitialized: false,
    // Each request pushes the expiry out, so an active session does not expire
    // mid-use while an abandoned one still ages out.
    rolling: true,
    cookieName: 'budget_session',
    cookie: {
      httpOnly: true,
      // Must stay false until TLS lands in Phase 3: browsers never send a Secure
      // cookie over plain http, so enabling it early breaks login silently.
      secure: config.SESSION_COOKIE_SECURE,
      // 'lax' still sends the cookie on top-level navigation, so a bookmark to
      // the budget works, while cross-site form posts do not carry it.
      sameSite: 'lax',
      path: '/',
      maxAge: config.SESSION_TTL_SECONDS * 1000,
    },
  });

  // `null` rather than undefined so the property always exists on the shape
  // V8 sees, and route code can test it without an optional chain.
  fastify.decorateRequest('currentUser', null);
};

export const auth = fp(authPlugin, { name: 'auth' });

/**
 * Rejects the request unless it carries a live session for a usable account.
 *
 * Re-reads the user on every request rather than trusting what login wrote into
 * the session: a role change or an archival must take effect immediately, not
 * whenever the cookie happens to expire.
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = request.session.userId;
  if (!userId) {
    await reply.code(401).send({ error: { code: 'unauthenticated', message: 'Please sign in.' } });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      role: true,
      mustChangePassword: true,
      archivedAt: true,
      totpConfirmedAt: true,
    },
  });

  if (!user || user.archivedAt) {
    await request.session.destroy();
    await reply
      .code(401)
      .send({ error: { code: 'unauthenticated', message: 'This account is no longer active.' } });
    return;
  }

  request.currentUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    hasTotp: user.totpConfirmedAt !== null,
  };
}

/**
 * Blocks everything except enrolling once the budget requires a second factor
 * and this account has not set one up.
 *
 * The settings row is only read when the user is *not* enrolled, so the ordinary
 * request pays nothing for this. Like `requirePasswordChanged`, the routes that
 * resolve the state — the enrolment pair, and logout — deliberately skip it.
 */
export async function requireTwoFactor(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.currentUser || request.currentUser.hasTotp) return;

  const { requireTotp } = await getBudgetSettings(prisma);
  if (!requireTotp) return;

  await reply.code(403).send({
    error: {
      code: 'two_factor_required',
      message: 'Set up two-factor authentication before continuing.',
    },
  });
}

/**
 * Blocks everything except changing the password while a temporary one is in
 * force. Applied after `requireSession`; the change-password and logout routes
 * deliberately do not use it, or a new user could never get out of the state.
 */
export async function requirePasswordChanged(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.currentUser?.mustChangePassword) {
    await reply.code(403).send({
      error: {
        code: 'password_change_required',
        message: 'Set a new password before continuing.',
      },
    });
  }
}

/** The entire permission model: only user management is gated. */
export async function requireUserManagement(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const role = request.currentUser?.role;
  if (!role || !canManageUsers(role)) {
    await reply.code(403).send({
      error: { code: 'forbidden', message: 'Only an administrator can manage users.' },
    });
  }
}

/**
 * The guard chain every authenticated route wants: a live session, and a
 * password that is no longer temporary.
 */
/**
 * Household-wide settings, which decide who gets in at all — see
 * `canManageSettings`. Applied per route rather than to the whole module,
 * because reading them is for everyone and changing them is not.
 */
export async function requireSettingsManagement(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.currentUser && canManageSettings(request.currentUser.role)) return;

  await reply.code(403).send({
    error: {
      code: 'settings_management_required',
      message: 'Only an administrator can change these.',
    },
  });
}

export const AUTHENTICATED = [requireSession, requirePasswordChanged, requireTwoFactor] as const;

/** As above, plus the user-management capability. */
export const USER_MANAGEMENT = [
  requireSession,
  requirePasswordChanged,
  requireTwoFactor,
  requireUserManagement,
] as const;
