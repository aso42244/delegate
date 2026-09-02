import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import { findRecurringBills } from '../domain/recurring.js';
import { householdTimezone } from '../domain/settings.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The Bills page.
 *
 * Worked out from the register on every request and stored nowhere: a bill is a
 * merchant whose charges land at a steady interval, and that is a reading of the
 * transactions rather than a second list to maintain.
 */
export const recurringRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/recurring', async () => {
    // "Is this bill late" is a question about the household's today, not the
    // process clock's — ADR 037.
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const bills = await findRecurringBills(prisma, timeZone);

    return {
      bills: bills.map((bill) => ({
        key: bill.key,
        name: bill.name,
        cadence: bill.cadence,
        intervalDays: bill.intervalDays,
        occurrences: bill.occurrences,
        typicalAmountCents: centsOut(bill.typicalAmountCents),
        lastAmountCents: centsOut(bill.lastAmountCents),
        lastPostedAt: dateOut(bill.lastPostedAt),
        expectedNextAt: dateOut(bill.expectedNextAt),
        status: bill.status,
        daysLate: bill.daysLate,
        delegationId: bill.delegationId,
        delegationName: bill.delegationName,
        accountName: bill.accountName,
      })),
    };
  });

  done();
};
