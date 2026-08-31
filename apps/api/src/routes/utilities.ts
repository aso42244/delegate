import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { householdTimezone } from '../domain/settings.js';
import { buildUtilities } from '../domain/utilities.js';
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
    // Which month a bill landed in is the household's question, not UTC's: a
    // payment at eight in the evening on the 31st belongs to the month it was
    // made in. See ADR 037.
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const { summaries, cyclesPerYear } = await buildUtilities(prisma, timeZone);

    return {
      // Sent alongside the figures so the sentence explaining them cannot
      // name a different number than the one they were computed from.
      cyclesPerYear,
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
