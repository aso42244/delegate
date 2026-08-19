import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  MAX_TOKEN_NAME_LENGTH,
  type ApiTokenSummary,
} from '../domain/api-tokens.js';
import { AUTHENTICATED, requireSettingsManagement } from '../plugins/auth.js';
import { dateOut } from '../http/serialize.js';

/**
 * Managing the credentials programs use.
 *
 * Administrator-only, for the same reason settings writes are: a token is a way
 * into the budget that does not expire when a browser closes, and issuing one
 * is a decision about the household rather than a personal preference.
 *
 * None of these routes appears in the token allowlist, so a token can never
 * mint another token or revoke the one that is being used to hunt for it.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  name: z.string().min(1).max(MAX_TOKEN_NAME_LENGTH),
  scope: z.enum(['read', 'read_write']),
  /**
   * Null is "never expires", and has to be said rather than defaulted to.
   * Ten years is the ceiling because a longer one is indistinguishable from
   * never while looking like a limit.
   */
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
});

interface TokenView {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly username: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

function present(token: ApiTokenSummary): TokenView {
  return {
    id: token.id,
    name: token.name,
    scope: token.scope,
    username: token.username,
    createdAt: dateOut(token.createdAt),
    lastUsedAt: dateOut(token.lastUsedAt),
    expiresAt: dateOut(token.expiresAt),
    revokedAt: dateOut(token.revokedAt),
  };
}

/**
 * The connector bundle, built at image build time and shipped inside it.
 *
 * Resolved from this module rather than from the working directory: the
 * container starts in `/app`, `npm run dev` starts in `apps/api`, and a path
 * that only works in one of them is a download button that is broken in
 * development and nobody notices.
 *
 * Four levels up from either `dist/routes/` or `src/routes/` is the repository
 * root, which is the same shape in both.
 */
const CONNECTOR_PATH = fileURLToPath(
  new URL('../../../../apps/mcp/delegate.mcpb', import.meta.url),
);

export const apiTokenRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of [...AUTHENTICATED, requireSettingsManagement]) {
    fastify.addHook('preHandler', guard);
  }

  /**
   * The Claude Desktop connector, as a file to drag into it.
   *
   * This exists so the whole path — issue a key, install the connector, tell it
   * where the budget is — happens in two interfaces the owner already has open,
   * and never in a terminal. The bundle carries no credential of its own; Claude
   * Desktop asks for the key in a form and keeps it.
   *
   * Not in the token allowlist, deliberately. There is nothing secret in here,
   * but a program that can hand out an installer is a program that can hand out
   * an installer.
   */
  fastify.get('/api/connector', async (request, reply) => {
    let bundle: Buffer;
    try {
      bundle = await readFile(CONNECTOR_PATH);
    } catch {
      request.log.error({ path: CONNECTOR_PATH }, 'the connector bundle is not on disk');
      return reply.code(404).send({
        error: {
          code: 'connector_unavailable',
          message:
            'The connector was not built into this deployment. Run scripts/build-connector.mjs, or upgrade to a release that ships it.',
        },
      });
    }

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', 'attachment; filename="delegate.mcpb"')
      .send(bundle);
  });

  fastify.get('/api/api-tokens', async () => ({
    tokens: (await listApiTokens(prisma)).map(present),
  }));

  fastify.post('/api/api-tokens', async (request, reply) => {
    const input = createSchema.parse(request.body);
    const actor = request.currentUser!;

    const { token, secret } = await createApiToken(prisma, {
      userId: actor.id,
      name: input.name,
      scope: input.scope,
      expiresInDays: input.expiresInDays,
    });

    request.log.info(
      { actorId: actor.id, tokenId: token.id, scope: token.scope },
      'API token created',
    );

    // The one and only time the secret leaves this process. It is not stored in
    // a form anything here can reverse, so a lost token is replaced, not read.
    return reply.code(201).send({ token: present(token), secret });
  });

  fastify.post('/api/api-tokens/:id/revoke', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const actor = request.currentUser!;

    await revokeApiToken(prisma, id);
    request.log.info({ actorId: actor.id, tokenId: id }, 'API token revoked');

    return { tokens: (await listApiTokens(prisma)).map(present) };
  });

  done();
};
