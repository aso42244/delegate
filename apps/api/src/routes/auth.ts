import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { MAX_PASSWORD_LENGTH } from '../domain/passwords.js';
import {
  authenticate,
  changeOwnPassword,
  createFirstUser,
  needsFirstRunSetup,
  recordLogin,
  type PublicUser,
} from '../domain/users.js';
import { requireSession, type RequestUser } from '../plugins/auth.js';
import { authRateLimit } from '../plugins/security.js';
import { pruneExpiredSessions } from '../plugins/session-store.js';

/** Sign-in, sign-out, and first-run setup. */

const credentialsSchema = z.object({
  username: z.string().min(1).max(254),
  // Bounded before argon2 sees it: hashing an unbounded string on an
  // unauthenticated route is a denial-of-service vector.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

function presentUser(user: PublicUser | RequestUser): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export const authRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  // Built at registration from configuration rather than a constant, so the
  // limit can be raised for a test suite that signs in hundreds of times.
  const rateLimit = authRateLimit(fastify.config);
  /**
   * Tells the login screen whether to offer sign-in or first-run setup. Public
   * by necessity — it is what an unauthenticated browser asks first — and it
   * reveals only whether any account exists.
   */
  fastify.get('/api/auth/setup-state', async () => ({
    needsSetup: await needsFirstRunSetup(prisma),
  }));

  /** Creates the first account, which becomes Super Admin, and signs it in. */
  // Throttled: this is the route that mints the Super Admin, and before the
  // first account exists it is unauthenticated by necessity.
  fastify.post('/api/auth/setup', { config: { rateLimit } }, async (request, reply) => {
    const { username, password } = credentialsSchema.parse(request.body);
    const user = await createFirstUser(prisma, { username, password });

    await request.session.regenerate();
    request.session.userId = user.id;
    await recordLogin(prisma, user.id);

    request.log.info({ userId: user.id }, 'first-run super admin created');
    return reply.code(201).send({ user: presentUser(user) });
  });

  /**
   * The route the rate limit exists for. Nothing else throttled password
   * guessing beyond the ~50 ms an argon2id hash costs — ADR 007 names that as
   * the strongest reason this application must not leave the LAN.
   */
  fastify.post('/api/auth/login', { config: { rateLimit } }, async (request, reply) => {
    const { username, password } = credentialsSchema.parse(request.body);
    const user = await authenticate(prisma, username, password);

    if (!user) {
      // One message for every failure — unknown user, wrong password, archived
      // account. Anything more specific enumerates valid usernames.
      request.log.warn({ username }, 'failed login');
      return reply.code(401).send({
        error: { code: 'invalid_credentials', message: 'Incorrect username or password.' },
      });
    }

    // Regenerate before storing the user: reusing the pre-login session id would
    // let anyone who could set that cookie ride the session once it is elevated.
    await request.session.regenerate();
    request.session.userId = user.id;
    await recordLogin(prisma, user.id);

    // Expired rows are also dropped when a stale cookie is presented, but a
    // session nobody ever comes back to would otherwise sit in the table
    // forever. Login is the natural moment to sweep, and the table is tiny.
    const pruned = await pruneExpiredSessions(prisma);
    if (pruned > 0) request.log.debug({ pruned }, 'expired sessions removed');

    request.log.info({ userId: user.id }, 'login');
    return reply.send({ user: presentUser(user) });
  });

  /**
   * Signing out destroys the stored session rather than only clearing the
   * cookie, so a copied cookie cannot be replayed. No session is not an error.
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    if (request.session.userId) {
      request.log.info({ userId: request.session.userId }, 'logout');
    }
    await request.session.destroy();
    return reply.code(204).send();
  });

  /**
   * Only `requireSession`, deliberately: a user with a temporary password must
   * still be able to see who they are in order to render the change-password
   * screen.
   */
  fastify.get('/api/auth/me', { preHandler: [requireSession] }, (request) => {
    return { user: presentUser(request.currentUser!) };
  });

  /**
   * Also skips `requirePasswordChanged` — it is the one route that must work
   * while a temporary password is in force, or a new account is stuck forever.
   */
  fastify.post(
    '/api/auth/change-password',
    // Verifies the current password, so it is a guessing surface too.
    { preHandler: [requireSession], config: { rateLimit } },
    async (request, reply) => {
      const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);
      const user = request.currentUser!;

      await changeOwnPassword(prisma, user.id, currentPassword, newPassword);

      // A password change is a privilege change: rotate the session id so any
      // session captured under the old password is worthless.
      await request.session.regenerate();
      request.session.userId = user.id;

      request.log.info({ userId: user.id }, 'password changed');
      return reply.code(204).send();
    },
  );

  done();
};
