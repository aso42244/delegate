import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { buildUtilitySummaries } from '../domain/utilities.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The Utilities page: what each utility averages, and what that is per paycheck.
 * Suggestion only — nothing here writes an amount to delegate.
 */
export const utilityRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/utilities', async () => {
    const summaries = await buildUtilitySummaries(prisma);

    return {
      utilities: summaries.map((summary) => ({
        delegationId: summary.delegationId,
        name: summary.name,
        groupingName: summary.groupingName,
        groupingColor: summary.groupingColor,
        amountToDelegateCents: centsOut(summary.amountToDelegateCents),
        averageCents: centsOut(summary.averageCents),
        suggestedPerCycleCents: centsOut(summary.suggestedPerCycleCents),
        months: summary.months.map((month) => ({
          month: dateOut(month.month),
          spendCents: centsOut(month.spendCents),
          complete: month.complete,
        })),
      })),
    };
  });

  done();
};
