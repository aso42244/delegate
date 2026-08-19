import type { ApiTokenScope } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../db/client.js';
import { authenticateApiToken, touchApiToken } from '../domain/api-tokens.js';

/**
 * Bearer-token authentication, and the allowlist that bounds it.
 *
 * A token is not a smaller session. A session belongs to somebody sitting in
 * front of the budget who can see what they just did and undo it; a token
 * belongs to a program, and in this case that program is being driven by a
 * language model reading text somebody else wrote. The blast radius has to be
 * decided here rather than left to whatever the model decides to call.
 *
 * So the rule is an **allowlist of route patterns**, not a rule about methods.
 * "Read scope means GET" sounds equivalent and is not: `GET /api/settings`
 * returns the onion address, and `GET /api/users` returns the household. Both
 * are safe for a browser and neither belongs in a chat transcript.
 *
 * Matching is on `request.routeOptions.url` — the pattern Fastify registered,
 * not the path the caller sent. That distinction is the whole security
 * property: there is no string to normalise, no traversal to defend against,
 * and a request that matched no route has no pattern and is therefore refused.
 */

/** The authenticated token attached to a request, when there is one. */
export interface RequestApiToken {
  readonly id: string;
  readonly scope: ApiTokenScope;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiToken: RequestApiToken | null;
  }
}

/**
 * What any token may read.
 *
 * Deliberately shorter than "every GET". Each entry is here because a tool
 * needs it, and adding one is a decision about what may leave the house.
 */
export const TOKEN_READ_ROUTES: readonly string[] = [
  'GET /health',
  'GET /api/app',
  'GET /api/budget',
  'GET /api/budget/delegate/preview',
  'GET /api/delegations/:id/history',
  'GET /api/transactions',
  'GET /api/accounts',
  'GET /api/accounts/:id/valuations',
  'GET /api/accounts/:id/equity',
  'GET /api/insights',
  'GET /api/insights/series',
  'GET /api/rules',
  'GET /api/rules/preview',
  'GET /api/bitcoin',
  'GET /api/bitcoin/holdings/:id/events',
  'GET /api/properties',
  'GET /api/checks',
  'GET /api/utilities',
  'GET /api/notifications',
  'GET /api/archived',
  'GET /api/sync/status',
];

/**
 * What a `read_write` token may additionally do.
 *
 * The line is reversibility by a person who did not expect the change. Every
 * entry either sorts a transaction into an envelope or edits the rules that do
 * it automatically, and every one of them can be put back from the UI in a few
 * clicks.
 *
 * What is *not* here matters more than what is:
 *
 *   * Nothing that moves money. Delegate runs, transfers, manual adjustments
 *     and reconciliation all write to the event ledger, and undoing one is a
 *     ledger operation rather than an edit.
 *   * Nothing that archives. The row menu says Archive rather than Delete
 *     because archiving is the destructive option here.
 *   * Not `POST /api/rules/apply`. Creating a rule is inert until it is
 *     applied; applying one rewrites categorizations across the whole history,
 *     including ones made by hand. Those are different sizes of mistake and
 *     they get different answers.
 *   * Nothing under settings, users, sync or Bitcoin. A token cannot turn off
 *     two-factor, cannot open remote access, and cannot touch a wallet.
 */
export const TOKEN_WRITE_ROUTES: readonly string[] = [
  'PATCH /api/transactions/:id',
  'POST /api/transactions/:id/categorize',
  'POST /api/transactions/:id/uncategorize',
  'POST /api/transactions/bulk-categorize',
  'POST /api/rules',
  'PATCH /api/rules/:id',
  'POST /api/rules/:id/archive',
  'POST /api/rules/reorder',
  'POST /api/rules/from-transaction',
];

const READ_SET = new Set(TOKEN_READ_ROUTES);
const WRITE_SET = new Set(TOKEN_WRITE_ROUTES);

/** The routes a given scope may reach, as `METHOD /pattern`. */
export function routesForScope(scope: ApiTokenScope): Set<string> {
  return scope === 'read_write' ? new Set([...READ_SET, ...WRITE_SET]) : new Set(READ_SET);
}

/**
 * Pulls the credential off the request.
 *
 * `Bearer` is matched case-insensitively because the scheme is
 * case-insensitive in RFC 7235, and clients disagree about it.
 */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;

  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify-plugin's signature
const apiTokenPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('apiToken', null);

  /**
   * Runs ahead of every route guard, so `requireSession` finds the user
   * already resolved and needs to know nothing about tokens.
   *
   * A *present but bad* token is refused here rather than falling through to
   * the cookie path. Falling through would answer a revoked token with the
   * response for an anonymous request, which reads as "this endpoint needs a
   * login" when the truth is "this credential is dead".
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const presented = bearerToken(request);
    if (!presented) return;

    const authenticated = await authenticateApiToken(prisma, presented);
    if (!authenticated) {
      request.log.warn({ url: request.url }, 'API token rejected');
      await reply.code(401).send({
        error: { code: 'invalid_token', message: 'That API token is not valid.' },
      });
      return;
    }

    request.currentUser = authenticated.user;
    request.apiToken = { id: authenticated.tokenId, scope: authenticated.scope };

    // Bookkeeping, and never a reason to fail a request that authenticated.
    try {
      await touchApiToken(prisma, authenticated);
    } catch (error) {
      request.log.warn({ err: error }, 'could not record API token use');
    }
  });

  /** The allowlist. Second hook, so it always sees a resolved token. */
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.apiToken) return;

    const pattern = request.routeOptions.url;
    const key = pattern ? `${request.method.toUpperCase()} ${pattern}` : null;

    if (key && routesForScope(request.apiToken.scope).has(key)) return;

    request.log.warn(
      { tokenId: request.apiToken.id, scope: request.apiToken.scope, route: key },
      'API token refused a route outside its scope',
    );

    await reply.code(403).send({
      error: {
        code: 'token_scope',
        message:
          request.apiToken.scope === 'read'
            ? 'This token is read-only.'
            : 'API tokens cannot reach this part of the budget.',
      },
    });
  });
};

export const apiToken = fp(apiTokenPlugin, { name: 'api-token' });
