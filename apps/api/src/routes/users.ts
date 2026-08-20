import { USER_ROLES } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { MAX_PASSWORD_LENGTH } from '../domain/passwords.js';
import {
  archiveUser,
  createUser,
  listUsers,
  resetPassword,
  resetTwoFactor,
  restoreUser,
  updateUser,
  MAX_DISPLAY_NAME_LENGTH,
} from '../domain/users.js';
import { USER_MANAGEMENT } from '../plugins/auth.js';

/**
 * User administration. Every route here requires the user-management
 * capability; Super Admin immunity is enforced in the domain layer so it cannot
 * be forgotten at a route.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const displayNameSchema = z.string().max(MAX_DISPLAY_NAME_LENGTH).nullable();

const createUserSchema = z.object({
  username: z.string().min(1).max(254),
  displayName: displayNameSchema.optional(),
  temporaryPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  role: z.enum(USER_ROLES).default('user'),
});

const updateUserSchema = z
  .object({
    username: z.string().min(1).max(254).optional(),
    displayName: displayNameSchema.optional(),
    role: z.enum(USER_ROLES).optional(),
  })
  .refine(
    (value) =>
      value.username !== undefined || value.role !== undefined || value.displayName !== undefined,
    { message: 'Provide something to change.' },
  );

const resetPasswordSchema = z.object({
  temporaryPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const userRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  // Registered on the plugin scope rather than per route, so a route added here
  // later cannot miss the capability check. Fastify halts the chain as soon as a
  // hook sends a reply, so a failed guard stops the ones after it.
  for (const guard of USER_MANAGEMENT) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/users', async () => ({ users: await listUsers(prisma) }));

  fastify.post('/api/users', async (request, reply) => {
    const input = createUserSchema.parse(request.body);
    const actor = request.currentUser!;
    const user = await createUser(prisma, actor.role, input);

    request.log.info(
      { actorId: actor.id, createdUserId: user.id, role: user.role },
      'user created',
    );
    return reply.code(201).send({ user });
  });

  fastify.patch('/api/users/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateUserSchema.parse(request.body);
    const actor = request.currentUser!;

    const user = await updateUser(prisma, actor.role, id, input);
    request.log.info({ actorId: actor.id, targetUserId: id }, 'user updated');
    return { user };
  });

  /**
   * Clears somebody's second factor so they can enrol again.
   *
   * The way back when the phone is gone and the recovery codes went with it.
   * Sign-in demands the second factor whenever one is confirmed, and nothing
   * anywhere changes that — so before this existed, the only route was a
   * database prompt. Now that a second factor is required of every account,
   * the household needs a way to undo one that has become unusable.
   */
  fastify.post('/api/users/:id/reset-two-factor', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = request.currentUser!;

    const user = await resetTwoFactor(prisma, actor.role, id);
    request.log.warn({ actorId: actor.id, targetUserId: id }, 'second factor reset');
    return { user };
  });

  fastify.post('/api/users/:id/reset-password', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { temporaryPassword } = resetPasswordSchema.parse(request.body);
    const actor = request.currentUser!;

    const user = await resetPassword(prisma, actor.role, id, temporaryPassword);
    request.log.info({ actorId: actor.id, targetUserId: id }, 'password reset');
    return { user };
  });

  fastify.post('/api/users/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = request.currentUser!;

    const user = await archiveUser(prisma, actor.role, actor.id, id);
    request.log.info({ actorId: actor.id, targetUserId: id }, 'user archived');
    return { user };
  });

  fastify.post('/api/users/:id/restore', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = request.currentUser!;

    const user = await restoreUser(prisma, actor.role, id);
    request.log.info({ actorId: actor.id, targetUserId: id }, 'user restored');
    return { user };
  });

  done();
};
