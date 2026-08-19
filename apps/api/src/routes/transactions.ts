import { TRANSACTION_KINDS } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  categorizeTransaction,
  clearAllocations,
  setAllocations,
  splitTransactionEvenly,
} from '../domain/allocations.js';
import { ValidationError } from '../domain/errors.js';
import {
  archiveTransaction,
  createManualTransaction,
  listTransactions,
  MAX_PAGE_SIZE,
  updateTransaction,
  DEFAULT_PAGE_SIZE,
} from '../domain/transactions.js';
import { confirmPair, findPairCandidates, unpair } from '../domain/pairing.js';
import { booleanQuery, centsInLoose, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The Transactions page.
 *
 * Categorization here is the highest-traffic interaction in the application
 * after the Budget page, so the shapes are built for a keyboard-driven queue:
 * filter to uncategorized, assign, move on.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  accountId: z.string().uuid().optional(),
  delegationId: z.string().uuid().optional(),
  kind: z.enum(TRANSACTION_KINDS).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  uncategorized: booleanQuery.optional(),
  pending: booleanQuery.optional(),
  includeArchived: booleanQuery.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const createBodySchema = z.object({
  accountId: z.string().uuid(),
  amountCents: centsInLoose,
  description: z.string().min(1).max(500),
  postedAt: z.coerce.date(),
  kind: z.enum(TRANSACTION_KINDS).default('normal'),
});

const updateBodySchema = z.object({
  description: z.string().min(1).max(500).optional(),
  postedAt: z.coerce.date().optional(),
  kind: z.enum(TRANSACTION_KINDS).optional(),
});

/** One delegation, or several explicit allocations for a split. */
const categorizeBodySchema = z.union([
  z.object({ delegationId: z.string().uuid() }),
  z.object({
    allocations: z
      .array(z.object({ delegationId: z.string().uuid(), amountCents: centsInLoose }))
      .min(1),
  }),
  z.object({ delegationIds: z.array(z.string().uuid()).min(2) }),
]);

const bulkCategorizeBodySchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(500),
  delegationId: z.string().uuid(),
});

type TransactionRow = Awaited<ReturnType<typeof listTransactions>>['transactions'][number];

function present(transaction: TransactionRow): Record<string, unknown> {
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    postedAt: dateOut(transaction.postedAt),
    amountCents: centsOut(transaction.amountCents),
    description: transaction.description,
    descriptionRaw: transaction.descriptionRaw,
    pending: transaction.pending,
    kind: transaction.kind,
    archivedAt: dateOut(transaction.archivedAt),
    pairedTransactionId: transaction.pairedTransactionId,
    account: {
      id: transaction.account.id,
      // The short name where one exists. The register is the other place a full
      // bank name pushes everything else off the row.
      name: transaction.account.nickname ?? transaction.account.name,
      type: transaction.account.type,
    },
    allocations: transaction.allocations.map((allocation) => ({
      id: allocation.id,
      delegationId: allocation.delegationId,
      amountCents: centsOut(allocation.amountCents),
      delegation: allocation.delegation,
    })),
  };
}

export const transactionRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/transactions', async (request) => {
    const query = listQuerySchema.parse(request.query ?? {});
    const { transactions, total } = await listTransactions(prisma, query);

    return {
      transactions: transactions.map(present),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  fastify.post('/api/transactions', async (request, reply) => {
    const body = createBodySchema.parse(request.body);
    const created = await createManualTransaction(prisma, body);

    request.log.info(
      { transactionId: created.id, actorId: request.currentUser?.id },
      'manual transaction created',
    );
    return reply.code(201).send({ transaction: { id: created.id } });
  });

  fastify.patch('/api/transactions/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = updateBodySchema.parse(request.body);

    await updateTransaction(prisma, id, body);
    return { ok: true };
  });

  fastify.post('/api/transactions/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    await archiveTransaction(prisma, id);
    request.log.info(
      { transactionId: id, actorId: request.currentUser?.id },
      'transaction archived',
    );
    return { ok: true };
  });

  /**
   * Assigns a transaction. Three shapes, because the UI has three gestures:
   * pick one delegation, split evenly across several, or set exact amounts.
   */
  fastify.post('/api/transactions/:id/categorize', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = categorizeBodySchema.parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    if ('delegationId' in body) {
      const result = await categorizeTransaction(prisma, id, body.delegationId, { actorId });
      return { allocationCount: result.allocationCount };
    }

    if ('delegationIds' in body) {
      const result = await splitTransactionEvenly(prisma, id, body.delegationIds, { actorId });
      return { allocationCount: result.allocationCount };
    }

    // Explicit amounts. setAllocations rejects a set that does not sum to the
    // transaction, so a split can never quietly lose or invent a cent.
    const result = await setAllocations(prisma, id, body.allocations, { actorId });
    return { allocationCount: result.allocationCount };
  });

  fastify.post('/api/transactions/:id/uncategorize', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    const result = await clearAllocations(prisma, id);
    return { reversedEventCount: result.reversedEventCount };
  });

  /**
   * Bulk categorize: select rows, assign them all to one envelope.
   *
   * Applied one at a time rather than as a single statement, because each needs
   * its own allocation and ledger event written atomically. A row that cannot be
   * categorized — an archived one, or income — is reported rather than failing
   * the whole batch, so one bad row in a selection of fifty is not a dead end.
   */
  fastify.post('/api/transactions/bulk-categorize', async (request) => {
    const body = bulkCategorizeBodySchema.parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    let categorized = 0;
    const failures: { transactionId: string; reason: string }[] = [];

    for (const transactionId of body.transactionIds) {
      try {
        await categorizeTransaction(prisma, transactionId, body.delegationId, { actorId });
        categorized += 1;
      } catch (error) {
        failures.push({
          transactionId,
          reason: error instanceof ValidationError ? error.message : 'Could not be categorized',
        });
      }
    }

    request.log.info(
      { categorized, failed: failures.length, actorId },
      'bulk categorization applied',
    );
    return { categorized, failures };
  });

  // --- Pairing -----------------------------------------------------------
  //
  // A credit card payment and a mortgage payment each produce two transactions
  // that are not spending. §7: suggested and confirmed, never applied silently —
  // wrong automatic pairing is worse than no pairing.

  fastify.get('/api/transactions/pair-candidates', async () => {
    const candidates = await findPairCandidates(prisma);

    const side = (entry: (typeof candidates)[number]['outflow']): Record<string, unknown> => ({
      id: entry.id,
      accountId: entry.accountId,
      accountName: entry.accountName,
      postedAt: dateOut(entry.postedAt),
      amountCents: centsOut(entry.amountCents),
      description: entry.description,
    });

    return {
      candidates: candidates.map((candidate) => ({
        outflow: side(candidate.outflow),
        inflow: side(candidate.inflow),
        daysApart: candidate.daysApart,
      })),
    };
  });

  fastify.post('/api/transactions/pair', async (request) => {
    const body = z
      .object({ firstId: z.string().uuid(), secondId: z.string().uuid() })
      .parse(request.body);

    await confirmPair(prisma, body.firstId, body.secondId);

    request.log.info(
      { firstId: body.firstId, secondId: body.secondId, actorId: request.currentUser?.id },
      'transactions paired',
    );
    return { ok: true };
  });

  fastify.post('/api/transactions/:id/unpair', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    await unpair(prisma, id);
    request.log.info(
      { transactionId: id, actorId: request.currentUser?.id },
      'transactions unpaired',
    );
    return { ok: true };
  });

  done();
};
