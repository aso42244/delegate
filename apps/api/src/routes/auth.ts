import type { UserRole } from '@budget/shared';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { verifyPassword } from '../domain/passwords.js';
import { ValidationError } from '../domain/errors.js';
import { MAX_PASSWORD_LENGTH } from '../domain/passwords.js';
import {
  authenticate,
  changeOwnPassword,
  createFirstUser,
  needsFirstRunSetup,
  recordLogin,
  setOwnDisplayName,
  MAX_DISPLAY_NAME_LENGTH,
} from '../domain/users.js';
import { claimChallenge, issueChallenge, readChallenge } from '../domain/challenge.js';
import {
  beginEnrolment,
  confirmEnrolment,
  disableTotp,
  totpStatus,
  verifySecondFactor,
  type SecondFactorResult,
} from '../domain/totp.js';
import { requireSession } from '../plugins/auth.js';
import { authRateLimit } from '../plugins/security.js';
import { pruneAuthEvents, recordAuthEvent } from '../domain/auth-events.js';
import { describeAttemptedUsername } from '../domain/auth-subject.js';
import { readSetupToken, setupTokenAccepted } from '../domain/setup-token.js';
import { pruneExpiredSessions } from '../plugins/session-store.js';

/** Sign-in, sign-out, and first-run setup. */

/**
 * The password, asked for again on an action a stolen session must not be able
 * to take on its own.
 */
const stepUpSchema = z.object({ currentPassword: z.string().min(1).max(200) });

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

/** Structurally typed rather than by class, so a narrow `select` also fits. */
interface PresentableUser {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string | null | undefined;
  readonly role: UserRole;
  readonly mustChangePassword: boolean;
}

function presentUser(user: PresentableUser): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    // Null where none is set; the interface falls back to the username.
    displayName: user.displayName ?? null,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

/**
 * The address to record against an event, as the server resolved it.
 *
 * `request.ip` already honours `TRUST_PROXY`, so this is the client behind a
 * Cloudflare Tunnel when one is configured and the connecting socket otherwise
 * — which is exactly the value the rate limiter buckets on, and the reason not
 * to read the header here directly.
 */
