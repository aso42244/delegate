import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  issueApiToken,
  listApiTokens,
  MAX_API_TOKEN_NAME_LENGTH,
  revokeApiToken,
  type ApiTokenView,
} from '../domain/api-tokens.js';
import { recordAuthEvent } from '../domain/auth-events.js';
import { dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Where a person manages their own API tokens (ADR 071).
 *
 * Session-authenticated, like every other settings write — a bearer token
 * cannot reach these routes, so a token cannot mint or revoke tokens. And
 * everything here is scoped to the signed-in account inside the domain
 * functions rather than by a role check: a token speaks as one person, so its
 * owner is the only person with any business listing or revoking it.
 *
 * Both writes are recorded in the credential log (ADR 041). A machine
 * credential being issued is precisely the line somebody reading that card
 * wants to see.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  name: z.string().min(1).max(MAX_API_TOKEN_NAME_LENGTH),
});

function present(token: ApiTokenView): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    createdAt: dateOut(token.createdAt),
    lastUsedAt: dateOut(token.lastUsedAt),
    lastUsedFrom: token.lastUsedFrom,
    revokedAt: dateOut(token.revokedAt),
  };
}

export const apiTokenRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/api-tokens', async (request) => ({
    tokens: (await listApiTokens(prisma, request.currentUser!.id)).map(present),
  }));

  /**
   * Issues one and returns the secret — the only time it is ever sent.
   *
   * The response is the one place the secret exists in the clear, so it is not
   * logged: the body is not, and `secret` is not a field Fastify's redaction
   * needs to know about because nothing here logs the reply.
   */
  fastify.post('/api/api-tokens', async (request, reply) => {
    const { name } = createSchema.parse(request.body);
    const user = request.currentUser!;
    const { token, secret } = await issueApiToken(prisma, user.id, name);

    request.log.info({ userId: user.id, tokenId: token.id }, 'api token issued');
    await recordAuthEvent(
      prisma,
      { kind: 'api_token_created', subject: user.username, userId: user.id, ip: request.ip },
      request.log,
    );
    return reply.code(201).send({ token: present(token), secret });
  });

  fastify.post('/api/api-tokens/:id/revoke', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const user = request.currentUser!;
    const token = await revokeApiToken(prisma, user.id, id);

    request.log.info({ userId: user.id, tokenId: token.id }, 'api token revoked');
    await recordAuthEvent(
      prisma,
      { kind: 'api_token_revoked', subject: user.username, userId: user.id, ip: request.ip },
      request.log,
    );
    return { token: present(token) };
  });

  done();
};
