import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { canManageSettings, canManageUsers, type LandingPage, type UserRole } from '@budget/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AppConfig } from '../config.js';
import { prisma } from '../db/client.js';
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
  /** What to call them on screen. Null falls back to the username. */
  readonly displayName: string | null;
  /** Where they land. Null is "never chose", which is not the same as the default. */
  readonly landingPage: LandingPage | null;
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
    store: new PrismaSessionStore(
      prisma,
      config.SESSION_TTL_SECONDS,
      config.SESSION_ABSOLUTE_TTL_SECONDS,
    ),
    // Anonymous visitors get no database row. The sessions table requires a
    // user_id, and writing a row per unauthenticated request would be both a
    // constraint violation and a slow denial-of-service target.
    saveUninitialized: false,
    // Each request pushes the expiry out, so an active session does not expire
    // mid-use while an abandoned one still ages out.
    rolling: true,
    // Configurable so a demo instance on the same host as a real one does not
    // write a cookie the real one's browser also sends — see the note in config.
    cookieName: config.SESSION_COOKIE_NAME,
    cookie: {
      httpOnly: true,
      // Plain http is the origin's permanent default (ADR 017): browsers never
      // send a Secure cookie over plain http, so enabling this without real TLS
      // in front breaks login silently.
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
  /*
   * A demo instance has one account and everybody arriving is it.
   *
   * There is no sign-in on a demo: the data is invented, the instance is
   * read-only, and whoever is looking at it was let through by whatever sits in
   * front. Asking them to hold credentials for a fictional household would be
   * asking them to do something for no reason.
   *
   * No session row is written, deliberately. Attaching the user directly keeps
   * this a read all the way down, and keeps the demo from accumulating a session
   * per visitor for accounts that do not exist.
   *
   * The guard is the configuration flag, which a real deployment never sets and
   * a test asserts is off by default — the cost of that being wrong is a
   * household's own budget answering to anybody.
   */
  if (request.server.config.DELEGATE_DEMO) {
    const only = await prisma.user.findFirst({
      where: { archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, username: true, displayName: true, landingPage: true, role: true },
    });
    if (!only) {
      await reply
        .code(503)
        .send({ error: { code: 'demo_not_seeded', message: 'The demo has no data yet.' } });
      return;
    }
    request.currentUser = {
      ...only,
      mustChangePassword: false,
      // Nothing to enrol: there is no account to protect and no way in to gate.
      hasTotp: true,
    };
    return;
  }

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
      displayName: true,
      landingPage: true,
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
    displayName: user.displayName,
    landingPage: user.landingPage,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    hasTotp: user.totpConfirmedAt !== null,
  };
}

/**
 * Blocks everything except enrolling until this account has a second factor.
 *
 * Unconditional. It used to consult a `requireTotp` setting, which never did
 * what its name suggested: sign-in demands the second factor whenever an
 * account has one confirmed, whatever the setting said — so it could not
 * rescue anybody locked out, and its only real effect was to permit accounts
 * with no second factor at all.
 *
 * Like `requirePasswordChanged`, the routes that resolve the state — the
 * enrolment pair, and logout — deliberately skip this, or an un-enrolled
 * account could never reach the screen that enrols it.
 */
export async function requireTwoFactor(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.currentUser || request.currentUser.hasTotp) return;

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