function addressOf(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Everything that turns an accepted credential into a session, in one place so
 * the password path and the second-factor path cannot drift apart.
 */
async function establishSession(
  request: FastifyRequest,
  _reply: FastifyReply,
  user: { id: string },
): Promise<void> {
  // Regenerate before storing the user: reusing the pre-login session id would
  // let anyone who could set that cookie ride the session once it is elevated.
  await request.session.regenerate();
  request.session.userId = user.id;
  await recordLogin(prisma, user.id);

  // Expired rows are also dropped when a stale cookie is presented, but a
  // session nobody ever comes back to would otherwise sit in the table forever.
  // Signing in is the natural moment to sweep, and the table is tiny.
  const pruned = await pruneExpiredSessions(
    prisma,
    request.server.config.SESSION_ABSOLUTE_TTL_SECONDS,
  );
  if (pruned > 0) request.log.debug({ pruned }, 'expired sessions removed');

  // The audit log is swept on the same beat, and for the same reason: this is
  // the moment there is something worth removing, and it keeps the one table an
  // unauthenticated stranger can cause writes to from growing without bound.
  const forgotten = await pruneAuthEvents(prisma);
  if (forgotten > 0) request.log.debug({ forgotten }, 'expired auth events removed');
}

export const authRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  /** Re-verifies the password. Same failure whatever the reason, as elsewhere. */
  async function assertPassword(userId: string, password: string): Promise<void> {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!row || !(await verifyPassword(row.passwordHash, password))) {
      throw new ValidationError('incorrect_password', 'Current password is incorrect.');
    }
  }

  // Built at registration from configuration rather than a constant, so the
  // limit can be raised for a test suite that signs in hundreds of times.
  const rateLimit = authRateLimit(fastify.config);
  /**
   * Tells the login screen whether to offer sign-in or first-run setup. Public
   * by necessity — it is what an unauthenticated browser asks first — and it
   * reveals only whether any account exists.
   */
  fastify.get('/api/auth/setup-state', async () => {
    const needsSetup = await needsFirstRunSetup(prisma);
    return {
      needsSetup,
      // Whether the screen should ask for the code at all. Says nothing about
      // what the code is, and nothing that is not already obvious from the
      // deployment refusing setup without one.
      needsSetupToken: needsSetup && readSetupToken() !== null,
    };
  });

  /**
   * Creates the first account, which becomes Super Admin, and signs it in.
   *
   * Throttled, because before the first account exists this is unauthenticated
   * by necessity — and gated on a token that can only be read from the machine
   * running Delegate, because "unauthenticated" used to be safe only on the
   * assumption that reaching the address meant being in the house. A deploy that
   * can land on any address gives that assumption up.
   */
  fastify.post('/api/auth/setup', { config: { rateLimit } }, async (request, reply) => {
    const { username, password, setupToken } = credentialsSchema
      .extend({ setupToken: z.string().max(200).optional() })
      .parse(request.body);

    if (!setupTokenAccepted((setupToken ?? '').trim().toUpperCase(), readSetupToken())) {
      request.log.warn({ ip: request.ip }, 'first-run setup refused: wrong token');
      return reply.code(403).send({
        error: {
          code: 'setup_token_invalid',
          message:
            "That setup code is not right. It is printed in this server's logs — run `docker compose logs app` on the machine running Delegate.",
        },
      });
    }

    const user = await createFirstUser(prisma, { username, password });

    await request.session.regenerate();
    request.session.userId = user.id;
    await recordLogin(prisma, user.id);

    request.log.info({ userId: user.id }, 'first-run super admin created');
    await recordAuthEvent(
      prisma,
      {
        kind: 'account_created',
        subject: user.username,
        userId: user.id,
        ip: addressOf(request),
      },
      request.log,
    );
    return reply.code(201).send({ user: presentUser(user) });
  });

  /**
   * The route the rate limit exists for. Nothing else throttled password
   * guessing beyond the ~50 ms an argon2id hash costs — ADR 007 names that as
   * the strongest reason a password alone was never enough here. A second
   * factor is required of every account now, and this limit still matters:
   * it is what keeps a guessing loop from being free.
   */
  fastify.post('/api/auth/login', { config: { rateLimit } }, async (request, reply) => {
    const { username, password } = credentialsSchema.parse(request.body);
    const { user, usernameKnown } = await authenticate(prisma, username, password);

    if (!user) {
      // One message for every failure — unknown user, wrong password, archived
      // account. Anything more specific enumerates valid usernames, and
      // `usernameKnown` is used only to decide what is safe to write down.
      const subject = describeAttemptedUsername(
        username,
        usernameKnown,
        fastify.config.SESSION_SECRET,
      );
      request.log.warn({ subject }, 'failed login');
      await recordAuthEvent(
        prisma,
        { kind: 'sign_in_failed', subject, ip: addressOf(request) },
        request.log,
      );
      return reply.code(401).send({
        error: { code: 'invalid_credentials', message: 'Incorrect username or password.' },
      });
    }

    /**
     * A correct password is not yet a sign-in when a second factor exists. No
     * session is established here — the challenge below proves only that this
     * server accepted a password moments ago, and is accepted by exactly one
     * route.
     */
    const enrolled = await prisma.user.findUnique({
      where: { id: user.id },
      select: { totpConfirmedAt: true },
    });

    if (enrolled?.totpConfirmedAt) {
      request.log.info({ userId: user.id }, 'password accepted, second factor required');
      return reply.send({
        secondFactorRequired: true,
        challenge: issueChallenge(user.id, fastify.config.SESSION_SECRET),
      });
    }

    await establishSession(request, reply, user);
    await recordAuthEvent(
      prisma,
      { kind: 'signed_in', subject: user.username, userId: user.id, ip: addressOf(request) },
      request.log,
    );
    return reply.send({ user: presentUser(user) });
  });

  /**
   * The second half of a sign-in. Accepts an authenticator code or an unused
   * recovery code, and is rate limited exactly like the password route — six
   * digits is a far smaller space to guess than a passphrase.
   */
  fastify.post('/api/auth/second-factor', { config: { rateLimit } }, async (request, reply) => {
    const { challenge, code } = z
      .object({ challenge: z.string().min(1), code: z.string().min(1).max(64) })
      .parse(request.body);

    const userId = readChallenge(challenge, fastify.config.SESSION_SECRET);

    // Re-read rather than trusting the challenge: the account may have been
    // archived in the minutes since the password was accepted, and a challenge
    // is not a session — nothing else would notice.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, role: true, mustChangePassword: true, archivedAt: true },
    });

    const result: SecondFactorResult =
      user !== null && user.archivedAt === null
        ? await verifySecondFactor(prisma, userId, code, fastify.config.dataKey)
        : 'invalid';

    if (user === null || result !== 'accepted') {
      request.log.warn({ userId, result }, 'failed second factor');
      /*
       * A code that was correct but already spent is told apart from one that
       * was wrong, because the two need different words. "Not correct" sends
       * somebody to check six digits they are reading correctly, and they will
       * retype them until the period rolls over — which is the confusion the
       * replay defence was always going to create the first time somebody
       * enrolled and signed in within the same ninety seconds.
       *
       * It leaks nothing. Reaching this line means already holding the password
       * and a live challenge for this account.
       */
      await recordAuthEvent(
        prisma,
        {
          kind: 'second_factor_failed',
          // The account is known here — a challenge only exists because its
          // password was accepted moments ago — so the name is safe to store.
          subject: user?.username ?? 'unknown',
          userId: user?.id ?? null,
          ip: addressOf(request),
        },
        request.log,
      );
      return reply.code(401).send(
        result === 'spent'
          ? {
              error: {
                code: 'code_already_used',
                message:
                  'That code has already been used. Wait for your authenticator to show the next one.',
              },
            }
          : { error: { code: 'invalid_code', message: 'That code is not correct.' } },
      );
    }

    /*
     * Spent on success, not on arrival.
     *
     * Spending it before checking the code would mean a typo in six digits costs
     * the password as well — and buys almost nothing, because the rate limit
     * already caps a stolen challenge at ten guesses against a million
     * possibilities. What is worth preventing is the same challenge being used
     * *again after it worked*, which is what this does.
     *
     * Between the check and the claim, a second request holding the same
     * challenge could pass the check too — and then lose the insert, which is
     * exactly the right outcome and the reason the unique index does this rather
     * than a read.
     */
    if (!(await claimChallenge(prisma, challenge, fastify.config.SESSION_SECRET))) {
      request.log.warn({ userId }, 'second-factor challenge replayed after a successful use');
      return reply.code(401).send({
        error: {
          code: 'challenge_spent',
          message: 'That sign-in attempt has already been used. Enter your password again.',
        },
      });
    }

    await establishSession(request, reply, user);
    request.log.info({ userId }, 'second factor accepted');
    await recordAuthEvent(
      prisma,
      { kind: 'signed_in', subject: user.username, userId: user.id, ip: addressOf(request) },
      request.log,
    );
    return reply.send({ user: presentUser(user) });
  });

  /**
   * Signing out destroys the stored session rather than only clearing the
   * cookie, so a copied cookie cannot be replayed. No session is not an error.
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    const userId = request.session.userId;
    if (userId) {
      request.log.info({ userId }, 'logout');
      // Read before the session is destroyed, and recorded after — the username
      // is what the screen shows, and it is gone from the request once the
      // session is.
      const who = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      await request.session.destroy();
      await recordAuthEvent(
        prisma,
        {
          kind: 'signed_out',
          subject: who?.username ?? 'unknown',
          userId,
          ip: addressOf(request),
        },
        request.log,
      );
      return reply.code(204).send();
    }

    await request.session.destroy();
    return reply.code(204).send();
  });

  /**
   * Only `requireSession`, deliberately: a user with a temporary password must
   * still be able to see who they are in order to render the change-password
   * screen.
   */
  /**
   * Deliberately outside `requireTwoFactor`, like logout and the enrolment pair.
   *
   * With the requirement on and no second factor enrolled, every other route
   * answers 403 — so if this one did too, the interface would have no way to
   * learn *why* it was locked out, and would read it as signed out. It reports
   * the state instead, and the client routes to enrolment.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- a route handler's signature
  fastify.get('/api/auth/me', { preHandler: [requireSession] }, async (request) => {
    const user = request.currentUser!;

    return {
      user: {
        ...presentUser(user),
        // A second factor is required of everyone, so this is simply "has not
        // set one up yet". Enrolment is the one screen such an account reaches.
        needsTwoFactor: !user.hasTotp,
      },
    };
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
      await recordAuthEvent(
        prisma,
        {
          kind: 'password_changed',
          subject: user.username,
          userId: user.id,
          ip: addressOf(request),
        },
        request.log,
      );
      return reply.code(204).send();
    },
  );

  // --- Two-factor ---------------------------------------------------------

  /**
   * Your own display name.
   *
   * Deliberately outside user management: what you are called is yours to set,
   * whatever role you hold. It is not a credential and nothing is looked up by
   * it, so there is no privilege here to protect.
   */
  fastify.patch('/api/auth/me', { preHandler: [requireSession] }, async (request) => {
    const { displayName } = z
      .object({ displayName: z.string().max(MAX_DISPLAY_NAME_LENGTH).nullable() })
      .parse(request.body);

    const user = await setOwnDisplayName(prisma, request.currentUser!.id, displayName);
    return { user };
  });

  fastify.get('/api/auth/totp', { preHandler: [requireSession] }, async (request) => {
    const status = await totpStatus(prisma, request.currentUser!.id);
    // Always. Kept in the response so the interface does not have to hard-code
    // a fact about the server.
    return { ...status, required: true };
  });

  /**
   * Starts enrolment. The secret is stored unconfirmed — a secret that gated
   * sign-in the moment it was generated would lock out anyone who closed the
   * tab before scanning it.
   *
   * The current password is required, and turning it off already required one.
   * Binding an authenticator was the asymmetry: somebody holding a stolen
   * session on an account with no second factor could enrol *their own* phone,
   * and from then on hold a credential the owner never issued. Asking for the
   * password makes a stolen session insufficient on its own.
   */
  fastify.post(
    '/api/auth/totp/begin',
    { preHandler: [requireSession], config: { rateLimit } },
    async (request) => {
      const { currentPassword } = stepUpSchema.parse(request.body);
      await assertPassword(request.currentUser!.id, currentPassword);

      const offer = await beginEnrolment(
        prisma,
        request.currentUser!.id,
        fastify.config.dataKey,
        fastify.config.APP_NAME,
      );
      return offer;
    },
  );

  /** Confirms enrolment and returns the recovery codes — once, and never again. */
  fastify.post(
    '/api/auth/totp/confirm',
    { preHandler: [requireSession], config: { rateLimit } },
    async (request) => {
      const { code } = z.object({ code: z.string().min(1).max(64) }).parse(request.body);
      const result = await confirmEnrolment(
        prisma,
        request.currentUser!.id,
        code,
        fastify.config.dataKey,
      );

      request.log.info({ userId: request.currentUser!.id }, 'two-factor enrolled');
      await recordAuthEvent(
        prisma,
        {
          kind: 'two_factor_enrolled',
          subject: request.currentUser!.username,
          userId: request.currentUser!.id,
          ip: addressOf(request),
        },
        request.log,
      );
      return result;
    },
  );

  fastify.post(
    '/api/auth/totp/disable',
    { preHandler: [requireSession], config: { rateLimit } },
    async (request) => {
      const { currentPassword } = z
        .object({ currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH) })
        .parse(request.body);

      await disableTotp(prisma, request.currentUser!.id, currentPassword);
      request.log.info({ userId: request.currentUser!.id }, 'two-factor disabled');
      await recordAuthEvent(
        prisma,
        {
          kind: 'two_factor_disabled',
          subject: request.currentUser!.username,
          userId: request.currentUser!.id,
          ip: addressOf(request),
        },
        request.log,
      );
      return { ok: true };
    },
  );

  done();
};
