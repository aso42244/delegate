import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  clearCheck,
  listOutstandingChecks,
  proposeCheckMatches,
  voidCheck,
  writeCheck,
  type OutstandingCheck,
} from '../domain/checks.js';
import { centsIn, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Outstanding checks.
 *
 * Every write is wrapped in one database transaction here rather than in the
 * domain, matching the rest of the API. It matters more than usual for these: a
 * check line without its transfer would show a line holding nothing while the
 * envelope still shows money that is already committed.
 */

const writeSchema = z.object({
  checkNumber: z.string().min(1).max(32),
  amountCents: centsIn,
  issuedAt: z.coerce.date(),
  memo: z.string().max(200).optional(),
  sourceDelegationId: z.string().uuid(),
});

function present(check: OutstandingCheck): Record<string, unknown> {
  return {
    id: check.id,
    checkNumber: check.checkNumber,
    memo: check.memo,
    issuedAt: dateOut(check.issuedAt),
    balanceCents: centsOut(check.balanceCents),
    sourceDelegationId: check.sourceDelegationId,
    sourceName: check.sourceName,
  };
}

export const checkRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/checks', async () => ({
    checks: (await listOutstandingChecks(prisma)).map(present),
  }));

  /*
   * Checks the bank appears to have cashed, computed on demand and never stored.
   *
   * Registered before `/api/checks/:id`-shaped routes would be a concern if any
   * existed on GET; there are none, and `matches` is a literal segment either
   * way. It writes nothing: confirming is `POST /api/checks/:id/match`.
   */
  fastify.get('/api/checks/matches', async () => ({
    matches: (await proposeCheckMatches(prisma)).map((match) => ({
      checkId: match.checkId,
      checkNumber: match.checkNumber,
      memo: match.memo,
      checkBalanceCents: centsOut(match.checkBalanceCents),
      sourceName: match.sourceName,
      transactionId: match.transactionId,
      description: match.description,
      amountCents: centsOut(match.amountCents),
      postedAt: dateOut(match.postedAt),
      accountName: match.accountName,
    })),
  }));

  fastify.post('/api/checks', async (request, reply) => {
    const body = writeSchema.parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    const check = await prisma.$transaction((tx) =>
      writeCheck(tx, {
        checkNumber: body.checkNumber,
        amountCents: body.amountCents,
        issuedAt: body.issuedAt,
        memo: body.memo ?? null,
        sourceDelegationId: body.sourceDelegationId,
        actorId,
      }),
    );

    request.log.info({ actorId, checkNumber: check.checkNumber }, 'outstanding check written');
    return reply.code(201).send({ check: present(check) });
  });

  /** The check will never be cashed. The money goes back where it came from. */
  fastify.post('/api/checks/:id/void', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actorId = request.currentUser?.id ?? null;

    await prisma.$transaction((tx) => voidCheck(tx, id, { actorId }));

    request.log.info({ actorId, checkId: id }, 'outstanding check voided');
    return { ok: true };
  });

  /**
   * Settles a check against the payment that cashed it.
   *
   * The only thing that settles one, and only a person calls it — from the
   * purple banner's confirmation, or by hand from the Transactions page when the
   * bank's description never named the check number. A sync proposes; it does
   * not settle. See ADR 030.
   */
  fastify.post('/api/checks/:id/match', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { transactionId } = z.object({ transactionId: z.string().uuid() }).parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    const result = await prisma.$transaction((tx) =>
      clearCheck(tx, id, transactionId, { actorId }),
    );

    request.log.info({ actorId, checkId: id, transactionId }, 'outstanding check matched');
    return { ...result, differenceCents: centsOut(result.differenceCents) };
  });

  done();
};
